import { SeederRandom, type ReferenceCache } from '@durion-sdk/seeder';
import { AcceleratedJob, INVOICE_WAIT_VIRTUAL_MS, SERVICE_ADVISOR_LIMIT, type JobDeps } from './acceleratedJob';
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

/** Positions a job at `from` with a completed workorder, the way the day runner leaves it. */
const atStep = (job: AcceleratedJob, from: string): void => {
  const internals = job as unknown as {
    workorderId: string;
    workorderClosed: boolean;
    steps: Array<{ name: string }>;
    cursor: number;
  };
  internals.workorderId = 'wo-1';
  internals.workorderClosed = true;
  internals.cursor = internals.steps.findIndex((step) => step.name === from);
};

describe('AcceleratedJob — a queued invoice', () => {
  /**
   * generate-invoice answers PENDING until the invoice is linked to the workorder, and
   * the workorder read shows the link. `linkAfterReads` is how many reads see no link.
   */
  const invoicing = (linkAfterReads: number, clock: { ms: number }, stepMs = 60_000) => {
    const generates: string[] = [];
    let reads = 0;
    const linked = () => reads > linkAfterReads;
    const as = {
      advisor: {
        workorder: {
          workOrderAPIApi: {
            async generateWorkorderInvoice(request: { workorderId: string }) {
              generates.push(request.workorderId);
              return linked()
                ? { invoiceId: 'inv-1', status: 'DRAFT', totalAmount: 612.5 }
                : { status: 'PENDING' };
            },
            async getWorkorder() {
              reads += 1;
              clock.ms += stepMs;
              return linked() ? { invoiceId: 'inv-1' } : {};
            },
          },
        },
      },
    } as unknown as JobDeps['as'];
    return { as, generates, reads: () => reads };
  };

  const jobWith = (as: JobDeps['as'], clock: { ms: number }) =>
    new AcceleratedJob('job-5', {
      ...deps(claimAt('site-north')),
      as,
      now: async () => new Date(clock.ms),
    });

  it('asks once, polls the workorder for the link, then reads the invoice', async () => {
    // Every PENDING generate-invoice queues another command; re-asking each tick put
    // ~3 commands on the topic per invoice. Only the first ask and the post-link read
    // should hit it.
    const clock = { ms: Date.parse('2025-11-03T10:00:00Z') };
    const { as, generates, reads } = invoicing(2, clock);
    const job = jobWith(as, clock);
    atStep(job, 'invoice');

    expect(await job.advance()).toBe('in-progress');
    expect(job.nextStep).toBe('invoice-wait');
    await job.advance();
    await job.advance();
    expect(job.invoiceId).toBeUndefined();
    await job.advance();

    expect(job.outcome).toBe('in-progress');
    expect(job.invoiceId).toBe('inv-1');
    expect(job.draftTotal).toBe(612.5);
    expect(job.nextStep).toBe('finalize');
    expect(reads()).toBe(3);
    expect(generates).toHaveLength(2);
  });

  it('takes the invoice at once when generation answers with it', async () => {
    const clock = { ms: Date.parse('2025-11-03T10:00:00Z') };
    const { as, generates, reads } = invoicing(-1, clock);
    const job = jobWith(as, clock);
    atStep(job, 'invoice');

    await job.advance();

    expect(job.invoiceId).toBe('inv-1');
    expect(job.nextStep).toBe('finalize');
    expect(reads()).toBe(0);
    expect(generates).toHaveLength(1);
  });

  it('bounds the wait by virtual time, not by how many ticks it took', async () => {
    // Quick ticks spend little virtual time each: twelve of them spanned a few virtual
    // minutes and failed whole days of jobs whose link was ~25 minutes away.
    const clock = { ms: Date.parse('2025-11-03T10:00:00Z') };
    const { as } = invoicing(Number.MAX_SAFE_INTEGER, clock, 60_000);
    const job = jobWith(as, clock);
    atStep(job, 'invoice');

    await job.advance();
    const minutes = INVOICE_WAIT_VIRTUAL_MS / 60_000;
    for (let tick = 1; tick < minutes; tick += 1) {
      expect(await job.advance()).toBe('in-progress');
    }

    expect(await job.advance()).toBe('failed');
    expect(job.failure).toContain(`within ${minutes} virtual minutes`);
  });
});

describe('AcceleratedJob — who finalizes', () => {
  const finalizing = (total: number) => {
    const finalizedBy: string[] = [];
    const persona = (name: string) => ({
      invoice: {
        invoiceApi: {
          async getInvoice() {
            // SERVICE_ADVISOR holds no invoice:invoice:view; a read here would 403.
            throw new Error(`${name} read the invoice`);
          },
          async finalizeInvoice() {
            finalizedBy.push(name);
            return { total };
          },
        },
      },
    });
    const as = { advisor: persona('advisor'), manager: persona('manager') } as unknown as JobDeps['as'];
    return { as, finalizedBy };
  };

  const finalizeAt = async (total: number): Promise<string[]> => {
    const { as, finalizedBy } = finalizing(total);
    const job = new AcceleratedJob('job-7', { ...deps(claimAt('site-north')), as });
    atStep(job, 'finalize');
    job.invoiceId = 'inv-1';
    job.draftTotal = total;

    await job.advance();

    expect(job.outcome).toBe('in-progress');
    expect(job.invoiceTotal).toBe(total);
    return finalizedBy;
  };

  it('is the advisor up to the advisor cap', async () => {
    expect(await finalizeAt(SERVICE_ADVISOR_LIMIT)).toEqual(['advisor']);
  });

  it('is the manager above it, since an advisor needs an approval code there', async () => {
    // The backend answers 403 MANAGER_APPROVAL_REQUIRED to an advisor above $500.
    expect(await finalizeAt(SERVICE_ADVISOR_LIMIT + 0.01)).toEqual(['manager']);
  });
});
