import { createInventoryClient } from '@durion-sdk/inventory';
import { createOrderClient, type PurchaseOrderResponse } from '@durion-sdk/order';
import type { DurionSdkConfig } from '@durion-sdk/transport';

interface InventoryBootstrapResult {
  createdCount: number;
  skippedCount: number;
  created: string[];
  skipped: string[];
}

export const SEED_VENDOR_ID = 'sdk-seeder-vendor-main';
const SEED_CURRENCY = 'USD';

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
      const purchaseOrderPage = await purchaseOrdersApi.listPurchaseOrders({
        filter: {
          vendorId: SEED_VENDOR_ID,
          currency: SEED_CURRENCY,
          locationId,
        },
        pageable: {
          page: 0,
          size: 200,
        },
      });
      existingPurchaseOrders = purchaseOrderPage.content ?? [];
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

        const asn = await asnApi.createAsn({
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

  private buildSeedComment(productEntityId: string): string {
    return `sdk-seeder-bootstrap:${productEntityId}`;
  }
}
