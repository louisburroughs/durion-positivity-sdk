import { SeederRandom, type ReferenceCache } from '@durion-sdk/seeder';
import { AcceleratedJob, type JobDeps } from './acceleratedJob';
import type { Claim } from './resourceLedger';

/**
 * The reference cache holds one site. A claim can be at any site whose board the
 * day discovered, and the job has to build its work where it will place it.
 */
const refs = (): ReferenceCache => ({
  locationId: 'site-reference',
  bayIds: [],
  employees: { technicians: ['tech-a'], serviceWriters: [], manager: 'mgr', partsClerk: 'parts' },
  serviceEntityIds: ['svc-1', 'svc-2'],
  productEntityIds: ['prd-1'],
  serviceNameById: new Map([['svc-1', 'Oil Change']]),
  productNameById: new Map([['prd-1', 'Oil Filter']]),
  employeeNameById: new Map(),
});

const claimAt = (locationId: string): Claim => ({
  id: 'claim-1',
  locationId,
  position: { kind: 'BAY', id: 'bay-9', name: 'Bay 09' },
  technicianId: 'tech-a',
  heldFrom: new Date('2025-11-03T08:00:00Z'),
});

const deps = (claim: Claim): JobDeps => ({
  as: {} as JobDeps['as'],
  ctx: { runId: 'accel-test', random: new SeederRandom(1), refs: refs() },
  claim,
  now: async () => new Date('2025-11-03T08:00:00Z'),
});

describe('AcceleratedJob — the site it builds at', () => {
  it('builds at the site it holds a position at, not the reference cache\'s', () => {
    // A workorder created at one site and placed on another site's bay is refused
    // with 422 SERVICE_POSITION_INVALID — "the position is unknown or at another
    // site". That mismatch failed 3,864 jobs across one virtual year.
    const job = new AcceleratedJob('job-1', deps(claimAt('site-north')));

    expect(job.locationId).toBe('site-north');
  });

  it('leaves the rest of the reference cache alone', () => {
    // Services and products are catalog-level, shared across sites: copying the
    // cache per job must not fork them.
    const job = new AcceleratedJob('job-1', deps(claimAt('site-north')));

    expect(job.catalog.serviceEntityIds).toEqual(['svc-1', 'svc-2']);
    expect(job.catalog.productEntityIds).toEqual(['prd-1']);
  });
});
