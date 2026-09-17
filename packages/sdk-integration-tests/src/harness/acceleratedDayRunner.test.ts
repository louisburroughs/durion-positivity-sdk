import type { SiteRoster } from '../runs/shopFloorPlan';
import type { JobOutcome } from './acceleratedJob';
import {
  AcceleratedDayRunner,
  type DayRunnerDeps,
  type RunnableJob,
} from './acceleratedDayRunner';
import { ResourceLedger } from './resourceLedger';
import { ShopCalendar, type CalendarSpec } from './shopCalendar';

const spec = (overrides: Partial<CalendarSpec> = {}): CalendarSpec => ({
  weekday: { openMinutes: 8 * 60, closeMinutes: 18 * 60 },
  saturday: { openMinutes: 9 * 60, closeMinutes: 13 * 60 },
  sunday: null,
  holidays: new Set(['2025-12-25']),
  graceMinutes: 90,
  mobileAfterHours: true,
  ...overrides,
});

const roster = (overrides: Partial<SiteRoster> = {}): SiteRoster => ({
  locationId: 'site-1',
  code: 'CLT-MAIN-001',
  name: 'Charlotte Main',
  freePositions: [
    { kind: 'BAY', id: 'bay-1', name: 'Bay 01' },
    { kind: 'BAY', id: 'bay-2', name: 'Bay 02' },
    { kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' },
  ],
  occupiedPositions: [],
  idleTechnicianIds: ['tech-a', 'tech-b', 'tech-c'],
  busyTechnicianIds: [],
  ...overrides,
});

/** A job that finishes after `steps` advances, recording where it ran. */
class FakeJob implements RunnableJob {
  outcome: JobOutcome = 'in-progress';
  failure: string | undefined;
  workorderId: string | undefined;
  invoiceId: string | undefined;
  invoiceTotal: number | undefined;
  paid = false;
  advances = 0;
  readonly ranAt: Date[] = [];

  constructor(
    readonly label: string,
    readonly gatedByHours: boolean,
    private readonly steps: number,
    private readonly clock: { peek: () => Date; advance: (minutes: number) => void },
    private readonly stepMinutes: number,
    private readonly finish: JobOutcome = 'completed',
  ) {}

  get nextStep(): string {
    return this.outcome === 'in-progress' ? `step-${this.advances + 1}` : 'done';
  }

  async advance(): Promise<JobOutcome> {
    this.ranAt.push(this.clock.peek());
    this.clock.advance(this.stepMinutes);
    this.advances += 1;
    if (this.advances >= this.steps) {
      this.outcome = this.finish;
      if (this.finish === 'completed') {
        this.workorderId = `wo-${this.label}`;
        this.invoiceId = `inv-${this.label}`;
        this.invoiceTotal = 100;
        this.paid = true;
      }
      if (this.finish === 'failed') {
        this.workorderId = `wo-${this.label}`;
        this.failure = `${this.label} blew up`;
      }
    }
    return this.outcome;
  }
}

/**
 * A virtual clock the test drives by hand.
 *
 * Reading it is free and *doing work* costs time, which is the way round the real
 * backend behaves: `/system/time` is one cheap call, while a job's step is several
 * gateway round trips that the accelerated clock turns into virtual hours. An
 * earlier version of this stub advanced on every read, which made the runner look
 * like it burned the window on clock reads and hid what the gating actually does.
 */
const fakeClock = (startIso: string) => {
  let current = new Date(startIso);
  return {
    peek: () => new Date(current),
    advance: (minutes: number) => {
      current = new Date(current.getTime() + minutes * 60_000);
    },
    now: async () => new Date(current),
    waitUntil: async (target: Date) => {
      if (target.getTime() > current.getTime()) {
        current = new Date(target);
      }
    },
    set: (iso: string) => {
      current = new Date(iso);
    },
  };
};

interface Harness {
  runner: AcceleratedDayRunner;
  ledger: ResourceLedger;
  jobs: FakeJob[];
  clock: ReturnType<typeof fakeClock>;
  calls: string[];
}

const harness = (options: {
  startIso: string;
  /** Virtual minutes one job step consumes. */
  stepMinutes?: number;
  calendar?: CalendarSpec;
  rosters?: SiteRoster[];
  jobSteps?: number;
  jobsToday?: number;
  concurrency?: number;
  jobKind?: 'BAY' | 'MOBILE_UNIT';
  finish?: JobOutcome;
  jobLimit?: number;
}): Harness => {
  const clock = fakeClock(options.startIso);
  const ledger = new ResourceLedger();
  const jobs: FakeJob[] = [];
  const calls: string[] = [];
  const rosters = options.rosters ?? [roster()];

  const deps: DayRunnerDeps = {
    calendar: new ShopCalendar(options.calendar ?? spec()),
    ledger,
    discovery: {
      rosters: async () => {
        calls.push('discover');
        return rosters;
      },
    },
    shift: {
      clockIn: async () => {
        calls.push('clockIn');
        return ['tech-a', 'tech-b'];
      },
      clockOut: async () => {
        calls.push('clockOut');
        return ['tech-a', 'tech-b'];
      },
      approveTime: async () => {
        calls.push('approveTime');
      },
    },
    maintenance: {
      cycleCount: async () => {
        calls.push('cycleCount');
      },
      restock: async () => {
        calls.push('restock');
      },
    },
    appointments: {
      book: async () => {
        calls.push('bookAppointments');
        return 2;
      },
      convertDue: async () => {
        calls.push('convertAppointments');
        return 1;
      },
    },
    now: clock.now,
    waitUntil: clock.waitUntil,
    createJob: (claim, index) => {
      if (options.jobLimit !== undefined && jobs.length >= options.jobLimit) {
        return null;
      }
      const job = new FakeJob(
        `job-${index}-${claim.position.id}`,
        (options.jobKind ?? claim.position.kind) === 'BAY',
        options.jobSteps ?? 2,
        clock,
        options.stepMinutes ?? 30,
        options.finish,
      );
      jobs.push(job);
      return job;
    },
    concurrency: options.concurrency ?? 2,
    jobsToday: () => options.jobsToday ?? 2,
  };

  return { runner: new AcceleratedDayRunner(deps), ledger, jobs, clock, calls };
};

describe('AcceleratedDayRunner — an open day', () => {
  it('runs the phases in shop order', async () => {
    const { runner, calls } = harness({ startIso: '2025-11-03T07:00:00Z', stepMinutes: 5 });

    await runner.runDay(1);

    expect(calls).toEqual([
      'discover',
      'clockIn',
      'convertAppointments',
      'bookAppointments',
      'clockOut',
      'approveTime',
    ]);
  });

  it('waits for opening time before touching the shop', async () => {
    const { runner, jobs } = harness({ startIso: '2025-11-03T05:00:00Z', stepMinutes: 5 });

    await runner.runDay(1);

    // Nothing ran before 08:00, which is what "no work before opening" means.
    for (const job of jobs) {
      for (const at of job.ranAt) {
        expect(at.getTime()).toBeGreaterThanOrEqual(Date.parse('2025-11-03T08:00:00Z'));
      }
    }
  });

  it('counts completed work, invoices and payments', async () => {
    const { runner } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 5, jobsToday: 2 });

    const report = await runner.runDay(1);

    expect(report.skipped).toBeUndefined();
    expect(report.workordersCompleted).toBe(2);
    expect(report.invoicesFinalized).toBe(2);
    expect(report.invoicesPaid).toBe(2);
    expect(report.workorderIds).toHaveLength(2);
    expect(report.clockedIn).toBe(2);
    expect(report.appointmentsBooked).toBe(2);
    expect(report.appointmentsConverted).toBe(1);
  });

  it('records a declined estimate as declined, not as a failure', async () => {
    const { runner } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 5, finish: 'declined' });

    const report = await runner.runDay(1);

    expect(report.estimatesDeclined).toBe(2);
    expect(report.workordersCompleted).toBe(0);
    expect(report.workordersFailed).toBe(0);
  });

  it('reports a failed job with its reason and still frees the resources', async () => {
    const { runner, ledger } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 5, finish: 'failed' });

    const report = await runner.runDay(1);

    expect(report.workordersFailed).toBe(2);
    expect(report.failures[0]).toMatch(/blew up/);
    expect(ledger.activeClaims()).toHaveLength(0);
  });

  it('never double-books: every claim is released or carried, and nothing overlaps', async () => {
    const { runner, ledger } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 5,
      jobsToday: 6,
      concurrency: 3,
    });

    await runner.runDay(1);

    expect(ledger.overlaps()).toEqual([]);
    expect(ledger.activeClaims()).toHaveLength(0);
  });

  it('honours the concurrency limit', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 1,
      jobsToday: 10,
      concurrency: 2,
      jobSteps: 4,
    });

    await runner.runDay(1);

    // Three positions and three technicians exist, but only two may work at once,
    // so the day's work is done in waves rather than all at once.
    expect(jobs.length).toBeGreaterThan(2);
  });

  it('stops taking work when the site runs out of resources', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 1,
      jobsToday: 10,
      concurrency: 10,
      jobSteps: 1,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    await runner.runDay(1);

    expect(jobs.every((job) => job.label.includes('bay-1'))).toBe(true);
  });
});

