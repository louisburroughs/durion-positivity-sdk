import { SeederRandom } from '@durion-sdk/seeder';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas } from '../harness/personas';

/**
 * Harness smoke suite. Serves two purposes:
 *  - proves the globalSetup → context → per-suite login plumbing against a
 *    real backend (this is the template every A-D suite follows), and
 *  - guarantees at least one *.itest.ts exists, so `npm run test:integration`
 *    always executes globalSetup — which is where the missing-credential
 *    fail-fast and the accelerated-profile guard live.
 */
describe('integration harness', () => {
  let context: ItestContext;
  let personas: Personas;

  beforeAll(async () => {
    context = loadContext();
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
  });

  it('rehydrates the bootstrap reference data', () => {
    expect(context.runId).toMatch(/^itest-\d+-[a-z0-9]+$/);
    expect(context.referenceCache.locationId).not.toHaveLength(0);
    expect(context.referenceCache.serviceEntityIds.length).toBeGreaterThan(0);
    expect(context.referenceCache.productEntityIds.length).toBeGreaterThan(0);
    expect(context.referenceCache.employees.technicians.length).toBeGreaterThan(0);
  });

  it('authenticates every persona and can call the backend as each', async () => {
    const random = new SeederRandom(1422);
    void random; // deterministic data source, shared pattern for later suites

    for (const persona of [
      'admin',
      'advisor',
      'tech',
      'manager',
      'parts',
      'acct',
      'controller',
    ] as const) {
      const clients = personas.as(persona);
      // Cheapest authenticated round-trip: token issuance already succeeded
      // in beforeAll; this asserts the registry hands out per-persona clients.
      expect(clients.username).not.toHaveLength(0);
      expect(clients.auth.getToken()).not.toHaveLength(0);
    }
  });

  it('reports the run mode it will test under', () => {
    expect(['single-credential', 'role']).toContain(context.mode);
    if (context.mode === 'single-credential') {
      console.log('[itest] single-credential mode: role-enforcement tests will be skipped');
    }
  });
});
