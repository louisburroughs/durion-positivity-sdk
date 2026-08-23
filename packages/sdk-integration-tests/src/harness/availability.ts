import type { DomainClients } from './personas';

/**
 * Availability readings for a SKU at a location.
 *
 * Alpha is shared and long-lived, so absolute stock levels are unknowable and
 * every assertion in the suites compares a delta against a snapshot taken
 * moments earlier (spec: Suite D). A SKU with no stock at all answers 404
 * rather than zero, which is a legitimate starting point for a product this
 * run just created — hence the null.
 */
export interface AvailabilitySnapshot {
  onHandQty: number;
  atpQty: number;
}

export async function readAvailability(
  as: DomainClients,
  productSku: string,
  locationId: string,
): Promise<AvailabilitySnapshot | null> {
  try {
    const availability = await as.inventory.inventoryAvailabilityApi.getAvailabilityBySku({
      productSku,
      locationId,
    });
    return {
      onHandQty: availability.onHandQuantity,
      atpQty: availability.availableToPromiseQuantity,
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
    if (status === 404) {
      return null;
    }
    throw error;
  }
}

/** On-hand quantity, treating "no record yet" as zero. */
export async function readOnHand(
  as: DomainClients,
  productSku: string,
  locationId: string,
): Promise<number> {
  const snapshot = await readAvailability(as, productSku, locationId);
  return snapshot?.onHandQty ?? 0;
}