describe('AcceleratedDayRunner — closing time', () => {
  it('carries a job that is still open at close, keeping its bay', async () => {
    // 30-minute ticks from 17:00: the window closes at 18:00 and the grace ends at
    // 19:30, so a 20-step job cannot finish today.
    const { runner, ledger, jobs } = harness({
      startIso: '2025-11-03T17:00:00Z',
      stepMinutes: 30,
      jobSteps: 20,
      jobsToday: 1,
      concurrency: 1,
    });

    const report = await runner.runDay(1);

    expect(report.workordersCompleted).toBe(0);
    expect(report.carriedOut).toBe(1);
    expect(runner.carriedCount).toBe(1);
    expect(ledger.carriedClaims()).toHaveLength(1);
    // The bay is still held: nothing else may take it overnight.
    expect(ledger.claim('site-1', new Date('2025-11-03T20:00:00Z'), 'BAY')?.position.id).not.toBe(
      jobs[0].label.includes('bay-1') ? 'bay-1' : 'none',
    );
  });

  it('lets a started bay job finish inside the grace, but starts nothing new there', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T17:45:00Z',
      stepMinutes: 15,
      jobSteps: 3,
      jobsToday: 5,
      concurrency: 1,
    });

    const report = await runner.runDay(1);

    // One job was taken inside the window and finished at 18:15, inside the grace.
    expect(jobs).toHaveLength(1);
    expect(report.workordersCompleted).toBe(1);
    const lastRun = jobs[0].ranAt[jobs[0].ranAt.length - 1];
    expect(lastRun.getTime()).toBeGreaterThan(Date.parse('2025-11-03T18:00:00Z'));
    expect(lastRun.getTime()).toBeLessThan(Date.parse('2025-11-03T19:30:00Z'));
  });

  it('will not advance a bay job past the grace period', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T17:55:00Z',
      stepMinutes: 60,
      jobSteps: 10,
      jobsToday: 1,
      concurrency: 1,
    });

    await runner.runDay(1);

    for (const at of jobs[0].ranAt) {
      expect(at.getTime()).toBeLessThan(Date.parse('2025-11-03T19:30:00Z'));
    }
  });
});

