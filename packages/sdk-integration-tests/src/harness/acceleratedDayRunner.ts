/**
 * One virtual day of shop activity, and the phases it goes through.
 *
 * The seeder's DailyLoopRunner does the same job for a generator: it works
 * whatever hour the loop reaches and tolerates whatever fails. This one is
 * driven by the clock instead of by iteration count, refuses to work outside the
 * shop's hours, and returns a report the caller asserts against.
 *
 * Every collaborator is injected — clock, timer, calendar, ledger, discovery,
 * job factory — so the phase ordering, the gating and the carry-over rules are
 * unit-testable without a backend. The one thing this file must get right is
 * *when* things happen; what happens is in AcceleratedJob, and which resources
 * are free is in ResourceLedger.
 */
import type { ShopCalendar } from './shopCalendar';
import { clampToGrace, daySchedule, type DaySchedule } from './daySchedule';
import type { Claim, ResourceLedger } from './resourceLedger';
import type { PositionKind, SiteRoster } from '../runs/shopFloorPlan';
import type { JobOutcome } from './acceleratedJob';
import { ClockConvergedError } from './virtualClock';

/** What the runner needs of a job — the real AcceleratedJob satisfies it. */
export interface RunnableJob {
  readonly label: string;
  /** Which kind of position the job is working — a stretch can be limited to one. */
  readonly kind: PositionKind;
  readonly gatedByHours: boolean;
  readonly outcome: JobOutcome;
  readonly failure: string | undefined;
  readonly nextStep: string;
  readonly workorderId: string | undefined;
  readonly invoiceId: string | undefined;
  readonly invoiceTotal: number | undefined;
  readonly paid: boolean;
  /** True while the mechanic's labor clock is running on this job. */
  readonly laborOpen: boolean;
  /**
   * Stops that clock because the shop is closing, leaving the job free to resume.
   *
   * The backend computes a labor entry's hours by subtracting its two stamps and
   * knows nothing about opening hours, so a session left open overnight books the
   * night as worked. Suspending at close and resuming on the next advance is what
   * keeps a multi-day job's total to the hours the shop was actually open.
   */
  suspendLabor(): Promise<void>;
  advance(): Promise<JobOutcome>;
}

/** What the runner needs of the shift clock — people, not workorders. */
export interface ShiftPort {
  /** Clocks in the day's staff; returns the person ids that are now on the clock. */
  clockIn(at: Date): Promise<string[]>;
  clockOut(at: Date): Promise<string[]>;
  /** Submits and approves the day's time entries. */
  approveTime(at: Date): Promise<void>;
}

export interface MaintenancePort {
  /**
   * Weekly cycle count. `onApproved` hears each adjustment as it is approved, so a
   * count that fails part-way still reports the ones already on the ledger.
   */
  cycleCount(at: Date, onApproved?: (adjustmentId: string) => void): Promise<void>;
  /** Monthly restock. */
  restock(at: Date): Promise<void>;
  /** Ten-daily write-off of damaged or lost stock. */
  scrap(at: Date): Promise<void>;
}

/**
 * A refusal that arrived part-way through a batch, carrying what was already done.
 *
 * `book` and `convertDue` work an item at a time and each successful one is on the
 * backend before the next is attempted. Raising a bare error loses that count, and
 * the day, the journal and the run's totals then undercount records that exist —
 * the run would report 0 appointments on a day it booked two.
 *
 * So a port that got some of the way through says so, and the runner records the
 * failure *and* the progress.
 */
export class PartialProgressError extends Error {
  constructor(
    message: string,
    /** How many items the port completed before the refusal. */
    readonly completed: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PartialProgressError';
  }
}

export interface AppointmentPort {
  /**
   * Books appointments for future open windows; returns how many were booked.
   *
   * Throws {@link PartialProgressError} when some were booked before the refusal,
   * so the count is not lost with the failure.
   */
  book(at: Date, count: number): Promise<number>;
  /**
   * Converts every appointment whose start the clock has now reached into an
   * estimate; returns how many were converted. Throws
   * {@link PartialProgressError} when some were converted before the refusal.
   */
  convertDue(at: Date): Promise<number>;
}

export interface DiscoveryPort {
  /** Each site's board and staffing as they stand now. */
  rosters(at: Date): Promise<SiteRoster[]>;
}

