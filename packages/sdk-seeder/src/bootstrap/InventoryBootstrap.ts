import { createInventoryClient, type InventoryAvailabilityApi } from '@durion-sdk/inventory';
import {
  createOrderClient,
  PurchaseOrderResponseStatusEnum,
  type PurchaseOrderResponse,
} from '@durion-sdk/order';
import type { DurionSdkConfig } from '@durion-sdk/transport';
import { isResponseErrorMatching, retryWhileReplicating } from '../support/replicationRetry';

interface InventoryBootstrapResult {
  createdCount: number;
  skippedCount: number;
  created: string[];
  skipped: string[];
}

/** Whether a product needs seeding, and the reason when it does not. */
type SeedDecision = { seed: true } | { seed: false; reason: string; warn?: boolean };

/** On-hand and open incoming supply for one SKU at one location. */
interface StockPosition {
  onHandQuantity: number;
  incomingQuantity: number;
}

export const SEED_VENDOR_ID = 'sdk-seeder-vendor-main';
const SEED_CURRENCY = 'USD';
const PURCHASE_ORDER_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * Purchase order statuses that may still put stock in the building. Consulted
 * only by the fallback in `decideWhetherToSeed`, when availability cannot be
 * read.
 *
 * CANCELLED is the status this set exists to exclude: a cancelled order
 * delivers nothing, so it is never evidence that a product is stocked. DRAFT is
 * excluded for the same reason and handled separately below. CLOSED is
 * included: it may or may not have delivered, and in a fallback that runs only
 * when the authoritative answer is missing, not duplicating an order matters
 * more than being exact.
 */
const SUPPLY_BEARING_STATUSES: ReadonlySet<string> = new Set<string>([
  PurchaseOrderResponseStatusEnum.Approved,
  PurchaseOrderResponseStatusEnum.PartiallyReceived,
  PurchaseOrderResponseStatusEnum.FullyReceived,
  PurchaseOrderResponseStatusEnum.Closed,
]);

export class InventoryBootstrap {
  /**
   * Purchase orders live in pos-order (/v1/orders/purchase-orders), not
   * pos-inventory: @durion-sdk/inventory still carries a PurchaseOrdersApi from
   * before the move, but its paths 404 against the gateway. ASNs and goods
   * receipts are still inventory's, so this needs a client for each service.
   */
  constructor(
    private readonly sdkConfig: DurionSdkConfig,
    private readonly orderSdkConfig: DurionSdkConfig,
  ) {}

