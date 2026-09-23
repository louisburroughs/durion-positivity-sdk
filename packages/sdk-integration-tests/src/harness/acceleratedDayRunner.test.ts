import type { SiteRoster } from '../runs/shopFloorPlan';
import type { JobOutcome } from './acceleratedJob';
import {
  AcceleratedDayRunner,
  PartialProgressError,
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
  readonly kind: 'BAY' | 'MOBILE_UNIT';
  failure: string | undefined;
  workorderId: string | undefined;
  invoiceId: string | undefined;
  invoiceTotal: number | undefined;
  paid = false;
  advances = 0;
  /**
   * The real job reopens a suspended labor clock on its next advance; this mirrors that,
   * because a fake that stayed suspended would let a runner that never resumes pass.
   */
  laborOpen = false;
  /** One entry per suspend, holding the step count it happened at. */
  readonly laborSuspendedAt: number[] = [];
  /** Set by the harness to make a suspend throw, as a refused stopLaborSession does. */
  suspendFails = false;
  readonly ranAt: Date[] = [];
  /** Whether the shift was open when each step ran — off-the-clock labor is a defect. */
  readonly ranOnTheClock: boolean[] = [];
  /** Set by the harness so a job can see the shift state. */
  onTheClock: () => boolean = () => true;

  constructor(
    readonly label: string,
    readonly gatedByHours: boolean,
    private readonly steps: number,
    private readonly clock: { peek: () => Date; advance: (minutes: number) => void },
    private readonly stepMinutes: number | (() => number),
    private readonly finish: JobOutcome = 'completed',
  ) {
    this.kind = gatedByHours ? 'BAY' : 'MOBILE_UNIT';
  }

  get nextStep(): string {
    return this.outcome === 'in-progress' ? `step-${this.advances + 1}` : 'done';
  }

  async suspendLabor(): Promise<void> {
    if (this.suspendFails) {
      throw new Error('stopLaborSession refused: HTTP 500');
    }
    this.laborSuspendedAt.push(this.advances);
    this.laborOpen = false;
  }

  async advance(): Promise<JobOutcome> {
    // The clock goes back on before the work, suspended or not — see AcceleratedJob.advance.
    this.laborOpen = true;
    // The real job gets its workorder at the `promote` step, well before it finishes, and
    // the runner leans on that: a job still carried at the end of the run has a workorder
    // and may have labor entries. A fake that only produced one on completion made every
    // assertion about carried work vacuous.
    this.workorderId ??= `wo-${this.label}`;
    this.ranAt.push(this.clock.peek());
    this.ranOnTheClock.push(this.onTheClock());
    this.clock.advance(typeof this.stepMinutes === 'function' ? this.stepMinutes() : this.stepMinutes);
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
  /** Virtual minutes each non-work phase (shift, appointments) consumes. */
  phaseCostMinutes?: number;
  /** Overrides the step cost per call, for probing one pathological tick. */
  stepMinutesFor?: () => number;
  /** Makes the shift port's clockOut throw, as it does when a stopWorkSession fails. */
  clockOutFails?: boolean;
  /** Makes a job's suspendLabor throw, as a refused stopLaborSession does. */
  suspendFails?: boolean;
  /** Makes the appointment port's book throw, as a refused createAppointment does. */
  bookFails?: Error;
  /** Makes the appointment port's convertDue throw. */
  convertFails?: Error;
  /** Makes the shift port's clockIn throw, as a refused startWorkSession does. */
  clockInFails?: Error;
  /** Makes the weekly cycle count throw, as a refused approval does. */
  cycleCountFails?: Error;
  /**
   * Virtual minutes each clock read costs. Free reads hide a whole class of defect: a
   * loop that re-reads at entry can then never find the bound already past.
   */
  readCostMinutes?: number;
  finish?: JobOutcome;
  jobLimit?: number;
}): Harness => {
  const clock = fakeClock(options.startIso);
  const ledger = new ResourceLedger();
  const jobs: FakeJob[] = [];
  const calls: string[] = [];
  /** The virtual instant each phase was handed, so the tests can pin when it ran. */
  const at_: Record<string, Date | undefined> = {};
  const shiftOpen = { value: false };
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
        if (options.clockInFails) {
          throw options.clockInFails;
        }
        shiftOpen.value = true;
        at_.clockIn = at;
        clock.advance(options.phaseCostMinutes ?? 0);
        return ['tech-a', 'tech-b'];
      },
      clockOut: async (at: Date) => {
        calls.push('clockOut');
        if (options.clockOutFails) {
          throw new Error('[accel] 1 of 2 session(s) could not be closed (stopWorkSession tech-b failed: HTTP 500)');
        }
        shiftOpen.value = false;
        at_.clockOut = at;
        // What the clock actually said. `at` is clamped to the grace limit, so asserting
        // on it alone is vacuous — any overshoot is clamped back into legality before a
        // test can see it, which is how the cycle-2 assertion passed on an illegal value.
        at_.clockOutObserved = clock.peek();
        // The fan-out itself costs virtual time, and the backend stamps each entry as its
        // own `stopWorkSession` runs — so the last person's stamp is this, not the instant
        // the fan-out began. Asserting on the pre-cost instant leaves the margin claim
        // untested.
        clock.advance(options.phaseCostMinutes ?? 0);
        at_.clockOutFinished = clock.peek();
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
        if (options.cycleCountFails) {
          throw options.cycleCountFails;
        }
      },
      restock: async (at: Date) => {
        calls.push('restock');
        at_.restock = at;
      },
    },
    appointments: {
      book: async () => {
        calls.push('bookAppointments');
        clock.advance(options.phaseCostMinutes ?? 0);
        if (options.bookFails) {
          throw options.bookFails;
        }
        return 2;
      },
      convertDue: async () => {
        calls.push('convertAppointments');
        clock.advance(options.phaseCostMinutes ?? 0);
        if (options.convertFails) {
          throw options.convertFails;
        }
        return 1;
      },
    },
    now: async () => {
      const value = await clock.now();
      clock.advance(options.readCostMinutes ?? 0);
      return value;
    },
    waitUntil: async (target: Date) => clock.waitUntil(target, options.waitOvershootMinutes ?? 0),
    createJob: (claim) => {
      if (options.jobLimit !== undefined && jobs.length >= options.jobLimit) {
        return null;
      }
      const job = new FakeJob(
        // Numbered across the whole run, not within the day, mirroring the real
        // `jobSequence` in acceleratedRun. Using the per-day index gave day two's first
        // job the same label — and so the same fake workorder id — as day one's, which
        // made a genuinely new job look like a duplicate record of an old one.
        `job-${jobs.length + 1}-${claim.position.id}`,
        (options.jobKind ?? claim.position.kind) === 'BAY',
        options.jobSteps ?? 2,
        clock,
        options.stepMinutesFor ?? (options.stepMinutes ?? 30),
        options.finish,
      );
      job.onTheClock = () => shiftOpen.value;
      job.suspendFails = options.suspendFails ?? false;
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
  it('clocks out inside the grace, not at midnight, even with mobile work still to do', async () => {
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
    const observed = at.clockOutObserved as Date;
    expect(clockOut).toBeDefined();
    const calendar = new ShopCalendar(spec());

    // The instant the clock really stood at, not the clamped argument: the backend stamps
    // the entry from its own clock, so this is the value the end-of-run audit will judge.
    expect(calendar.withinGrace(observed, 'BAY')).toBe(true);
    // And the clamp did not have to fire — if it did, the real clock-out was already
    // illegal and only the reported instant was legal.
    expect(observed.getTime()).toBe(clockOut.getTime());
    expect(observed.toISOString().slice(0, 10)).toBe('2025-11-03');
  });

  it('finishes a started bay job in the grace even with after-hours mobile work switched off', async () => {
    // The grace belongs to the mechanic finishing a car, not to the mobile flag. Before
    // this, bay jobs only advanced past close because the after-hours mobile stretch
    // pulled them along, so with the flag off nothing ever used the grace and
    // `mayWorkNow`'s grace branch was dead code.
    const { runner, jobs, calls } = harness({
      startIso: '2025-11-03T17:45:00Z',
      stepMinutes: 15,
      jobSteps: 3,
      jobsToday: 1,
      concurrency: 1,
      calendar: spec({ mobileAfterHours: false }),
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    const report = await runner.runDay(1);

    expect(report.workordersCompleted).toBe(1);
    const lastStep = jobs[0].ranAt[jobs[0].ranAt.length - 1];
    // Past close, and inside the grace.
    expect(lastStep.getTime()).toBeGreaterThanOrEqual(Date.parse('2025-11-03T18:00:00Z'));
    expect(new ShopCalendar(spec()).withinGrace(lastStep, 'BAY')).toBe(true);
    expect(calls).toContain('clockOut');
  });

  it('keeps the mechanic on the clock while the car is finished', async () => {
    // The grace stretch runs BEFORE clock-out, so the labor and the payroll entry agree
    // about who was working. Half the grace is the stretch; the rest is margin for the
    // overshooting tick and the clock-out fan-out.
    const { runner, jobs, at } = harness({
      startIso: '2025-11-03T17:45:00Z',
      stepMinutes: 15,
      jobSteps: 3,
      jobsToday: 1,
      concurrency: 1,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    await runner.runDay(1);

    const lastStep = jobs[0].ranAt[jobs[0].ranAt.length - 1];
    const observed = at.clockOutObserved as Date;
    // Work finished first, then the shift closed — and the close is still legal.
    expect(observed.getTime()).toBeGreaterThanOrEqual(lastStep.getTime());
    expect(new ShopCalendar(spec()).withinGrace(observed, 'BAY')).toBe(true);
    expect(observed.getTime()).toBe((at.clockOut as Date).getTime());
  });

  it('refuses a step it predicts would push the shift past the grace', async () => {
    // A bound checked only BETWEEN steps is a bound exceeded BY a step. With 90-minute
    // steps, the first tick ends at 18:01 and the grace stretch would take one more —
    // landing 19:31, past the 19:30 limit — unless the loop predicts the cost and stops.
    // The feasibility guard admits steps larger than the whole grace, so this is not a
    // contrived size.
    const { runner, at } = harness({
      startIso: '2025-11-03T16:31:00Z',
      stepMinutes: 90,
      jobSteps: 6,
      jobsToday: 1,
      concurrency: 1,
      phaseCostMinutes: 5,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    await runner.runDay(1);

    const calendar = new ShopCalendar(spec());
    const finished = at.clockOutFinished as Date;
    expect(finished).toBeDefined();
    // The worst-case stamp — the fan-out's last call — is still inside the grace.
    expect(calendar.withinGrace(finished, 'BAY')).toBe(true);
    expect(finished.getTime()).toBeLessThan(Date.parse('2025-11-03T19:30:00Z'));
  });

  it('does not spend the shift\'s payroll margin on carried mobile work', async () => {
    // Mobile work has its own stretch, after clock-out and off the clock. Running it in
    // the grace delays the clock-out for work that never needed the margin.
    const { runner, at, jobs } = harness({
      startIso: '2025-11-03T17:50:00Z',
      stepMinutes: 20,
      jobSteps: 12, // will not finish, so it is carried at close
      jobsToday: 1,
      concurrency: 1,
      phaseCostMinutes: 0,
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    await runner.runDay(1);

    // Asserted on whether the stretch ran at all, not on the resulting instant: with the
    // tick prediction in place, the old `carried.length > 0` gate also produced a clock-out
    // before 18:45, so an instant assertion passed either way and pinned nothing.
    const observed = at.clockOutObserved as Date;
    const steppedInGrace = jobs.some((job) =>
      job.ranAt.some(
        (ranAt) => ranAt.getTime() >= Date.parse('2025-11-03T18:00:00Z') && ranAt.getTime() < observed.getTime(),
      ),
    );
    expect(steppedInGrace).toBe(false);
  });

  it('does not let one expensive tick starve the days that follow', async () => {
    // The tick estimate is per day, not per run. Kept for the run's lifetime it only grew,
    // so a single pathological tick — one slow replication wait — refused every later short
    // stretch: the shop clocked in, refused every tick, clocked out minutes later, and did
    // the work off the clock instead. Zero completions, and nothing reported as a failure.
    let costMinutes = 840; // day 1: one 14-hour tick
    const { runner, clock, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutesFor: () => costMinutes,
      jobSteps: 3,
      jobsToday: 2,
      concurrency: 1,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    const first = await runner.runDay(1);
    expect(first.workordersCompleted).toBe(0); // the one huge tick eats the day

    costMinutes = 20;
    clock.set('2025-11-04T08:00:00Z');
    const second = await runner.runDay(2);

    // Recovered: the estimate does not carry yesterday's worst tick into today.
    expect(second.workordersCompleted).toBeGreaterThan(0);
    expect(jobs.length).toBeGreaterThan(1);
  });

  it('never advances a bay job off the clock', async () => {
    // The after-hours stretch is mobile-only for *advancement*, not just intake. `kindLimit`
    // used to gate only new claims, so the step the grace stretch refused ran here instead —
    // off the clock, past the grace, with the labor recorded against a closed shift.
    const { runner, jobs } = harness({
      startIso: '2025-11-03T16:30:00Z',
      stepMinutes: 90,
      jobSteps: 6,
      jobsToday: 2,
      concurrency: 1,
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

    const bayJobs = jobs.filter((job) => job.gatedByHours);
    expect(bayJobs.length).toBeGreaterThan(0);
    for (const job of bayJobs) {
      expect(job.ranOnTheClock.every((onClock) => onClock)).toBe(true);
    }
  });

  it('reports a clock-out that left someone on the clock as a failed day', async () => {
    // A swallowed clock-out failure is silent at the level that matters: the open entry
    // has no endAtUtc, the audit skips it, and the day passes. This was a regression —
    // before the parallel fan-out, the failure threw and the day failed loudly.
    const { runner } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 2,
      jobsToday: 1,
      concurrency: 1,
      clockOutFails: true,
    });

    const report = await runner.runDay(1);

    expect(report.failures.some((failure) => /could not be closed/.test(failure))).toBe(true);
  });

  it('stops every running labor clock at closing time', async () => {
    // The backend subtracts a labor entry's two stamps and knows nothing about opening
    // hours, so an entry left open at close books the night as worked. This is the guard
    // against a multi-day job reporting 30 hours for two days of work.
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 40,
      jobsToday: 1,
      concurrency: 1,
    });

    const report = await runner.runDay(1);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].outcome).toBe('in-progress');
    expect(jobs[0].laborOpen).toBe(false);
    expect(jobs[0].laborSuspendedAt).toHaveLength(1);
    expect(report.laborSuspended).toBe(1);
  });

  it('stops the labor clock again after the after-hours mobile stretch', async () => {
    // Mobile work advances past the shift close, and advancing puts the clock back on.
    // Left there it would run through the night into tomorrow's close — a mobile unit
    // works any hour, not every hour. Two suspends in one day is the correct shape.
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 40,
      jobsToday: 1,
      concurrency: 1,
      jobKind: 'MOBILE_UNIT',
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    const report = await runner.runDay(1);

    expect(jobs[0].laborOpen).toBe(false);
    expect(report.laborSuspended).toBeGreaterThanOrEqual(2);
  });

  it('reports a labor clock that would not stop, and still closes payroll', async () => {
    // A throw here would skip the payroll close that follows it, turning one lost labor
    // record into a whole day off the books.
    const { runner, jobs, calls } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 40,
      jobsToday: 1,
      concurrency: 1,
      suspendFails: true,
    });

    const report = await runner.runDay(1);

    expect(jobs[0].laborOpen).toBe(true);
    expect(report.laborSuspended).toBe(0);
    expect(report.failures.some((failure) => /could not stop its labor clock/.test(failure))).toBe(true);
    expect(calls).toContain('clockOut');
    expect(calls).toContain('approveTime');
  });

  it('attaches each workorder to the claim working it, and records how it was worked', async () => {
    // Without the attach, ClosedHold.workorderId stays undefined for the whole run, the
    // end-of-run labor audit can classify nothing, every job falls back to BAY, and every
    // legitimate mobile-unit span is reported as a violation.
    const { runner, ledger, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 1,
      jobsToday: 1,
      concurrency: 1,
      jobKind: 'MOBILE_UNIT',
      rosters: [
        roster({
          freePositions: [{ kind: 'MOBILE_UNIT', id: 'mu-1', name: 'MU-01' }],
          idleTechnicianIds: ['tech-a'],
        }),
      ],
    });

    const report = await runner.runDay(1);
    const workorderId = jobs[0].workorderId as string;

    expect(workorderId).toBeDefined();
    expect(report.workorderIds).toEqual([workorderId]);
    expect(report.workorderKinds[workorderId]).toBe('MOBILE_UNIT');
    // The hold outlives the claim, and is where the audit reads the kind from.
    const hold = ledger.closedHolds().find((closed) => closed.workorderId === workorderId);
    expect(hold?.kind).toBe('MOBILE_UNIT');
  });

  it('records a workorder that is still carried when the day ends', async () => {
    // These are the jobs most likely to be holding a labor entry open, and recording ids
    // only at settle excluded exactly them: a run that stops on a converged clock or a
    // spent budget leaves its carried work unaudited.
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 40,
      jobsToday: 1,
      concurrency: 1,
    });

    const report = await runner.runDay(1);

    expect(jobs[0].outcome).toBe('in-progress');
    expect(report.carriedOut).toBe(1);
    expect(report.workorderIds).toEqual([jobs[0].workorderId]);
  });

  it('records a workorder whose job then failed', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 1,
      jobsToday: 1,
      concurrency: 1,
      finish: 'failed',
    });

    const report = await runner.runDay(1);

    expect(report.workordersFailed).toBe(1);
    expect(report.workorderIds).toEqual([jobs[0].workorderId]);
  });

  it('records each workorder once however many days it is worked over', async () => {
    const { runner, jobs } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      jobSteps: 40,
      jobsToday: 1,
      concurrency: 1,
    });

    const first = await runner.runDay(1);
    const second = await runner.runDay(2);

    expect(first.workorderIds).toEqual([jobs[0].workorderId]);
    // Day two inherits the same job. It is already recorded and must not be recorded
    // again, because the journal's id list is what the audit iterates; the only new id
    // there is day two's own new job.
    expect(second.workorderIds).not.toContain(jobs[0].workorderId);
  });

  it('has no labor clock to stop when nothing was worked', async () => {
    const { runner } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 30, jobLimit: 0 });

    const report = await runner.runDay(1);

    expect(report.laborSuspended).toBe(0);
  });

  it('refuses the grace stretch an unpredicted first tick', async () => {
    // The reachable path: a bay job carried in from yesterday, and today's in-hours loop
    // exits with zero ticks because its entry read lands past the work bound (clock reads
    // cost virtual time at scale). The estimate is then zero at the grace stretch, which
    // has carried bay work and nothing to predict from. `allowFirst` was meant to make the
    // in-hours loop the only place that takes an unpredicted tick, but the arithmetic
    // already answered false for a zero estimate, so the parameter was a no-op and the
    // grace stretch took a 120-minute tick — past the limit.
    //
    // Day 2 starts at 17:52 with 5-minute reads: schedule read 17:52, post-phase read
    // 17:57 (work bound 18:00 still ahead), in-hours entry read 18:02 — past it, zero
    // ticks. Grace entry read 18:07: inside the grace, estimate zero.
    const { runner, clock, jobs, at } = harness({
      startIso: '2025-11-03T17:00:00Z',
      stepMinutes: 120,
      jobSteps: 6,
      jobsToday: 1,
      concurrency: 1,
      readCostMinutes: 5,
      rosters: [roster({ freePositions: [{ kind: 'BAY', id: 'bay-1', name: 'Bay 01' }], idleTechnicianIds: ['tech-a'] })],
    });

    const first = await runner.runDay(1);
    expect(first.carriedOut).toBe(1);

    clock.set('2025-11-04T17:52:00Z');
    const stepsBefore = jobs[0].ranAt.length;
    await runner.runDay(2);

    const calendar = new ShopCalendar(spec());
    // No step was taken today: the in-hours loop had no room and the grace stretch had no
    // estimate. Pre-fix, one landed at 18:07 and the shift ended at 20:12.
    expect(jobs[0].ranAt.length).toBe(stepsBefore);
    expect(calendar.withinGrace(at.clockOutFinished as Date, 'BAY')).toBe(true);
  });

  it('reports a day whose window closed before work could start, rather than a quiet success', async () => {
    // SHIFT-IN and the appointment phases are gateway calls, and at a high scale a
    // handful of them is virtual hours. If the window has gone by the time work is due
    // to start, the day must say so — previously it reported a successful day with
    // `clockedIn > 0` and nothing done, which Z3 and Z4 both pass.
    const { runner, calls } = harness({
      startIso: '2025-11-03T17:55:00Z',
      stepMinutes: 15,
      jobsToday: 2,
      concurrency: 1,
      // The shift phases themselves consume the rest of the window.
      phaseCostMinutes: 10,
    });

    const report = await runner.runDay(1);

    expect(report.failures[0]).toMatch(/open window had already closed/);
    expect(report.workordersCompleted).toBe(0);
    // The people who were clocked in are still clocked out.
    expect(calls).toContain('clockIn');
    expect(calls).toContain('clockOut');
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

  it('names a site whose positions are free but whose technicians are all busy', async () => {
    // An exhausted roster and a quiet day look identical from the outside: the
    // ledger just returns no claim. A previous run that failed after
    // assign-technician leaves those people bound to workorders, and every later
    // day reads them as busy — so the shortage is reported rather than absorbed.
    const { runner } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      rosters: [roster({ idleTechnicianIds: [], busyTechnicianIds: ['tech-a', 'tech-b'] })],
    });

    const report = await runner.runDay(1);

    const line = report.failures.find((entry) => entry.includes('no idle technician'));
    expect(line).toBeDefined();
    expect(line).toContain('CLT-MAIN-001');
    expect(line).toContain('3 position(s) free');
    expect(line).toContain('2 technician(s) busy');
  });

  it('records a day with no usable board as a failure rather than a quiet success', async () => {
    const { runner } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 10, rosters: [] });

    const report = await runner.runDay(1);

    expect(report.failures[0]).toMatch(/no site reported a usable dispatch board/);
    expect(report.workordersCompleted).toBe(0);
  });
});