export interface DayRunnerDeps {
  calendar: ShopCalendar;
  ledger: ResourceLedger;
  discovery: DiscoveryPort;
  shift: ShiftPort;
  maintenance: MaintenancePort;
  appointments: AppointmentPort;
  /** Authoritative virtual time. */
  now: () => Promise<Date>;
  /** Blocks until the virtual clock reaches an instant. */
  waitUntil: (target: Date, description?: string) => Promise<void>;
  /** Builds a job against a claim; null when the run should not start another. */
  createJob: (claim: Claim, index: number) => RunnableJob | null;
  concurrency: number;
  /** Customers to attempt on an open day, chosen per day by the caller. */
  jobsToday: (at: Date) => number;
  log?: (message: string) => void;
}

export interface DayReport {
  dayNumber: number;
  virtualDate: string;
  /** Set when nothing was worked, and why. */
  skipped?: 'closed' | 'sampled-out' | 'window-missed';
  workordersCompleted: number;
  workordersFailed: number;
  invoicesFinalized: number;
  invoicesPaid: number;
  estimatesDeclined: number;
  appointmentsBooked: number;
  appointmentsConverted: number;
  /** Jobs inherited from the previous day, still holding their bay. */
  carriedIn: number;
  /** Jobs handed to the next day, still holding their bay. */
  carriedOut: number;
  cycleCount: boolean;
  restock: boolean;
  scrap: boolean;
  clockedIn: number;
  /** Labor clocks stopped at closing time, to resume tomorrow. */
  laborSuspended: number;
  failures: string[];
  /** Ids created, for the journal and the by-runId retrieval afterwards. */
  workorderIds: string[];
  /**
   * How each of those workorders was worked.
   *
   * Carried alongside the ids because the end-of-run labor audit has to know which
   * spans may fall outside the shop's window, and by then the claim that knew is
   * gone — possibly with the whole process, on a resumed run.
   */
  workorderKinds: Record<string, PositionKind>;
  invoiceIds: string[];
  /** Cycle-count adjustments approved today, for the year-end GL reconciliation. */
  cycleCountAdjustmentIds: string[];
}

interface ActiveJob {
  job: RunnableJob;
  claim: Claim;
}

const EMPTY_REPORT = (dayNumber: number, virtualDate: string): DayReport => ({
  dayNumber,
  virtualDate,
  workordersCompleted: 0,
  workordersFailed: 0,
  invoicesFinalized: 0,
  invoicesPaid: 0,
  estimatesDeclined: 0,
  appointmentsBooked: 0,
  appointmentsConverted: 0,
  carriedIn: 0,
  carriedOut: 0,
  cycleCount: false,
  restock: false,
  scrap: false,
  clockedIn: 0,
  laborSuspended: 0,
  failures: [],
  workorderIds: [],
  workorderKinds: {},
  invoiceIds: [],
  cycleCountAdjustmentIds: [],
});

export class AcceleratedDayRunner {
  /** Jobs that outlived a previous day, still holding their position. */
  private carried: ActiveJob[] = [];

  /**
   * The most virtual time a single tick has cost **today**, used to refuse a tick that
   * would cross a bound.
   *
   * A bound checked only *between* ticks is a bound exceeded *by* a tick, and at a
   * thousandfold scale one tick can be virtual hours: the feasibility guard admits steps
   * up to half the shortest open window, which is more than the whole grace.
   *
   * Reset every virtual day, and that is the important part. Kept for the lifetime of the
   * run it only grew, so a single pathological tick — one slow replication wait on day 1 —
   * permanently refused every later short stretch: the shop clocked in, refused every
   * tick, clocked out three minutes later, and did the day's work off the clock in the
   * after-hours stretch instead. Zero completions, no failure reported. Starving is not a
   * better failure than overshooting.
   */
  private maxTickVirtualMs = 0;

  /**
   * Would another tick cross `until`, judged by the most expensive one seen today?
   *
   * `allowFirst` guarantees progress where progress is mandatory: the in-hours loop must
   * take at least one tick or the day does nothing at all. The grace stretch passes false,
   * because refusing there is the correct answer — the job simply carries to tomorrow.
   */
  private tickWouldOvershoot(now: Date, until: Date, allowFirst = false): boolean {
    if (this.maxTickVirtualMs === 0) {
      // Nothing to predict from yet. The in-hours loop takes the tick regardless — the
      // day must do something — but the grace stretch refuses: an unbounded first tick
      // there can cross the grace limit, which is the one thing that stretch must never
      // do. Written as an explicit branch because the arithmetic below already answered
      // false for a zero estimate, which made the asymmetry this parameter documents a
      // no-op and gave the grace stretch a free tick whenever nothing had ticked today.
      return !allowFirst;
    }
    return now.getTime() + this.maxTickVirtualMs > until.getTime();
  }

