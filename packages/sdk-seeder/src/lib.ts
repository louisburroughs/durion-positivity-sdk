/**
 * Library barrel for the seeder's reusable fixtures.
 *
 * `index.ts` is the executable entrypoint (it starts the seeder run on
 * import) — external consumers such as the integration test harness must
 * import from this barrel instead. The package's `main`/`types` fields and
 * the root jest moduleNameMapper both point here.
 */
export { SeederAuth } from './SeederAuth';
export { SeederConfig, type SeederConfigShape, type SeederConfigValues } from './SeederConfig';
export { SecurityBootstrap } from './bootstrap/SecurityBootstrap';
export { BootstrapOrchestrator } from './bootstrap/BootstrapOrchestrator';
export { SEED_VENDOR_ID } from './bootstrap/InventoryBootstrap';
export type { EmployeeRefs, ReferenceCache } from './support/ReferenceCache';
export { SeederRandom } from './support/SeederRandom';
export {
  isResponseErrorMatching,
  retryWhileReplicating,
  type ReplicationRetryOptions,
} from './support/replicationRetry';
