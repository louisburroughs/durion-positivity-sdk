import type { Operation, Risk } from './types';

/**
 * Packages whose every mutation reaches past the tenant under test: pos-tenant
 * is the platform's tenant registry, and the bulk loader ingests whole files
 * of reference data.
 */
const DESTRUCTIVE_PACKAGES: ReadonlySet<string> = new Set(['tenant', 'bulk-loader']);

/** Method names that take something away, lock someone out, or cannot be undone. */
const DESTRUCTIVE_NAME =
  /(delete|remove|purge|disable|deactivate|revoke|terminate|suspend|decommission|anonymi[sz]e|erase|wipe|offboard|archive|bulkIngest|rotate(Key|Secret)|resetPassword|expireUser)/i;

/**
 * Operations that are ordinary writes by shape but not by consequence on a
 * shared tenant: they send messages to real addresses, mint credentials for
 * other identities, or lock the books so that every later posting fails.
 */
const DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set([
  'dispatchCampaign',
  'scheduleCampaign',
  'resumeCampaign',
  'mintImpersonationToken',
  'mintAdministratorActivationToken',
  'issueInternalToken',
  'closeAccountingPeriod',
  'reopenAccountingPeriod',
  'setAccountingHardLockDate',
  'enableRetreadPlantAddOn',
  'reconcileRoleTemplate',
  'replayShopManagerOutbox',
]);

/**
 * Everyday shop work that happens to be a DELETE or to carry a destructive-
 * sounding name. Giving a bay or a technician back, taking a line off a cart
 * or an estimate: a day of business cannot be replayed without them, and each
 * undoes only something the same workflow just did.
 */
const ROUTINE_OPERATIONS: ReadonlySet<string> = new Set([
  'releaseServicePosition',
  'releaseTechnician',
  'removeCartItem',
  'clearOrderDiscount',
  'deleteEstimateItem',
]);

/**
 * Anonymous endpoints that create tenants or send mail to an address in the
 * request. They are rate-limited per client IP at the gateway, and a harness
 * that trips those limits locks real users out of signup and recovery.
 */
const DESTRUCTIVE_PATH = /(\/auth\/register-tenant|\/auth\/password-reset|\/auth\/username-reminder|\/bulk-ingest)/i;

/** POSTs that only compute or look up. They change nothing, so they count as reads. */
const READ_ONLY_POST_PATH =
  /\/(search|query|lookup|calculate|preview|validate|duplicate-check|render|simulate|estimate-tax|quote|resolve|check)$/i;

export function classifyRisk(operation: Pick<Operation, 'pkg' | 'method' | 'http' | 'path'>): Risk {
  if (operation.http === 'GET' || operation.http === 'HEAD' || operation.http === 'OPTIONS') {
    return 'read';
  }
  if (ROUTINE_OPERATIONS.has(operation.method) && !DESTRUCTIVE_PACKAGES.has(operation.pkg)) {
    return 'write';
  }
  if (
    operation.http === 'DELETE' ||
    DESTRUCTIVE_PACKAGES.has(operation.pkg) ||
    DESTRUCTIVE_NAME.test(operation.method) ||
    DESTRUCTIVE_OPERATIONS.has(operation.method) ||
    DESTRUCTIVE_PATH.test(operation.path)
  ) {
    return 'destructive';
  }
  if (operation.http === 'POST' && READ_ONLY_POST_PATH.test(operation.path)) {
    return 'read';
  }
  return 'write';
}