  /** Records what a tick cost, for the prediction above. */
  private recordTickCost(before: Date, after: Date): void {
    const cost = after.getTime() - before.getTime();
    if (cost > this.maxTickVirtualMs) {
      this.maxTickVirtualMs = cost;
    }
  }

  constructor(private readonly deps: DayRunnerDeps) {}

  get carriedCount(): number {
    return this.carried.length;
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  /**
   * Works one virtual day.
   *
   * `sampled` false means the run is stepping over this day (ITEST_ACCEL_SAMPLE_EVERY):
   * the day is still reported, and carried work is *still advanced*, because a car
   * already on a bay does not stop being worked on because the run is thinning its
   * new intake.
   */
  async runDay(dayNumber: number, options: { sampled?: boolean } = {}): Promise<DayReport> {
    const sampled = options.sampled ?? true;
    // Today's tick costs, not the run's. See maxTickVirtualMs.
    this.maxTickVirtualMs = 0;
    // One reading, one consistent set of bounds derived from it. Re-derived after
    // anything that costs virtual time — see daySchedule.ts for why the bounds are no
    // longer computed one at a time where they are used.
    let schedule = daySchedule(await this.deps.now(), this.deps.calendar);
    const report = EMPTY_REPORT(dayNumber, schedule.observedAt.toISOString().slice(0, 10));
    report.carriedIn = this.carried.length;

    // A day with no bay window is not skipped silently. The bays are shut, but mobile
    // units take work at any hour, so such a day still *starts* mobile jobs as well as
    // advancing carried ones — otherwise "mobile units work any time" would mean nothing
    // more than "carried mobile work finishes", and a virtual weekend would be two days
    // of dead air.
    //
    // No shift is opened: a mobile crew turning out on a Sunday is on call, not on the
    // shop's clock, and clocking anyone in would put a payroll entry outside the shop's
    // hours — the very thing the end-of-run audit asserts against. Maintenance does not
    // run either; it is floor work.
    if (schedule.blocker === 'closed') {
      return this.runWithoutShift(dayNumber, report, schedule, sampled, 'closed');
    }

    // WAIT-OPEN. Carried mobile work is advanced while waiting, which is what makes an
    // out-of-hours stretch productive instead of dead air.
    if (!schedule.openNow && schedule.opensAt !== null) {
      const opensAt = schedule.opensAt;
      await this.advanceCarriedOnly(report, opensAt);
      await this.deps.waitUntil(opensAt, `the shop to open on ${report.virtualDate}`);
      // The wait can cross midnight, and can overshoot the window it waited for, so the
      // whole set is taken again rather than patched.
      schedule = daySchedule(await this.deps.now(), this.deps.calendar);
      report.virtualDate = schedule.observedAt.toISOString().slice(0, 10);
      if (!schedule.openNow) {
        // Waited, and still not open: the wait overshot its window, or landed on a date
        // the shop does not open at all. Only this caller knows a wait happened, which is
        // why the distinction is drawn here and not in the schedule.
        return this.runWithoutShift(
          dayNumber,
          report,
          schedule,
          sampled,
          schedule.blocker === 'closed' ? 'closed' : 'window-missed',
        );
      }
    }

    if (!sampled) {
      report.skipped = 'sampled-out';
      this.log(`day ${dayNumber} (${report.virtualDate}) — sampled out; advancing ${this.carried.length} carried job(s)`);
      await this.advanceCarriedOnly(report, schedule.dayEnd);
      report.carriedOut = this.carried.length;
      return report;
    }

    // RECONCILE. Anything the board reports as occupied starts the day held, including
    // records left open by a previous day, a previous run or the seeder.
    const rosters = await this.deps.discovery.rosters(schedule.observedAt);
    for (const roster of rosters) {
      this.deps.ledger.reconcile(roster);
    }
    if (rosters.length === 0) {
      report.failures.push('no site reported a usable dispatch board — nothing could be worked');
      report.carriedOut = this.carried.length;
      return report;
    }
    this.log(
      `day ${dayNumber} (${report.virtualDate}) — ${rosters.length} site(s), ` +
        rosters.map((r) => `${r.code}: ${r.freePositions.length} free/${r.idleTechnicianIds.length} idle`).join(', '),
    );

    // A site with bays free and nobody to staff them is reported, not passed over.
    //
    // The ledger simply returns no claim in that case, so the day plans less work
    // and looks like a quiet one. That is indistinguishable from a genuinely light
    // day, and it is what an exhausted roster looks like: a previous run that
    // failed after `assign-technician` leaves those people bound to workorders,
    // and every later day reads them as busy. Saying so is the difference between
    // a run that reports a shortage and one that hides it.
    const unstaffed = rosters.filter(
      (roster) => roster.freePositions.length > 0 && roster.idleTechnicianIds.length === 0,
    );
    if (unstaffed.length > 0) {
      report.failures.push(
        `no idle technician at ${unstaffed.map((r) => `${r.code} (${r.freePositions.length} position(s) free, ` +
          `${r.busyTechnicianIds.length} technician(s) busy)`).join(', ')} — ` +
          'work cannot be placed there today',
      );
    }

    // SHIFT-IN.
    const clockedIn = await this.deps.shift.clockIn(schedule.observedAt);
    report.clockedIn = clockedIn.length;

    // APPOINTMENTS. Booked ahead, and converted when the clock reaches them — which only
    // an accelerated clock makes possible inside one run.
    //
    // Reported rather than thrown, unlike the clock-in above. A day that cannot book
    // its intake is a bad day; a day that cannot staff itself is not a day at all, and
    // the difference decides whether a year survives. Left fatal, one 409 from
    // pos-shop-manager on virtual day 40 ended a run that had already worked 39 good
    // days — and did it at the *second* call of the day, before any work was attempted.
    // The failure still lands in `report.failures`, so Z2 fails the year at the end:
    // this changes when the run stops, not whether the problem is reported.
    report.appointmentsConverted = await this.guard(report, 'converting due appointments', () =>
      this.deps.appointments.convertDue(schedule.observedAt),
    );
    report.appointmentsBooked = await this.guard(report, 'booking appointments', () =>
      this.deps.appointments.book(schedule.observedAt, rosters.length),
    );

    // The shift and the appointment phases are gateway calls, and at a thousandfold scale
    // a handful of those is virtual hours. The bounds work runs against come from *after*
    // them.
    schedule = daySchedule(await this.deps.now(), this.deps.calendar);
    if (schedule.workBound === null) {
      report.failures.push(
        `the open window had already closed by ${schedule.observedAt.toISOString()} when work was due to ` +
          'start — opening the shift and booking appointments cost more virtual time than the window had ' +
          'left. Lower pos.time.accelerated.scale, or widen ITEST_ACCEL_OPEN_TIME / _CLOSE_TIME.',
      );
      await this.closeShift(report, schedule);
      report.carriedOut = this.carried.length;
      return report;
    }

    // WORK, inside the hours, bounded at bay close.
    const target = this.deps.jobsToday(schedule.observedAt);
    const worked = await this.workUntil(report, schedule.workBound, { rosters, target });

    // FINISH THE CAR. A job already started may finish past close, on the clock, up to
    // half the grace — the remainder covers the overshooting tick and the clock-out
    // fan-out, so the shift still ends inside the grace. No *new* bay work starts here,
    // and this stretch runs whatever ITEST_ACCEL_MOBILE_AFTER_HOURS says: the grace
    // belongs to the mechanic finishing a car, not to the mobile flag.
    // Gated on carried *bay* work. A mobile job is never gated by the hours and has its
    // own stretch below, after clock-out — running it here would spend the shift's
    // remaining payroll margin on work that did not need it.
    if (schedule.graceWorkBound !== null && this.carried.some((entry) => entry.job.gatedByHours)) {
      // 'BAY' for advancement as well: a carried mobile job stepped here spends the
      // shift's payroll margin on work that has its own stretch after clock-out.
      await this.advanceCarriedOnly(report, schedule.graceWorkBound, 'BAY');
    }

    // SHIFT-OUT, at the end of the worked window rather than at midnight.
    const shiftClosedAt = await this.closeShift(report, schedule);

    // MAINTENANCE, on the due virtual day of the run.
    //
    // Recorded rather than thrown, for the reason the appointment phases are. A
    // weekly count the manager cannot approve is a bad week, not the end of the
    // year — and left fatal it was exactly that: `approveCycleCountAdjustment`
    // answered 403 on virtual day 7 and ended a run that had six good days and
    // twenty-two workorders behind it (durion-positivity-backend#2149).
    //
    // `report.cycleCount` says the count was *done*, so it stays false when the
    // attempt failed; the failure itself is on the report and fails Z2 at the end.
    if (dayNumber % 7 === 0) {
      report.cycleCount = await this.attempt(report, 'the weekly cycle count', () =>
        this.deps.maintenance.cycleCount(shiftClosedAt, (adjustmentId) => {
          report.cycleCountAdjustmentIds.push(adjustmentId);
        }),
      );
    }
    if (dayNumber % 30 === 0) {
      report.restock = await this.attempt(report, 'the monthly restock', () =>
        this.deps.maintenance.restock(shiftClosedAt),
      );
    }
    // Every ten days rather than weekly or monthly, so write-offs do not sit at a
    // fixed phase against the count and the restock: on a 7 or a 30 they would
    // either always share a day with the count or never fall near a delivery, and
    // a year of scrap that only ever happens on full shelves is not a year's worth
    // of evidence.
    if (dayNumber % 10 === 0) {
      report.scrap = await this.attempt(report, 'the scrap write-off', () =>
        this.deps.maintenance.scrap(shiftClosedAt),
      );
    }

    // AFTER HOURS. Mobile units keep working once the bays have shut, and only now —
    // with the shift closed and nobody on the clock — can that happen without writing a
    // payroll entry outside the shop's hours. Bounded by the day's end so the stretch
    // cannot spend tomorrow's intake; the day's own target carries over rather than
    // restarting, so "12 customers a day" stays 12.
    const afterHours = daySchedule(await this.deps.now(), this.deps.calendar);
    if (afterHours.mobileOpenNow && afterHours.observedAt.getTime() < schedule.dayEnd.getTime()) {
      await this.workUntil(report, schedule.dayEnd, {
        rosters,
        target,
        startedAlready: worked.started,
        // Advancement as well as intake: a carried bay job must not be stepped here. It is
        // off the clock and past the grace, so the labor would be recorded against a
        // closed shift — and the step the grace stretch refused would simply happen
        // anyway, which is the defect this limit exists to close.
        kindLimit: 'MOBILE_UNIT',
      });
    }

    // The after-hours stretch runs past the shift close, and a job it advances reopens
    // its labor clock to do so. Left running, that entry would carry straight through
    // the night into tomorrow's close and book every hour of it. A mobile unit works any
    // hour, but it does not work every hour.
    report.laborSuspended += await this.suspendLabor(report);
    report.carriedOut = this.carried.length;
    return report;
  }

  /**
   * A day the bays cannot work: shut, or its window already gone by.
   *
   * Mobile units still work it, and nobody clocks in — the two reasons this is a
   * separate path rather than an early return with flags.
   */
  private async runWithoutShift(
    dayNumber: number,
    report: DayReport,
    schedule: DaySchedule,
    sampled: boolean,
    reason: 'closed' | 'window-missed',
  ): Promise<DayReport> {
    report.skipped = reason;
    this.log(
      `day ${dayNumber} (${report.virtualDate}) — ` +
        `${report.skipped === 'closed' ? 'shop closed' : `open window missed at ${schedule.observedAt.toISOString()}`}; ` +
        `no shift opened, ${this.carried.length} carried job(s)` +
        `${schedule.mobileOpenNow ? ', mobile units still working' : ''}`,
    );

    if (schedule.mobileOpenNow && sampled) {
      await this.workUntil(report, schedule.dayEnd, { kindLimit: 'MOBILE_UNIT' });
    } else {
      await this.advanceCarriedOnly(report, schedule.dayEnd);
    }
    // No shift opened here, so no `closeShift` ran — but mobile work still advanced, and
    // whatever it put back on the clock has to come off before the day ends.
    report.laborSuspended += await this.suspendLabor(report);
    report.carriedOut = this.carried.length;
    return report;
  }

  /**
   * Closes the shift and returns the instant it was recorded at.
   *
   * Clamped to the last legal instant for the phases that take one — maintenance dates
   * its purchase orders from it. Belt and braces: the protection that matters is the
   * work bound, because the shift port's `clockOut` takes no instant and the backend
   * stamps `endAtUtc` from its own clock.
   */
  private async closeShift(report: DayReport, schedule: DaySchedule): Promise<Date> {
    const closedAt = clampToGrace(await this.deps.now(), schedule);
    // LABOR-OUT, before payroll. Every carried job stops its labor clock for the night;
    // the entry is closed here and a fresh one opens when the job next advances, so no
    // span ever crosses a closed window. In parallel, and for the same reason the payroll
    // fan-out is: the backend stamps each `endTime` as its own call runs, so a sequential
    // close would date the last job's stamp N calls after the first.
    report.laborSuspended += await this.suspendLabor(report);
    // A clock-out that leaves anyone on the clock is a failed day, loudly. Left as a
    // warning, the open session had no `endAtUtc`, the audit skipped it, and the day
    // reported clean — a run that lost a payroll entry and passed.
    try {
      await this.deps.shift.clockOut(closedAt);
    } catch (error) {
      report.failures.push(error instanceof Error ? error.message : String(error));
    }
    await this.deps.shift.approveTime(closedAt);
    return closedAt;
  }

  /**
   * Runs a phase that returns nothing, and says whether it got through.
   *
   * The counterpart of `guard` for the steps whose result is "it happened" rather
   * than a count. Same rule: a `ClockConvergedError` is the end of the year and
   * is re-thrown; anything else is the day's problem, not the run's.
   */
  private async attempt(report: DayReport, what: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      if (error instanceof ClockConvergedError) {
        throw error;
      }
      report.failures.push(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Runs one of the day's optional phases, recording a failure instead of ending the run.
   *
   * Returns what the phase actually achieved: the count it returned, or — when it
   * raised a {@link PartialProgressError} — the count it got to before failing. Those
   * records are on the backend whether or not the rest of the batch succeeded, and a
   * report that called them 0 would undercount the year against its own data.
   *
   * A `ClockConvergedError` is re-thrown: the clock reaching wall time is not a failed
   * phase but the end of the year, and `AcceleratedRun` reads it as `converged`.
   */
  private async guard(
    report: DayReport,
    what: string,
    run: () => Promise<number>,
  ): Promise<number> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ClockConvergedError) {
        throw error;
      }
      const done = error instanceof PartialProgressError ? error.completed : 0;
      const reason = error instanceof Error ? error.message : String(error);
      report.failures.push(
        done > 0 ? `${what} failed after ${done} succeeded: ${reason}` : `${what} failed: ${reason}`,
      );
      return done;
    }
  }

