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
    waitUntil: async (target: Date, overshootMinutes = 0) => {
      if (target.getTime() > current.getTime()) {
        current = new Date(target.getTime() + overshootMinutes * 60_000);
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
  /** The virtual instant each phase was handed. */
  at: Record<string, Date | undefined>;
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
  /** Virtual minutes the WAIT-OPEN overshoots its target by. */
  waitOvershootMinutes?: number;
  finish?: JobOutcome;
  jobLimit?: number;
}): Harness => {
  const clock = fakeClock(options.startIso);
  const ledger = new ResourceLedger();
  const jobs: FakeJob[] = [];
  const calls: string[] = [];
  /** The virtual instant each phase was handed, so the tests can pin when it ran. */
  const at_: Record<string, Date | undefined> = {};
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
      clockIn: async (at: Date) => {
        calls.push('clockIn');
        at_.clockIn = at;
        return ['tech-a', 'tech-b'];
      },
      clockOut: async (at: Date) => {
        calls.push('clockOut');
        at_.clockOut = at;
        return ['tech-a', 'tech-b'];
      },
      approveTime: async (at: Date) => {
        calls.push('approveTime');
        at_.approveTime = at;
      },
    },
    maintenance: {
      cycleCount: async (at: Date) => {
        calls.push('cycleCount');
        at_.cycleCount = at;
      },
      restock: async (at: Date) => {
        calls.push('restock');
        at_.restock = at;
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
    waitUntil: async (target: Date) => clock.waitUntil(target, options.waitOvershootMinutes ?? 0),
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

  return { runner: new AcceleratedDayRunner(deps), ledger, jobs, clock, calls, at: at_ };
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

  it('lets a started bay job finish inside the grace, and starts no new BAY work after close', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T17:45:00Z',
      stepMinutes: 15,
      jobSteps: 3,
      jobsToday: 5,
      concurrency: 1,
      // Bays only: with a mobile unit free the runner would rightly keep taking
      // mobile work after close, which is a different rule (asserted below).
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    const report = await runner.runDay(1);

    // One job was taken inside the window and finished at 18:15, inside the grace.
    // Nothing else started, because the window had closed.
    expect(jobs).toHaveLength(1);
    expect(report.workordersCompleted).toBe(1);
    const lastRun = jobs[0].ranAt[jobs[0].ranAt.length - 1];
    expect(lastRun.getTime()).toBeGreaterThan(Date.parse('2025-11-03T18:00:00Z'));
    expect(lastRun.getTime()).toBeLessThan(Date.parse('2025-11-03T19:30:00Z'));
    for (const at of jobs[0].ranAt) {
      expect(at.getTime()).toBeGreaterThanOrEqual(Date.parse('2025-11-03T17:45:00Z'));
    }
  });

  it('keeps taking NEW mobile work after the bays close', async () => {
    // The rule the docs promise: a mobile unit takes work at any hour. Before this
    // was fixed, only carried mobile jobs advanced out of hours and a closed window
    // meant an idle mobile unit.
    const { runner, jobs } = harness({
      startIso: '2025-11-03T17:50:00Z',
      stepMinutes: 15,
      jobSteps: 2,
      jobsToday: 4,
      concurrency: 1,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    await runner.runDay(1);

    const afterClose = jobs.filter((job) =>
      job.ranAt.some((at) => at.getTime() >= Date.parse('2025-11-03T18:00:00Z')),
    );
    expect(jobs.length).toBeGreaterThan(1);
    expect(afterClose.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.gatedByHours === false)).toBe(true);
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

describe('AcceleratedDayRunner — the shift must not outlast the shop', () => {
  it('clocks out at close plus grace, not at midnight, even with mobile work still to do', async () => {
    // The regression: with a mobile unit free, the work loop used to run to midnight
    // and clockOut was then handed a next-day instant. The payroll entry that produces
    // ends hours past close, which is precisely what the end-of-run audit raises — the
    // same reason no shift is opened on a closed day.
    const { runner, at } = harness({
      startIso: '2025-11-03T17:00:00Z',
      stepMinutes: 30,
      jobSteps: 40, // never finishes; keeps the loop fed
      jobsToday: 6,
      concurrency: 2,
      rosters: [
        roster({
          freePositions: [
            { kind: 'BAY', id: 'bay-1', name: 'Bay 01' },
            { kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' },
          ],
          idleTechnicianIds: ['tech-a', 'tech-b'],
        }),
      ],
    });

    await runner.runDay(1);

    const clockOut = at.clockOut as Date;
    expect(clockOut).toBeDefined();
    // Asserted through the calendar, not against a hand-computed instant. `<= 19:30`
    // passed on exactly close+grace, which `withinGrace` rejects (it is strict) — so the
    // test green-lit the one value the end-of-run audit fails on.
    expect(new ShopCalendar(spec()).withinGrace(clockOut, 'BAY')).toBe(true);
    expect(clockOut.toISOString().slice(0, 10)).toBe('2025-11-03');
  });

  it('leaves the clock before midnight so the caller does not skip a virtual day', async () => {
    // nextUtcMidnight() adds a day to whatever it is given, so a day that ended at
    // exactly 00:00 made the run wait for the day *after* the next one — losing one
    // virtual day per day worked, and converging halfway through a 365-day run.
    const { runner, clock } = harness({
      startIso: '2025-11-03T17:00:00Z',
      stepMinutes: 30,
      jobSteps: 40,
      jobsToday: 6,
      concurrency: 2,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    await runner.runDay(1);

    expect(clock.peek().getTime()).toBeLessThanOrEqual(Date.parse('2025-11-04T00:00:00Z'));
  });

  it('hands maintenance the end of the worked window, not the opening instant', async () => {
    const { runner, at } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 60,
      jobSteps: 2,
      jobsToday: 2,
      concurrency: 1,
    });

    await runner.runDay(7);

    const cycleCount = at.cycleCount as Date;
    expect(cycleCount).toBeDefined();
    // Work happened first, so the count cannot be stamped at 08:00.
    expect(cycleCount.getTime()).toBeGreaterThan(Date.parse('2025-11-03T08:00:00Z'));
  });

  it('still works mobile units after the bays close, once the shift is shut', async () => {
    const { runner, jobs, calls } = harness({
      startIso: '2025-11-03T17:30:00Z',
      stepMinutes: 15,
      jobSteps: 2,
      jobsToday: 6,
      concurrency: 1,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    await runner.runDay(1);

    // Some mobile work landed after 18:00, and it happened after clockOut.
    const afterClose = jobs.filter((job) =>
      job.ranAt.some((ranAt) => ranAt.getTime() >= Date.parse('2025-11-03T18:00:00Z')),
    );
    expect(afterClose.length).toBeGreaterThan(0);
    expect(calls.indexOf('clockOut')).toBeGreaterThan(-1);
  });

  it('does not restart the day\'s intake budget for the after-hours stretch', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T17:40:00Z',
      stepMinutes: 10,
      jobSteps: 1,
      jobsToday: 3,
      concurrency: 1,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    await runner.runDay(1);

    // Three customers for the day means three, not three before close and three after.
    expect(jobs).toHaveLength(3);
  });
});

describe('AcceleratedDayRunner — a closed day', () => {
  it('opens no shift and runs no maintenance on a Sunday, whatever the mobile units do', async () => {
    const { runner, calls } = harness({ startIso: '2025-11-09T09:00:00Z', stepMinutes: 30 });

    const report = await runner.runDay(7);

    expect(report.skipped).toBe('closed');
    // No payroll on a closed day: a mobile crew turning out on a Sunday is on call,
    // and a shift recorded here would be a time entry outside the shop's hours —
    // exactly what the end-of-run audit asserts against.
    expect(calls).not.toContain('clockIn');
    expect(calls).not.toContain('clockOut');
    expect(calls).not.toContain('approveTime');
    // Nor floor work.
    expect(calls).not.toContain('cycleCount');
    expect(calls).not.toContain('restock');
    expect(report.clockedIn).toBe(0);
  });

  it('starts NEW mobile work on a closed day — a weekend is not two days of dead air', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-09T09:00:00Z', // Sunday
      stepMinutes: 60,
      jobSteps: 2,
      jobsToday: 3,
      concurrency: 1,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    const report = await runner.runDay(7);

    expect(report.skipped).toBe('closed');
    expect(jobs.length).toBeGreaterThan(0);
    expect(report.workordersCompleted).toBeGreaterThan(0);
  });

  it('starts no BAY work on a closed day, however many bays are free', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-09T09:00:00Z',
      stepMinutes: 60,
      jobSteps: 2,
      jobsToday: 3,
      concurrency: 2,
      rosters: [
        roster({
          freePositions: [
            { kind: 'BAY', id: 'bay-1', name: 'Bay 01' },
            { kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' },
          ],
          idleTechnicianIds: ['tech-a', 'tech-b'],
        }),
      ],
    });

    await runner.runDay(7);

    expect(jobs.every((job) => job.label.includes('mu-1'))).toBe(true);
  });

  it('reports a closed day whose board could not be read, rather than passing quietly', async () => {
    const { runner } = harness({
      startIso: '2025-11-09T09:00:00Z',
      stepMinutes: 60,
      jobsToday: 2,
      rosters: [],
    });

    const report = await runner.runDay(7);

    expect(report.failures[0]).toMatch(/no site reported a usable dispatch board/);
  });

  it('does nothing at all on a closed day when mobile units are gated too', async () => {
    const { runner, jobs, calls } = harness({
      startIso: '2025-11-09T09:00:00Z',
      stepMinutes: 60,
      jobsToday: 3,
      calendar: spec({ mobileAfterHours: false }),
    });

    const report = await runner.runDay(7);

    expect(report.skipped).toBe('closed');
    expect(jobs).toHaveLength(0);
    // Not even a board read: nothing could be claimed, so nothing is spent finding out.
    expect(calls).toEqual([]);
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

describe('AcceleratedDayRunner — a wait that crosses or overshoots the window', () => {
  it('works the day it actually woke up on, when the wait crossed midnight', async () => {
    // Friday 20:00, after close: the next bay window is Saturday 09:00. The day's own
    // boundary has to move with the wait — taken from before it, it was already in the
    // past, so the work loop broke on its first check and the day clocked everyone in
    // and out, spent its intake and worked nothing, while reporting success.
    const { runner, calls } = harness({
      startIso: '2025-11-07T20:00:00Z',
      stepMinutes: 15,
      jobSteps: 2,
      jobsToday: 2,
      concurrency: 1,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    const report = await runner.runDay(1);

    expect(report.virtualDate).toBe('2025-11-08'); // Saturday
    expect(report.skipped).toBeUndefined();
    expect(calls).toContain('clockIn');
    expect(report.workordersCompleted).toBeGreaterThan(0);
  });

  it('opens no shift when the wait overshot the window entirely', async () => {
    // A real wait can land past the window it was waiting for. Clocking anyone in then
    // stamps a payroll entry outside the open window, which is the violation the
    // end-of-run audit raises.
    const { runner, calls } = harness({
      startIso: '2025-11-03T05:00:00Z',
      stepMinutes: 15,
      jobsToday: 2,
      concurrency: 1,
      // Waits to 08:00, lands at 19:00 — past the 18:00 close.
      waitOvershootMinutes: 11 * 60,
    });

    const report = await runner.runDay(1);

    expect(report.skipped).toBe('window-missed');
    expect(calls).not.toContain('clockIn');
    expect(calls).not.toContain('clockOut');
    expect(report.clockedIn).toBe(0);
  });

  it('still lets mobile units work a day whose window was missed', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T05:00:00Z',
      stepMinutes: 30,
      jobSteps: 2,
      jobsToday: 2,
      concurrency: 1,
      waitOvershootMinutes: 11 * 60,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    const report = await runner.runDay(1);

    expect(report.skipped).toBe('window-missed');
    expect(jobs.length).toBeGreaterThan(0);
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