  async run(
    products: { id: string; name: string }[],
    locationId: string,
    virtualNow: Date,
  ): Promise<InventoryBootstrapResult> {
    const { asnApi, inventoryAvailabilityApi } = createInventoryClient(this.sdkConfig);
    const { purchaseOrdersApi } = createOrderClient(this.orderSdkConfig);

    let createdCount = 0;
    let skippedCount = 0;
    const created: string[] = [];
    const skipped: string[] = [];

    let existingPurchaseOrders: PurchaseOrderResponse[] = [];
    try {
      existingPurchaseOrders = await this.listSeededPurchaseOrders();
    } catch (error) {
      console.warn(
        '[Bootstrap] InventoryBootstrap: failed to query existing purchase orders — the stock check below still decides what is seeded, but DRAFT orders will go unnoticed.',
        error,
      );
    }

    for (const [index, product] of products.entries()) {
      const { id: productEntityId, name: productName } = product;
      const seedComment = this.buildSeedComment(productEntityId);
      const seededPurchaseOrders = existingPurchaseOrders.filter(
        (purchaseOrder) => purchaseOrder.comment === seedComment,
      );

      const decision = await this.decideWhetherToSeed(
        inventoryAvailabilityApi,
        productEntityId,
        locationId,
        seededPurchaseOrders,
      );

      if (!decision.seed) {
        const message = `[Bootstrap] InventoryBootstrap: ${productName} (${productEntityId}) skipped — ${decision.reason}.`;
        if (decision.warn) {
          console.warn(message);
        }
        skipped.push(productName);
        skippedCount += 1;
        continue;
      }

      const quantity = 50 + (index * 5) % 151;
      const unitCostMinor = 900 + index * 37;
      // Anchor seed dates to the backend's virtual timeline rather than fixed
      // calendar dates, so bootstrap data lands inside the simulated year.
      const purchaseOrderDate = new Date(virtualNow);
      const expectedDeliveryDate = new Date(virtualNow.getTime() + 24 * 60 * 60 * 1000);

      try {
        const purchaseOrder = await purchaseOrdersApi.createPurchaseOrder({
          createPurchaseOrderRequest: {
            vendorId: SEED_VENDOR_ID,
            poDate: purchaseOrderDate,
            currency: SEED_CURRENCY,
            shipToLocationId: locationId,
            requestedBy: 'sdk-seeder',
            comment: seedComment,
            expectedDeliveryDate,
            lines: [
              {
                lineNumber: 1,
                skuId: productEntityId,
                description: `Seeder stock load for ${productEntityId}`,
                quantity,
                unitCostMinor,
              },
            ],
          },
        });

        const poId = purchaseOrder.purchaseOrderId;
        if (!poId) {
          console.error(
            `[Bootstrap] InventoryBootstrap: purchase order missing id for ${productEntityId}.`,
          );
          skippedCount += 1;
          continue;
        }

        const poLineId = purchaseOrder.lines?.[0]?.lineId;

        await purchaseOrdersApi.approvePurchaseOrder({
          poId,
          approvePurchaseOrderRequest: {
            approvalNotes: 'Approved by sdk-seeder bootstrap.',
          },
        });

        // The ASN names a purchase order that pos-inventory has not necessarily
        // heard of yet: pos-order owns the aggregate and publishes
        // purchaseorder.updated on order.events.v1, which pos-inventory folds
        // into ext_purchase_order on its next poll. Validation runs against that
        // replica, so an ASN issued straight after approval loses a race it
        // cannot see and fails with INVALID_PO_REFERENCE.
        const asn = await retryWhileReplicating({
          subject: `purchase order ${poId}`,
          outcome: 'ASN created',
          isReplicationLag: (error) =>
            isResponseErrorMatching(error, 400, 'INVALID_PO_REFERENCE'),
          attempt: (initOverrides) =>
            asnApi.createAsn(
              {
                createAsnRequest: {
                  vendorId: SEED_VENDOR_ID,
                  asnReferenceNumber: `ASN-SEED-${poId}`,
                  relatedPoIds: [poId],
                  shipDate: purchaseOrderDate,
                  expectedArrivalDate: expectedDeliveryDate,
                  lineItems: [
                    {
                      poId,
                      poLineId,
                      sku: productEntityId,
                      quantityShipped: quantity,
                      unitOfMeasure: 'EA',
                      unitCostMinor,
                    },
                  ],
                },
              },
              initOverrides,
            ),
        });

        const asnId = asn.asnId;
        if (!asnId) {
          console.error(`[Bootstrap] InventoryBootstrap: ASN missing id for ${productEntityId}.`);
          skippedCount += 1;
          continue;
        }

        await asnApi.createGoodsReceipt({
          createGoodsReceiptRequest: {
            poId,
            asnId,
            locationId,
            lines: [
              {
                poLineId,
                sku: productEntityId,
                quantityReceived: quantity,
                unitCostMinor,
              },
            ],
          },
        });

        created.push(productName);
        createdCount += 1;
      } catch (error) {
        console.error(
          `[Bootstrap] InventoryBootstrap: failed to seed stock for ${productEntityId}.`,
          error,
        );
        skipped.push(productName);
        skippedCount += 1;
      }
    }

    return {
      createdCount,
      skippedCount,
      created,
      skipped,
    };
  }

  /**
   * Whether this product still needs stock seeding.
   *
   * The question the bootstrap has to answer is "does this product have stock",
   * and the answer lives in the availability projection, not in the purchase
   * order list. An order that exists proves only that an order was created
   * once: a CANCELLED one delivers nothing, and so does one whose ASN or goods
   * receipt failed after the order was written. Matching on the seed comment
   * alone therefore skipped products that had never been stocked, and kept
   * skipping them on every later run, because the same stale order satisfied
   * the check forever (issue #14).
   *
   * So availability decides, in two parts:
   *
   *   - `onHandQuantity` — stock that arrived and is in the building.
   *   - `incomingQty` — open expected supply: the open line quantity of
   *     *approved* purchase orders plus any un-received ASN remainder.
   *
   * Counting incoming supply is what keeps a repeat run a no-op. Twenty of the
   * thirty seeded products on alpha sit at APPROVED with nothing received yet;
   * they hold no on-hand stock, but their orders are live and stock is on its
   * way, so re-ordering for them would duplicate what is already in flight. A
   * cancelled order contributes to neither figure, which is exactly the
   * behaviour this fix needs.
   *
   * DRAFT orders are the one case where an order still overrides the stock
   * reading. A draft was never approved, so it delivers nothing and contributes
   * nothing to `incomingQty` — but re-seeding would leave it behind as litter
   * next to the new order. The product is skipped with a warning instead, so
   * the draft gets approved or cancelled by a human rather than accumulating
   * silently.
   *
   * Note that a product whose stock has been fully consumed and whose orders
   * have all been received now re-seeds rather than skipping. That follows from
   * asserting stock instead of orders, and matches what the bootstrap is for:
   * guaranteeing seeded stock exists when a run starts.
   */
  private async decideWhetherToSeed(
    inventoryAvailabilityApi: InventoryAvailabilityApi,
    productEntityId: string,
    locationId: string,
    seededPurchaseOrders: PurchaseOrderResponse[],
  ): Promise<SeedDecision> {
    const draftPurchaseOrder = seededPurchaseOrders.find(
      (purchaseOrder) => purchaseOrder.status === PurchaseOrderResponseStatusEnum.Draft,
    );

    let stock: StockPosition | null;
    try {
      stock = await this.readStockPosition(inventoryAvailabilityApi, productEntityId, locationId);
    } catch (error) {
      // Without the authoritative reading, fall back to the cheap local check:
      // skip when a seeded order could still be bearing supply. That risks
      // leaving a product unstocked, but the opposite guess duplicates orders,
      // which is the failure #13 was raised to stop.
      console.warn(
        `[Bootstrap] InventoryBootstrap: availability lookup failed for ${productEntityId}; falling back to the purchase order check.`,
        error,
      );
      const livePurchaseOrder = seededPurchaseOrders.find((purchaseOrder) =>
        SUPPLY_BEARING_STATUSES.has(purchaseOrder.status),
      );
      if (livePurchaseOrder) {
        return {
          seed: false,
          reason: `stock unverifiable, and seeded purchase order ${livePurchaseOrder.poNumber} is ${livePurchaseOrder.status}`,
          warn: true,
        };
      }
      if (draftPurchaseOrder) {
        return {
          seed: false,
          reason: `stock unverifiable, and seeded purchase order ${draftPurchaseOrder.poNumber} is still DRAFT — approve or cancel it, then re-run`,
          warn: true,
        };
      }
      return { seed: true };
    }

    if (stock.onHandQuantity > 0) {
      return { seed: false, reason: `${stock.onHandQuantity} on hand` };
    }
    if (stock.incomingQuantity > 0) {
      return { seed: false, reason: `${stock.incomingQuantity} incoming on a live order` };
    }
    if (draftPurchaseOrder) {
      return {
        seed: false,
        reason: `no stock, and seeded purchase order ${draftPurchaseOrder.poNumber} is still DRAFT — approve or cancel it, then re-run`,
        warn: true,
      };
    }
    return { seed: true };
  }

