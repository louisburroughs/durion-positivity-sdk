import { randomUUID } from 'crypto';
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