describe('AcceleratedDayRunner — which phase may end a year', () => {
  it('reports a refused booking and works the day anyway', async () => {
    // The shape that killed a run: one 409 from pos-shop-manager at the second
    // call of the day, before any work was attempted.
    const { runner } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      bookFails: new Error('409 SCHEDULING_CONFLICT'),
    });

    const report = await runner.runDay(1);

    expect(report.failures.some((line) => line.includes('booking appointments failed'))).toBe(true);
    expect(report.failures.some((line) => line.includes('409 SCHEDULING_CONFLICT'))).toBe(true);
    expect(report.appointmentsBooked).toBe(0);
    // The day still ran: the shift opened, jobs were worked, the shift closed.
    expect(report.clockedIn).toBeGreaterThan(0);
    expect(report.workordersCompleted).toBeGreaterThan(0);
  });

  it('reports a refused conversion and still books', async () => {
    const { runner, calls } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      convertFails: new Error('the bridge answered 500'),
    });

    const report = await runner.runDay(1);

    expect(report.failures.some((line) => line.includes('converting due appointments failed'))).toBe(true);
    expect(report.appointmentsConverted).toBe(0);
    // The phase after it is not skipped by the one before it failing.
    expect(calls).toContain('bookAppointments');
    expect(report.appointmentsBooked).toBe(2);
  });

  it('keeps what a half-finished batch did, rather than reporting none of it', async () => {
    // book pushes each appointment before attempting the next, so two of five are
    // on the backend when the third is refused. Reporting 0 would undercount the
    // year against its own data.
    const { runner } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      bookFails: new PartialProgressError('booking stopped after 2 of 5: 409', 2),
    });

    const report = await runner.runDay(1);

    expect(report.appointmentsBooked).toBe(2);
    expect(report.failures.some((line) => line.includes('failed after 2 succeeded'))).toBe(true);
  });

  it('reports a refused cycle count and finishes the day, rather than ending the year', async () => {
    // Virtual day 7 is a counting day, and a 403 on the approval there ended a run
    // that had six good days and twenty-two workorders behind it.
    const { runner } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      cycleCountFails: new Error('approveCycleCountAdjustment failed: HTTP 403'),
    });

    const report = await runner.runDay(7);

    expect(report.failures.some((line) => line.includes('the weekly cycle count failed'))).toBe(true);
    expect(report.failures.some((line) => line.includes('403'))).toBe(true);
    // Attempted, not done: the flag says the count happened, and it did not.
    expect(report.cycleCount).toBe(false);
    expect(report.workordersCompleted).toBeGreaterThan(0);
  });

  it('marks the cycle count done when it succeeds', async () => {
    const { runner } = harness({ startIso: '2025-11-03T08:00:00Z', stepMinutes: 30 });

    const report = await runner.runDay(7);

    expect(report.cycleCount).toBe(true);
    expect(report.failures.filter((line) => line.includes('cycle count'))).toEqual([]);
  });

  it('still ends the day when the shift cannot be opened, because that is not a day', async () => {
    // The deliberate asymmetry: a shop that cannot staff itself writes no labor and
    // no payroll, and carrying on would record a day nobody worked.
    const { runner } = harness({
      startIso: '2025-11-03T08:00:00Z',
      stepMinutes: 30,
      clockInFails: new Error('[accel] 3 of 7 could not be clocked in'),
    });

    await expect(runner.runDay(1)).rejects.toThrow(/could not be clocked in/);
  });
});
