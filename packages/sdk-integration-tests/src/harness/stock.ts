import { randomUUID } from 'crypto';
import { createApprovedPo, createAsnForPo, readString, requireField, type BuilderContext } from './builders';
import { call } from './http';
import type { DomainClients } from './personas';

export interface SeedOnHandOptions {
  /**
   * Where the stock lands. This is the ledger's location column verbatim —
   * pos-inventory does not resolve it against the location service — so a
   * storage-location id puts the stock in that bin, which is what cycle count
   * task generation scans.
   */
  locationId: string;
  /** Quantity per SKU. */
  quantity: number;
  /** The stock references to create. Free text: the ledger keys on it as-is. */
  skus: string[];
}

export interface SeededStock {
  skus: string[];
  /** The bulk-ingest rows, in the order their SKUs were requested. */
  adjustmentRequestIds: string[];
}

/**
 * Puts on-hand stock at a location through the same two steps the backend's own
 * seed driver uses: bulk ingest raises one adjustment *request* per row, and
 * approving that request is what posts the inventory ledger entry.
 *
 * The split matters. Bulk ingest alone leaves nothing on hand — the request
 * sits PENDING and no ledger row exists — so a suite that ingests and then
 * reads availability sees zero and blames the wrong thing. It is also why the
 * two calls need different personas in role mode: `inventory:adjustment:create`
 * belongs to the clerk, `inventory:adjustment:approve` does not.
 */
export async function seedOnHand(
  creator: DomainClients,
  approver: DomainClients,
  options: SeedOnHandOptions,
): Promise<SeededStock> {
  const ingested = await call('bulkIngestInventoryAdjustments', () =>
    creator.inventory.inventoryBulkIngestAPIApi.bulkIngestInventoryAdjustments({
      bulkIngestRequestInventoryBulkIngestRecord: {
        jobId: randomUUID(),
        locationId: options.locationId,
        records: options.skus.map((sku) => ({
          sku,
          quantity: options.quantity,
          reasonCode: 'INITIAL_STOCK',
        })),
      },
    }),
  );

  if (ingested.failureCount > 0) {
    const failures = ingested.results
      .filter((result) => !result.success)
      .map((result) => `row ${result.rowIndex}: ${result.errorCode} ${result.errorMessage}`)
      .join('; ');
    throw new Error(
      `Bulk ingest rejected ${ingested.failureCount} of ${ingested.totalSubmitted} row(s) at ` +
        `${options.locationId}: ${failures}`,
    );
  }

  // Bulk ingest reports per row, and the rows come back keyed by the index they
  // were submitted under rather than in order.
  const byRow = new Map(ingested.results.map((result) => [result.rowIndex, result]));
  const adjustmentRequestIds = options.skus.map((sku, index) => {
    const entityId = byRow.get(index)?.entityId;
    if (!entityId) {
      throw new Error(`Bulk ingest returned no adjustment request id for ${sku} (row ${index})`);
    }
    return entityId;
  });

  for (const adjustmentRequestId of adjustmentRequestIds) {
    await call('approveAdjustmentRequest', () =>
      approver.inventory.stockMovementsApi.approveAdjustmentRequest({ adjustmentRequestId }),
    );
  }

  return { skus: [...options.skus], adjustmentRequestIds };
}

export interface PricedReceiptOptions {
  /** Where the receipt lands: a location the receiving persona's scope names directly. */
  locationId: string;
  vendorId: string;
  /** Catalog product ids, which are the stock references pos-inventory keys on. */
  skus: string[];
  /** Quantity per SKU. */
  quantity: number;
  /** Document unit cost per SKU, in minor units of the order currency (USD). */
  unitCostMinor: number;
}

export interface PricedReceipt {
  purchaseOrderId: string;
  asnId: string;
  receiptId: string;
}

/**
 * Puts costed stock on hand the way a shop gets it: an approved purchase order,
 * an ASN and a priced goods receipt.
 *
 * Since durion-positivity-backend#2203 each GOODS_RECEIPT row carries the line's
 * unit cost, so under AVERAGE a never-costed SKU takes the receipt cost as its
 * average, and every variance, adjustment and scrap after it posts at that cost.
 * Contrast `seedOnHand`, whose bulk-ingest stock carries no cost: a SKU only ever
 * seeded that way is uncosted on purpose.
 *
 * The purchase order is the parts clerk's and its approval the manager's, the
 * seeded separation of duties `createApprovedPo` already follows.
 */
export async function receivePriced(
  parts: DomainClients,
  manager: DomainClients,
  ctx: BuilderContext,
  options: PricedReceiptOptions,
): Promise<PricedReceipt> {
  const po = await createApprovedPo(
    parts,
    manager,
    ctx,
    options.vendorId,
    options.skus.map((skuId) => ({ skuId, quantity: options.quantity, unitCostMinor: options.unitCostMinor })),
  );
  const asnId = await createAsnForPo(parts, ctx, options.vendorId, po);
  const receipt = await call('createGoodsReceipt', () =>
    parts.inventory.asnApi.createGoodsReceipt({
      createGoodsReceiptRequest: {
        poId: po.purchaseOrderId,
        asnId,
        locationId: options.locationId,
        lines: po.lines.map((line) => ({
          poLineId: line.poLineId,
          sku: line.skuId,
          quantityReceived: options.quantity,
          unitCostMinor: line.unitCostMinor,
        })),
      },
    }),
  );
  return {
    purchaseOrderId: po.purchaseOrderId,
    asnId,
    receiptId: requireField(readString(receipt, 'receiptId', 'id'), 'receiptId'),
  };
}