  /**
   * On-hand and open incoming supply for a SKU at a location.
   *
   * A SKU with no stock-summary row at all answers 404 rather than zero, which
   * is the normal state for a product that has never been received; it reads as
   * a genuine zero here. Every other failure propagates, so the caller can tell
   * "no stock" from "could not ask".
   */
  private async readStockPosition(
    inventoryAvailabilityApi: InventoryAvailabilityApi,
    productSku: string,
    locationId: string,
  ): Promise<StockPosition> {
    try {
      const availability = await inventoryAvailabilityApi.getAvailabilityBySku({
        productSku,
        locationId,
      });
      return {
        onHandQuantity: availability.onHandQuantity ?? 0,
        incomingQuantity: availability.incomingQty ?? 0,
      };
    } catch (error) {
      const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
      if (status === 404) {
        return { onHandQuantity: 0, incomingQuantity: 0 };
      }
      throw error;
    }
  }

  /**
   * Every purchase order this seeder has created, across all pages.
   *
   * Deliberately not `purchaseOrdersApi.listPurchaseOrders`. That endpoint binds
   * its filter with @ModelAttribute and its page with Spring's Pageable, both of
   * which read flat query parameters (`vendorId=`, `page=`, `size=`); the
   * generated client sends them as objects (`filter[vendorId]=`,
   * `pageable[size]=`), which Spring ignores silently. The call therefore always
   * returned an unfiltered first page of 20 — so the idempotency check below
   * could not see any order past the twentieth and re-created it on every run.
   * Fifty orders exist on alpha for thirty products because of this.
   *
   * The vendor filter is dropped rather than translated: this seeder's
   * SEED_VENDOR_ID is not a UUID, and the endpoint rejects a non-UUID vendorId
   * with a 400. Matching on the seed comment is what actually identifies these
   * orders, and it happens below regardless.
   */
  private async listSeededPurchaseOrders(): Promise<PurchaseOrderResponse[]> {
    const token = this.orderSdkConfig.token ? await this.orderSdkConfig.token() : undefined;
    const pageSize = 100;
    const all: PurchaseOrderResponse[] = [];

    for (let page = 0; ; page += 1) {
      const response = await fetch(
        `${this.orderSdkConfig.baseUrl}/v1/orders/purchase-orders?page=${page}&size=${pageSize}`,
        {
          method: 'GET',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'X-API-Version': '1',
            'X-Correlation-Id': crypto.randomUUID(),
          },
          signal: AbortSignal.timeout(PURCHASE_ORDER_LOOKUP_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        throw new Error(
          `InventoryBootstrap: purchase order lookup failed (${response.status} ${response.statusText})`,
        );
      }

      const body = (await response.json()) as {
        content?: PurchaseOrderResponse[];
        totalPages?: number;
      };
      all.push(...(body.content ?? []));

      const totalPages = typeof body.totalPages === 'number' ? body.totalPages : 1;
      if (page + 1 >= totalPages || (body.content ?? []).length === 0) {
        return all;
      }
    }
  }

  private buildSeedComment(productEntityId: string): string {
    return `sdk-seeder-bootstrap:${productEntityId}`;
  }
}
