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

/**
 * A bootstrap product with at least `minimumQuantity` on hand at the location.
 *
 * Only the products whose seeded purchase orders were actually received carry
 * stock - ten of thirty on alpha at the time of writing - and a workorder for an
 * unstocked part never gets a pick list at all, since there is nothing to
 * allocate. Tests that need picking have to start from a part that exists in the
 * building rather than from whichever product happens to be first.
 */
export async function findStockedProduct(
  as: DomainClients,
  productEntityIds: string[],
  locationId: string,
  minimumQuantity: number,
): Promise<{ productEntityId: string; onHandQty: number }> {
  for (const productEntityId of productEntityIds) {
    const snapshot = await readAvailability(as, productEntityId, locationId);
    if (snapshot && snapshot.atpQty >= minimumQuantity) {
      return { productEntityId, onHandQty: snapshot.onHandQty };
    }
  }
  throw new Error(
    `No bootstrap product has ${minimumQuantity} available at ${locationId}. ` +
      'Seeded stock is a bootstrap concern: run the seeder, or check that its purchase orders were received.',
  );
}
