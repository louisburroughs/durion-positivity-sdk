import { createInventoryClient, type PurchaseOrderResponse } from '@durion-sdk/inventory';
import type { DurionSdkConfig } from '@durion-sdk/transport';

interface InventoryBootstrapResult {
  createdCount: number;
  skippedCount: number;
}

export const SEED_VENDOR_ID = 'sdk-seeder-vendor-main';
const SEED_CURRENCY = 'USD';

export class InventoryBootstrap {
  constructor(private readonly sdkConfig: DurionSdkConfig) {}

  async run(productEntityIds: string[], locationId: string): Promise<InventoryBootstrapResult> {
    const { asnApi, purchaseOrdersApi } = createInventoryClient(this.sdkConfig);

    let createdCount = 0;
    let skippedCount = 0;

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
      console.error('[Bootstrap] InventoryBootstrap: failed to query existing purchase orders.', error);
    }

    for (const [index, productEntityId] of productEntityIds.entries()) {
      const existingPurchaseOrder = existingPurchaseOrders.find(
        (purchaseOrder) => purchaseOrder.comment === this.buildSeedComment(productEntityId),
      );

      if (existingPurchaseOrder) {
        skippedCount += 1;
        continue;
      }

      const quantity = 50 + (index * 5) % 151;
      const unitCostMinor = 900 + index * 37;
      const purchaseOrderDate = new Date('2024-01-01');
      const expectedDeliveryDate = new Date('2024-01-02');
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
            asnReferenceNumber: `ASN-${index + 1}-${productEntityId}`,
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

        createdCount += 1;
      } catch (error) {
        console.error(
          `[Bootstrap] InventoryBootstrap: failed to seed stock for ${productEntityId}.`,
          error,
        );
        skippedCount += 1;
      }
    }

    return {
      createdCount,
      skippedCount,
    };
  }

  private buildSeedComment(productEntityId: string): string {
    return `sdk-seeder-bootstrap:${productEntityId}`;
  }
}