  /**
   * Stops the labor clock on every job still holding one, and says how many.
   *
   * Failures are collected rather than thrown. A job whose entry would not close is a
   * labor record that now runs to whenever some later call stops it — worth reporting
   * loudly, but not worth abandoning the payroll close that still has to happen after
   * it, which a throw from here would skip.
   */
  private async suspendLabor(report: DayReport): Promise<number> {
    const running = this.carried.filter((active) => active.job.laborOpen);
    if (running.length === 0) {
      return 0;
    }
    const outcomes = await Promise.allSettled(running.map((active) => active.job.suspendLabor()));
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'rejected') {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        report.failures.push(`${running[index].job.label} could not stop its labor clock at closing: ${reason}`);
      }
    }
    return outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
  }

  /**
   * May this job take a step at this instant?
   *
   * A mobile-unit job always may. A bay job may inside the window, and inside the grace
   * only to *finish* — the intake loop refuses to open new bay work once the window has
   * closed, so anything still running in the grace is a car already on a lift.
   */
  private mayWorkNow(job: RunnableJob, now: Date, kindLimit?: PositionKind): boolean {
    // A stretch limited to mobile units must not advance a bay job either. `kindLimit`
    // used to gate only `claimableKind` — new claims — so the after-hours stretch happily
    // carried on stepping bay jobs off the clock, past the grace: the step the grace
    // stretch had refused just ran later, and the day's total bay work was unchanged.
    if (kindLimit !== undefined && job.kind !== kindLimit) {
      return false;
    }
    if (!job.gatedByHours) {
      return true;
    }
    return this.deps.calendar.isOpen(now, 'BAY') || this.deps.calendar.withinGrace(now, 'BAY');
  }

  /**
   * What kind of position may take *new* work at this instant.
   *
   * `'ANY'` while the bays are open. Once they close — after hours, at a weekend, on
   * a holiday — only a mobile unit may, which is what "mobile units take work at any
   * time" has to mean if it is to mean anything: not merely that carried mobile work
   * finishes, but that new mobile work starts. `null` when nothing may, which is a
   * closed day with mobile after-hours switched off.
   */
  private claimableKind(now: Date, limit?: PositionKind): PositionKind | 'ANY' | null {
    if (limit !== undefined) {
      return this.deps.calendar.isOpen(now, limit) ? limit : null;
    }
    if (this.deps.calendar.isOpen(now, 'BAY')) {
      return 'ANY';
    }
    if (this.deps.calendar.isOpen(now, 'MOBILE_UNIT')) {
      return 'MOBILE_UNIT';
    }
    return null;
  }

  /**
   * The work loop: take on new jobs while something may take them, advance every
   * runnable job a step per tick, and carry whatever is still open at `until`.
   *
   * Shared by the open-day path and the closed-day one. They differ only in what
   * they pass: an open day supplies the rosters it already reconciled and the day's
   * intake target; a closed day supplies neither and limits the kind to
   * `MOBILE_UNIT`, so it discovers lazily and only if a mobile unit could work.
   */
  private async workUntil(
    report: DayReport,
    until: Date,
    options: {
      rosters?: SiteRoster[];
      target?: number;
      kindLimit?: PositionKind;
      /** Intake already spent earlier in the same virtual day. */
      startedAlready?: number;
    } = {},
  ): Promise<{ now: Date; started: number }> {
    let now = await this.deps.now();

    // Carried holds come back into the working set so this stretch can carry them
    // on again if it also runs out of time.
    const active: ActiveJob[] = [...this.carried];
    for (const entry of active) {
      this.deps.ledger.resume(entry.claim);
    }
    this.carried = [];

    let rosters = options.rosters;
    const target = options.target ?? this.deps.jobsToday(now);
    let started = options.startedAlready ?? 0;
    let ticks = 0;

    for (;;) {
      if (now.getTime() >= until.getTime()) {
        break;
      }

      // Top up to the concurrency limit while something may take new work. New work
      // never starts inside the overrun grace: `claimableKind` reads `isOpen`, which
      // the grace is deliberately not part of.
      // Predicted before intake, not after: a refused tick would otherwise still have
      // claimed a bay and a technician and created a job with zero advances, counted
      // against the day's target and carried to tomorrow untouched.
      const canTick = !this.tickWouldOvershoot(now, until, active.length === 0);
      const kind = canTick ? this.claimableKind(now, options.kindLimit) : null;
      while (kind !== null && active.length < this.deps.concurrency && started < target) {
        if (rosters === undefined) {
          // Lazily, and only once something could actually be claimed — a closed day
          // with no mobile unit free should not spend a board read to find out.
          rosters = await this.deps.discovery.rosters(now);
          for (const roster of rosters) {
            this.deps.ledger.reconcile(roster);
          }
          // The discovery cost virtual time that is not a tick's. Re-read here, once, so
          // neither the gate nor the tick measurement charges it to the estimate.
          now = await this.deps.now();
        }
        if (rosters.length === 0) {
          // Same treatment as the open-day path: a stretch that could have worked but
          // found no usable board is a reportable gap, not a quiet success.
          const reason = 'no site reported a usable dispatch board — nothing could be worked';
          if (!report.failures.includes(reason)) {
            report.failures.push(reason);
          }
          break;
        }
        const claim = this.nextClaim(rosters, now, kind === 'ANY' ? undefined : kind);
        if (!claim) {
          break;
        }
        const job = this.deps.createJob(claim, started + 1);
        if (!job) {
          this.deps.ledger.release(claim, now);
          break;
        }
        active.push({ job, claim });
        started += 1;
      }

      if (active.length === 0) {
        break;
      }

      // One step per job per tick, in parallel. A tick is the unit the window is
      // checked at, so no job can run away with the clock.
      const runnable = active.filter((entry) => this.mayWorkNow(entry.job, now, options.kindLimit));
      if (runnable.length === 0) {
        break;
      }
      // Refuse a tick that the observed cost says would cross the bound. Without this
      // the loop stops one tick *past* `until`, which for the grace stretch means the
      // shift ends outside the window the payroll audit accepts.
      // The in-hours loop must take at least one tick or the day does nothing at all.
      if (this.tickWouldOvershoot(now, until, true)) {
        if (ticks === 0 && active.length > 0) {
          report.failures.push(
            `no step fit inside the window ending ${until.toISOString()} — the tick estimate ` +
              `(${Math.round(this.maxTickVirtualMs / 60_000)} virtual min) exceeds what is left. ` +
              'Lower pos.time.accelerated.scale, or widen ITEST_ACCEL_OPEN_TIME / _CLOSE_TIME.',
          );
        }
        break;
      }
      // `now` is reused as the tick's start, NOT re-read: a second /system/time read per
      // tick doubles the run's clock traffic and, worse, its own virtual cost falls
      // outside the measured window, so the estimate under-counts every tick by one
      // gateway round trip — systematically optimistic in the one place its margin is
      // spent. Only a lazy discovery inside intake makes `now` stale, and that path
      // re-reads for itself above.
      const tickStart = now;
      await Promise.all(runnable.map((entry) => entry.job.advance()));
      ticks += 1;
      // Before the settle loop below, because settling releases the claim and `attach`
      // refuses a claim nobody holds.
      for (const entry of runnable) {
        this.noteWorkorder(entry, report);
      }

      // One clock read per tick, reused by the next iteration's gate check. Reading
      // it twice would double the run's /system/time traffic, and at a thousandfold
      // scale those round trips are themselves virtual minutes off the window.
      now = await this.deps.now();
      this.recordTickCost(tickStart, now);
      for (const entry of [...active]) {
        if (entry.job.outcome === 'in-progress') {
          continue;
        }
        active.splice(active.indexOf(entry), 1);
        this.settle(entry, report, now);
      }
    }

    // Whatever is still open keeps its position and its mechanic and is held: the car
    // is still in the shop. `runDay` owns `report.carriedOut`, because a single day can
    // call this twice — once inside the hours and once for after-hours mobile work.
    for (const entry of active) {
      this.deps.ledger.carry(entry.claim);
      this.carried.push(entry);
      this.log(`  holding ${entry.job.label} at step '${entry.job.nextStep}' (${now.toISOString()})`);
    }
    return { now, started };
  }

  /**
   * Advances only mobile-unit work: the shop is shut, so bays stand idle.
   *
   * Bounded by `until` — the end of the virtual day — for the same reason the main
   * loop is: mobile work is never gated, so an unbounded loop here would work
   * straight through Sunday into Monday and the next day would find its own
   * intake already spent.
   */
  private async advanceCarriedOnly(
    report: DayReport,
    until: Date,
    kindLimit?: PositionKind,
  ): Promise<void> {
    let now = await this.deps.now();
    for (;;) {
      if (now.getTime() >= until.getTime()) {
        return;
      }
      const runnable = this.carried.filter(
        (entry) => entry.job.outcome === 'in-progress' && this.mayWorkNow(entry.job, now, kindLimit),
      );
      if (runnable.length === 0) {
        return;
      }
      // No guaranteed first tick: this is the grace, and refusing is the right answer —
      // the job carries to the next open day rather than pushing the shift out of hours.
      if (this.tickWouldOvershoot(now, until)) {
        return;
      }
      const tickStart = now;
      await Promise.all(runnable.map((entry) => entry.job.advance()));
      for (const entry of runnable) {
        this.noteWorkorder(entry, report);
      }

      now = await this.deps.now();
      this.recordTickCost(tickStart, now);
      for (const entry of [...this.carried]) {
        if (entry.job.outcome === 'in-progress') {
          continue;
        }
        this.carried.splice(this.carried.indexOf(entry), 1);
        this.settle(entry, report, now);
      }
    }
  }

  /**
   * Ties a claim to the workorder it is working, the first time the job has one.
   *
   * Two things depend on this happening here and not at settle. The ledger's closed
   * holds are the only surviving record of which bay or mobile unit worked a given
   * workorder, and the end-of-run labor audit needs that to know whether a span is
   * allowed outside the shop's window — without it every job classifies as a bay and
   * every legitimate mobile span reads as a violation.
   *
   * And `settle` runs only for jobs that *finish*. A job still carried when the run
   * stops — a converged clock, a spent budget — already has a workorder and may
   * already have labor entries, so recording ids only at settle silently excludes the
   * jobs most likely to be holding an entry open.
   */
  private noteWorkorder(entry: ActiveJob, report: DayReport): void {
    const workorderId = entry.job.workorderId;
    if (!workorderId || entry.claim.workorderId === workorderId) {
      return;
    }
    this.deps.ledger.attach(entry.claim, workorderId);
    if (!report.workorderIds.includes(workorderId)) {
      report.workorderIds.push(workorderId);
    }
    report.workorderKinds[workorderId] = entry.claim.position.kind;
  }

  /**
   * A finished job: count it, then give the bay and the mechanic back.
   *
   * Ids are not collected here. `noteWorkorder` records a workorder the moment the job
   * has one, which covers the completed, the failed and — the case this missed — the
   * ones still carried when the run stops.
   */
  private settle(entry: ActiveJob, report: DayReport, at: Date): void {
    const { job } = entry;
    if (job.outcome === 'completed') {
      report.workordersCompleted += 1;
      if (job.invoiceId) {
        report.invoicesFinalized += 1;
        report.invoiceIds.push(job.invoiceId);
      }
      if (job.paid) report.invoicesPaid += 1;
    } else if (job.outcome === 'declined') {
      report.estimatesDeclined += 1;
    } else if (job.outcome === 'failed') {
      report.workordersFailed += 1;
      report.failures.push(job.failure ?? `${job.label} failed without a reason`);
    }
    this.deps.ledger.release(entry.claim, at);
  }

  /**
   * The next claim from any site that has one.
   *
   * Sites are taken in order and each is drained before the next, because a claim
   * is per-site by construction — a spare technician at one site cannot cover a
   * gap at another (the same rule planFloor keeps).
   */
  private nextClaim(rosters: SiteRoster[], now: Date, kind?: PositionKind): Claim | null {
    for (const roster of rosters) {
      const claim = this.deps.ledger.claim(roster.locationId, now, kind);
      if (claim) {
        return claim;
      }
    }
    return null;
  }
}
