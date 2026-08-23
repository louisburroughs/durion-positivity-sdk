import { createInventoryClient } from '@durion-sdk/inventory';
import { createOrderClient, type PurchaseOrderResponse } from '@durion-sdk/order';
import type { DurionSdkConfig } from '@durion-sdk/transport';
import { isResponseErrorMatching, retryWhileReplicating } from '../support/replicationRetry';

interface InventoryBootstrapResult {
  createdCount: number;
  skippedCount: number;
  created: string[];
  skipped: string[];
}

export const SEED_VENDOR_ID = 'sdk-seeder-vendor-main';
const SEED_CURRENCY = 'USD';
const PURCHASE_ORDER_LOOKUP_TIMEOUT_MS = 15_000;

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
    const { asnApi } = createInventoryClient(this.sdkConfig);
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
        '[Bootstrap] InventoryBootstrap: failed to query existing purchase orders — idempotency check skipped, duplicate POs may be created.',
        error,
      );
    }

    for (const [index, product] of products.entries()) {
      const { id: productEntityId, name: productName } = product;
      const existingPurchaseOrder = existingPurchaseOrders.find(
        (purchaseOrder) => purchaseOrder.comment === this.buildSeedComment(productEntityId),
      );

      if (existingPurchaseOrder) {
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
      const poComment = this.buildSeedComment(productEntityId);

      try {
        const purchaseOrder = await purchaseOrdersApi.createPurchaseOrder({
          createPurchaseOrderRequest: {
            vendorId: SEED_VENDOR_ID,
            poDate: purchaseOrderDate,
            currency: SEED_CURRENCY,
            shipToLocationId: locationId,
            requestedBy: 'sdk-seeder',
            comment: poComment,
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
