import { createInventoryClient } from '@durion-sdk/inventory';
import { SEED_VENDOR_ID } from '../bootstrap/InventoryBootstrap';
import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import { ReferenceCache } from '../support/ReferenceCache';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
};

const readString = (value: unknown, ...keys: string[]): string | undefined => {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
};

const pickMany = <T>(values: T[], minCount: number, maxCount: number): T[] => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  const upperBound = Math.min(maxCount, copy.length);
  const lowerBound = Math.min(minCount, upperBound);
  const count = lowerBound === upperBound
    ? upperBound
    : lowerBound + Math.floor(Math.random() * (upperBound - lowerBound + 1));

  return copy.slice(0, count);
};

export class InventoryMaintenanceSimulator {
  private readonly inventoryClient;

  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
    private readonly refs: ReferenceCache,
  ) {
    this.inventoryClient = createInventoryClient(this.auth.buildSdkConfig('inventory'));
  }

  async runCycleCount(): Promise<void> {
    try {
      const candidates = pickMany(this.refs.productEntityIds, 3, 5);

      if (candidates.length === 0) {
        console.log('[Inventory] Cycle count skipped: no products available.');
        return;
      }

      for (const productId of candidates) {
        // The inventory system stores stock items keyed by SKU, which equals the productEntityId
        const stockItemId = productId;
        const quantityOnHandBefore = 50;
        const costAtTimeOfAdjustment = 100;

        const variance = (Math.floor(Math.random() * 5) + 1) * (Math.random() < 0.5 ? -1 : 1);
        const countedQuantity = Math.max(0, quantityOnHandBefore + variance);

        const adjustment = await this.inventoryClient.cycleCountAdjustmentsApi.createAdjustment({
          createAdjustmentRequest: {
            stockItemId,
            reasonCode: 'CYCLE_COUNT',
            countedQuantity,
            quantityOnHandBefore,
            costAtTimeOfAdjustment,
            createdByUserId: this.refs.employees.manager,
          },
        });

        if (!adjustment.adjustmentId) {
          console.log(`[Inventory] Cycle count create returned no adjustmentId for ${productId}.`);
          continue;
        }

        await this.inventoryClient.cycleCountAdjustmentsApi.approveAdjustment({
          adjustmentId: adjustment.adjustmentId,
          approveAdjustmentRequest: {
            approverUserId: this.refs.employees.manager,
            notes: 'Seeder weekly cycle count',
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Inventory] Cycle count failed: ${message}`);
    }
  }

  async runMonthlyRestock(): Promise<void> {
    try {
      const vendorId = SEED_VENDOR_ID;

      const products = pickMany(this.refs.productEntityIds, 5, 8);
      if (products.length === 0) {
        console.log('[Inventory] Monthly restock skipped: no products available.');
        return;
      }

      const purchaseOrder = await this.inventoryClient.purchaseOrdersApi.createPurchaseOrder({
        createPurchaseOrderRequest: {
          vendorId,
          poDate: new Date(),
          currency: 'USD',
          shipToLocationId: this.refs.locationId,
          requestedBy: this.refs.employees.partsClerk,
          comment: 'Seeder monthly restock',
          lines: products.map((productId, index) => ({
            lineNumber: index + 1,
            skuId: productId,
            description: `Restock ${productId}`,
            quantity: 50,
            unitCostMinor: 1000,
          })),
        },
      });

      if (!purchaseOrder.purchaseOrderId) {
        console.log('[Inventory] Monthly restock skipped: PO response missing purchaseOrderId.');
        return;
      }

      await this.inventoryClient.purchaseOrdersApi.approvePurchaseOrder({
        poId: purchaseOrder.purchaseOrderId,
        approvePurchaseOrderRequest: {
          approvalNotes: 'Seeder monthly restock approval',
        },
      });

      const purchaseOrderLines = purchaseOrder.lines ?? [];
      const asn = await this.inventoryClient.asnApi.createAsn({
        createAsnRequest: {
          vendorId,
          asnReferenceNumber: `ASN-${Date.now()}`,
          relatedPoIds: [purchaseOrder.purchaseOrderId],
          shipDate: new Date(),
          expectedArrivalDate: new Date(),
          lineItems: products.map((productId, index) => {
            const poLine = purchaseOrderLines[index];
            return {
              poId: purchaseOrder.purchaseOrderId!,
              poLineId: readString(poLine, 'poLineId', 'lineId', 'id'),
              sku: productId,
              quantityShipped: 50,
              unitCostMinor: 1000,
            };
          }),
        },
      });

      await sleep(50);

      await this.inventoryClient.asnApi.createGoodsReceipt({
        createGoodsReceiptRequest: {
          poId: purchaseOrder.purchaseOrderId,
          asnId: asn.asnId,
          locationId: this.refs.locationId,
          lines: products.map((productId, index) => {
            const poLine = purchaseOrderLines[index];
            return {
              poLineId: readString(poLine, 'poLineId', 'lineId', 'id'),
              sku: productId,
              quantityReceived: 50,
              unitCostMinor: 1000,
            };
          }),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[Inventory] Monthly restock failed: ${message}`);
    }
  }
}
