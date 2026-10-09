import type { PurchaseOrderResponse, PurchaseOrdersApi } from '@durion-sdk/order';
import { VendorViewStatusEnum, type SupplierVendorsApi, type VendorView } from '@durion-sdk/supplier';
import { isResponseErrorMatching, retryWhileReplicating } from '../support/replicationRetry';

/**
 * The vendor every seeded and integration-test purchase order is raised against.
 *
 * pos-order accepts a purchase order only for an ACTIVE vendor in its copy of
 * pos-supplier's vendor master (backend S24), so the vendor has to be a real
 * pos-supplier record; a made-up id is refused with 503
 * VENDOR_REPLICATION_PENDING forever. The vendorNumber is the stable handle:
 * pos-supplier allocates the vendorId, and the number never changes, so a later
 * run finds the vendor an earlier one created instead of making another.
 */
export const SEED_VENDOR_NUMBER = 'SDK-SEED-MAIN';

const SEED_VENDOR = {
  vendorNumber: SEED_VENDOR_NUMBER,
  legalName: 'Durion SDK Seed Supply LLC',
  displayName: 'SDK Seed Supply',
  defaultPaymentTerms: 'NET30',
  defaultCurrency: 'USD',
};

/** Returns the seed vendor's id, creating the vendor in pos-supplier on first use. */
export async function ensureSeedVendor(vendorsApi: SupplierVendorsApi): Promise<string> {
  const existing = await findSeedVendor(vendorsApi);
  if (existing) {
    return activeVendorId(existing);
  }
  try {
    const created = await vendorsApi.createSupplierVendor({ vendorCreateRequest: SEED_VENDOR });
    console.log(`[Bootstrap] Created seed vendor ${SEED_VENDOR_NUMBER} (${created.vendorId}).`);
    return activeVendorId(created);
  } catch (error) {
    // Another run created it between the lookup and the create.
    if (await isResponseErrorMatching(error, 409, 'SUPPLIER_VENDOR_NUMBER_TAKEN')) {
      const raced = await findSeedVendor(vendorsApi);
      if (raced) {
        return activeVendorId(raced);
      }
    }
    throw error;
  }
}

/**
 * Creates a purchase order, waiting while pos-order's vendor copy catches up.
 *
 * A vendor reaches pos-order through supplier.vendor.updated, so the first
 * order after ensureSeedVendor created the vendor can arrive before the copy
 * does and be refused with 503 VENDOR_REPLICATION_PENDING. A refused create
 * stores nothing, so retrying it cannot duplicate the order.
 */
export function createPurchaseOrderOnceVendorReplicated(
  purchaseOrdersApi: PurchaseOrdersApi,
  request: Parameters<PurchaseOrdersApi['createPurchaseOrder']>[0],
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<PurchaseOrderResponse> {
  return retryWhileReplicating({
    subject: `vendor ${request.createPurchaseOrderRequest.vendorId}`,
    outcome: 'purchase order created',
    isReplicationLag: (error) => isResponseErrorMatching(error, 503, 'VENDOR_REPLICATION_PENDING'),
    attempt: (initOverrides) => purchaseOrdersApi.createPurchaseOrder(request, initOverrides),
    ...options,
  });
}

async function findSeedVendor(vendorsApi: SupplierVendorsApi): Promise<VendorView | undefined> {
  // q is a contains match over number and names, so pick the exact number out.
  const page = await vendorsApi.listSupplierVendors({ q: SEED_VENDOR_NUMBER, size: 200 });
  return page.items?.find((vendor) => vendor.vendorNumber === SEED_VENDOR_NUMBER);
}

function activeVendorId(vendor: VendorView): string {
  if (!vendor.vendorId) {
    throw new Error(`Seed vendor ${SEED_VENDOR_NUMBER} came back without a vendorId`);
  }
  if (vendor.status && vendor.status !== VendorViewStatusEnum.Active) {
    throw new Error(
      `Seed vendor ${SEED_VENDOR_NUMBER} (${vendor.vendorId}) is ${vendor.status}; pos-order refuses purchase orders for it. Reactivate it in pos-supplier.`,
    );
  }
  return vendor.vendorId;
}
