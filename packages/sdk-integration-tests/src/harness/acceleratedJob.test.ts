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

/** Records what the job asks the backend to do with its technician. */
const recordingPersonas = (released: string[], assignThrows?: Error) =>
  ({
    manager: {
      workorder: {
        technicianAssignmentAPIApi: {
          async assignTechnician() {
            if (assignThrows) {
              throw assignThrows;
            }
            return {};
          },
          async releaseTechnician(request: { workorderId: string; reason: string }) {
            released.push(request.workorderId);
            return {};
          },
        },
      },
    },
  }) as unknown as JobDeps['as'];

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

describe('AcceleratedJob — a failure that holds a technician', () => {
  it('hands the technician back when a later step fails', async () => {
    // The shape that left ~1,800 orphans: assign-technician succeeds, the next
    // step fails, and the person stays bound to the workorder on every later
    // dispatch board.
    const released: string[] = [];
    const job = new AcceleratedJob('job-1', {
      ...deps(claimAt('site-north')),
      as: recordingPersonas(released),
    });

    // Reach into the job the way the day runner does: it only advances steps.
    (job as unknown as { workorderId: string }).workorderId = 'wo-1';
    (job as unknown as { technicianAssigned: boolean }).technicianAssigned = true;
    (job as unknown as { steps: Array<{ name: string; run: () => Promise<void> }> }).steps = [
      { name: 'boom', run: async () => { throw new Error('HTTP 422'); } },
    ];
    (job as unknown as { cursor: number }).cursor = 0;

    expect(await job.advance()).toBe('failed');
    expect(released).toEqual(['wo-1']);
  });

  it('does not release from a workorder the job has already completed', async () => {
    // invoice, finalize and pay all run after `complete`, and a completed
    // workorder answers 409 WORKORDER_CLOSED — so attempting the release there
    // would append a second failure about a technician the completion already
    // released.
    const released: string[] = [];
    const job = new AcceleratedJob('job-4', {
      ...deps(claimAt('site-north')),
      as: recordingPersonas(released),
    });
    (job as unknown as { workorderId: string }).workorderId = 'wo-4';
    (job as unknown as { technicianAssigned: boolean }).technicianAssigned = true;
    (job as unknown as { workorderClosed: boolean }).workorderClosed = true;
    (job as unknown as { steps: Array<{ name: string; run: () => Promise<void> }> }).steps = [
      { name: 'pay', run: async () => { throw new Error('HTTP 409 payment refused'); } },
    ];
    (job as unknown as { cursor: number }).cursor = 0;

    await job.advance();

    expect(released).toEqual([]);
    expect(job.failure).toContain('payment refused');
    expect(job.failure).not.toContain('technician could not be released');
  });

  it('does not release a technician it never held', async () => {
    const released: string[] = [];
    const job = new AcceleratedJob('job-2', {
      ...deps(claimAt('site-north')),
      as: recordingPersonas(released),
    });
    (job as unknown as { steps: Array<{ name: string; run: () => Promise<void> }> }).steps = [
      { name: 'boom', run: async () => { throw new Error('HTTP 500'); } },
    ];
    (job as unknown as { cursor: number }).cursor = 0;

    expect(await job.advance()).toBe('failed');
    expect(released).toEqual([]);
  });

  it('reports a release that fails without losing the original failure', async () => {
    const job = new AcceleratedJob('job-3', {
      ...deps(claimAt('site-north')),
      as: {
        manager: {
          workorder: {
            technicianAssignmentAPIApi: {
              async releaseTechnician() {
                throw new Error('release refused');
              },
            },
          },
        },
      } as unknown as JobDeps['as'],
    });
    (job as unknown as { workorderId: string }).workorderId = 'wo-3';
    (job as unknown as { technicianAssigned: boolean }).technicianAssigned = true;
    (job as unknown as { steps: Array<{ name: string; run: () => Promise<void> }> }).steps = [
      { name: 'boom', run: async () => { throw new Error('the original failure'); } },
    ];
    (job as unknown as { cursor: number }).cursor = 0;

    await job.advance();

    expect(job.failure).toContain('the original failure');
    expect(job.failure).toContain('technician could not be released');
  });
});