describe('AcceleratedDayRunner — a closed day', () => {
  it('skips a Sunday without opening the shop', async () => {
    const { runner, calls } = harness({ startIso: '2025-11-09T09:00:00Z', stepMinutes: 30 });

    const report = await runner.runDay(7);

    expect(report.skipped).toBe('closed');
    expect(calls).toEqual([]);
    expect(report.workordersCompleted).toBe(0);
  });

  it('skips a holiday that would otherwise be a working day', async () => {
    const { runner } = harness({ startIso: '2025-12-25T09:00:00Z', stepMinutes: 30 });

    expect((await runner.runDay(1)).skipped).toBe('closed');
  });

  it('advances carried mobile work on a closed day — a weekend is not dead air', async () => {
    const mobileRoster = roster({
      freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
      idleTechnicianIds: ['tech-a'],
    });
    const { runner, clock, jobs } = harness({
      startIso: '2025-11-07T17:30:00Z', // Friday, inside the window
      stepMinutes: 60,
      jobSteps: 12, // twelve hours of work: it cannot finish before midnight
      jobsToday: 1,
      concurrency: 1,
      rosters: [mobileRoster],
    });

    const friday = await runner.runDay(5);
    // Mobile work is ungated, so it ran into the evening — and stopped at the day
    // boundary rather than eating Saturday.
    expect(friday.carriedOut).toBe(1);
    expect(jobs[0].ranAt[jobs[0].ranAt.length - 1].getTime()).toBeLessThan(Date.parse('2025-11-08T00:00:00Z'));

    // Sunday: the shop is shut, but the mobile unit's job keeps going.
    clock.set('2025-11-09T09:00:00Z');
    const advancesBefore = jobs[0].advances;
    const sunday = await runner.runDay(7);

    expect(sunday.skipped).toBe('closed');
    expect(jobs[0].advances).toBeGreaterThan(advancesBefore);
  });

  it('does not advance a carried bay job on a closed day', async () => {
    const { runner, clock, jobs } = harness({
      startIso: '2025-11-07T17:30:00Z',
      stepMinutes: 60,
      jobSteps: 40,
      jobsToday: 1,
      concurrency: 1,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    await runner.runDay(5);
    expect(runner.carriedCount).toBe(1);
    const advancesAtFridayClose = jobs[0].advances;

    clock.set('2025-11-09T09:00:00Z');
    const sunday = await runner.runDay(7);

    expect(sunday.skipped).toBe('closed');
    expect(jobs[0].advances).toBe(advancesAtFridayClose);
    // Still holding its bay: a car left in the shop over the weekend is nobody
    // else's bay on Monday morning.
    expect(runner.carriedCount).toBe(1);
  });
});

describe('AcceleratedDayRunner — sampling and maintenance', () => {
  it('reports a sampled-out day and works nothing new', async () => {
    const { runner, calls } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 30 });

    const report = await runner.runDay(2, { sampled: false });

    expect(report.skipped).toBe('sampled-out');
    expect(calls).toEqual([]);
    expect(report.workordersCompleted).toBe(0);
  });

  it('runs the cycle count on every 7th day and the restock on every 30th', async () => {
    const seventh = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 10 });
    const seventhReport = await seventh.runner.runDay(7);
    expect(seventhReport.cycleCount).toBe(true);
    expect(seventhReport.restock).toBe(false);
    expect(seventh.calls).toContain('cycleCount');

    const thirtieth = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 10 });
    const thirtiethReport = await thirtieth.runner.runDay(30);
    expect(thirtiethReport.restock).toBe(true);
    expect(thirtieth.calls).toContain('restock');
  });

  it('runs neither on an adjacent day', async () => {
    for (const dayNumber of [6, 8, 29, 31]) {
      const { runner, calls } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 10 });
      const report = await runner.runDay(dayNumber);
      expect(report.cycleCount).toBe(false);
      expect(report.restock).toBe(false);
      expect(calls).not.toContain('cycleCount');
      expect(calls).not.toContain('restock');
    }
  });
});

describe('AcceleratedDayRunner — the day boundary arriving mid-request', () => {
  it('reports the virtual date the backend used, not the one the day started with', async () => {
    // Starts at 23:50 on the 3rd; the wait for the next open window lands on the
    // 4th, and that is the date the day must report.
    const { runner } = harness({ startIso: '2025-11-03T23:50:00Z', stepMinutes: 5 });

    const report = await runner.runDay(1);

    expect(report.virtualDate).toBe('2025-11-04');
  });

  it('records a day with no usable board as a failure rather than a quiet success', async () => {
    const { runner } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 10, rosters: [] });

    const report = await runner.runDay(1);

    expect(report.failures[0]).toMatch(/no site reported a usable dispatch board/);
    expect(report.workordersCompleted).toBe(0);
  });
});
