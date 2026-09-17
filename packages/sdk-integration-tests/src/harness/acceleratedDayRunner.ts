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
import { nextUtcMidnight } from './virtualTimer';
import type { Claim, ResourceLedger } from './resourceLedger';
import type { PositionKind, SiteRoster } from '../runs/shopFloorPlan';
import type { JobOutcome } from './acceleratedJob';

/** What the runner needs of a job — the real AcceleratedJob satisfies it. */
export interface RunnableJob {
  readonly label: string;
  readonly gatedByHours: boolean;
  readonly outcome: JobOutcome;
  readonly failure: string | undefined;
  readonly nextStep: string;
  readonly workorderId: string | undefined;
  readonly invoiceId: string | undefined;
  readonly invoiceTotal: number | undefined;
  readonly paid: boolean;
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
  /** Weekly cycle count. */
  cycleCount(at: Date): Promise<void>;
  /** Monthly restock. */
  restock(at: Date): Promise<void>;
}

export interface AppointmentPort {
  /** Books appointments for future open windows; returns how many were booked. */
  book(at: Date, count: number): Promise<number>;
  /**
   * Converts every appointment whose start the clock has now reached into an
   * estimate; returns how many were converted.
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
  clockedIn: number;
  failures: string[];
  /** Ids created, for the journal and the by-runId retrieval afterwards. */
  workorderIds: string[];
  invoiceIds: string[];
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
  clockedIn: 0,
  failures: [],
  workorderIds: [],
  invoiceIds: [],
});

export class AcceleratedDayRunner {
  /** Jobs that outlived a previous day, still holding their position. */
  private carried: ActiveJob[] = [];

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
    let now = await this.deps.now();
    const report = EMPTY_REPORT(dayNumber, now.toISOString().slice(0, 10));
    report.carriedIn = this.carried.length;
    // Every loop below stops here. Mobile work is never gated by the shop's hours,
    // so without a day boundary it would run straight through the night and spend
    // the next day's intake before that day began.
    //
    // Recomputed after the WAIT-OPEN below: that wait can cross midnight (a run whose
    // setup finished on Friday evening waits until Monday morning), and a bound taken
    // from before it would already be in the past — leaving a day that clocks everyone
    // in and out, spends its intake budget and works nothing, while reporting success.
    let dayEnd = nextUtcMidnight(now);

    // A closed day is not skipped silently. The bays are shut, but mobile units
    // take work at any hour, so a closed day still *starts* mobile jobs as well as
    // advancing carried ones — otherwise "mobile units work any time" would mean
    // nothing more than "carried mobile work finishes", and a virtual weekend would
    // be two days of dead air.
    //
    // No shift is opened on a closed day: a mobile crew turning out on a Sunday is
    // on call, not on the shop's clock, and clocking anyone in here would put a
    // payroll entry outside the shop's hours — the very thing the end-of-run audit
    // asserts against. Maintenance does not run either; it is floor work.
    if (!this.deps.calendar.isWorkingDay(now)) {
      report.skipped = 'closed';
      const mobileAvailable = this.deps.calendar.isOpen(now, 'MOBILE_UNIT');
      this.log(
        `day ${dayNumber} (${report.virtualDate}) — shop closed; ${this.carried.length} carried job(s)` +
          `${mobileAvailable ? ', mobile units still working' : ''}`,
      );
      if (mobileAvailable && sampled) {
        await this.workUntil(report, dayEnd, { kindLimit: 'MOBILE_UNIT' });
      } else {
        await this.advanceCarriedOnly(report, dayEnd);
      }
      report.carriedOut = this.carried.length;
      return report;
    }

    // WAIT-OPEN. Before the window, wait for it; inside it, start now. Carried
    // mobile work is advanced while waiting, which is what makes an out-of-hours
    // stretch productive instead of dead air.
    const open = this.deps.calendar.nextOpen(now, 'BAY');
    if (open.getTime() > now.getTime()) {
      await this.advanceCarriedOnly(report, open);
      await this.deps.waitUntil(open, `the shop to open on ${report.virtualDate}`);
      now = await this.deps.now();
      // The wait can land on the next calendar day when the window was already
      // past — the date the backend used is the one that counts, not the one this
      // day started with. The day's own boundary moves with it.
      report.virtualDate = now.toISOString().slice(0, 10);
      dayEnd = nextUtcMidnight(now);
    }

    // The wait can also overshoot the window it was waiting for, if enough real time
    // passed inside it. Clocking anyone in now would stamp a payroll entry outside the
    // open window — the violation the end-of-run audit raises — so this is not a day
    // the shop can work. Mobile units still can.
    if (!this.deps.calendar.isOpen(now, 'BAY')) {
      report.skipped = 'window-missed';
      this.log(
        `day ${dayNumber} (${report.virtualDate}) — the open window was missed at ` +
          `${now.toISOString()}; no shift opened` +
          `${this.deps.calendar.isOpen(now, 'MOBILE_UNIT') ? ', mobile units still working' : ''}`,
      );
      if (this.deps.calendar.isOpen(now, 'MOBILE_UNIT') && sampled) {
        await this.workUntil(report, dayEnd, { kindLimit: 'MOBILE_UNIT' });
      } else {
        await this.advanceCarriedOnly(report, dayEnd);
      }
      report.carriedOut = this.carried.length;
      return report;
    }

    if (!sampled) {
      report.skipped = 'sampled-out';
      this.log(`day ${dayNumber} (${report.virtualDate}) — sampled out; advancing ${this.carried.length} carried job(s)`);
      await this.advanceCarriedOnly(report, dayEnd);
      report.carriedOut = this.carried.length;
      return report;
    }

    // RECONCILE. Anything the board reports as occupied starts the day held,
    // including records left open by a previous day, a previous run or the seeder.
    const rosters = await this.deps.discovery.rosters(now);
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

    // SHIFT-IN.
    const clockedIn = await this.deps.shift.clockIn(now);
    report.clockedIn = clockedIn.length;

    // APPOINTMENTS. Booked ahead, and converted when the clock reaches them —
    // which only an accelerated clock makes possible inside one run.
    report.appointmentsConverted = await this.deps.appointments.convertDue(now);
    report.appointmentsBooked = await this.deps.appointments.book(now, rosters.length);

    // WORK, inside the hours — bounded at bay CLOSE, and the grace is what absorbs the
    // overshoot rather than being extra working time.
    //
    // The loop can only check its bound between ticks, so it exits one tick *past*
    // whatever it is given. Bounding it at close + grace therefore ends the shift at or
    // beyond the grace end, and `withinGrace` is strict — the grace end itself is
    // illegal. Nor can that be papered over at the call site: `clockOut` takes no
    // instant at all, and the backend stamps `endAtUtc` from its own clock when
    // `stopWorkSession` runs. So the only thing that actually keeps the payroll entry
    // legal is exiting this loop early enough, and close is that point: the real
    // clock-out then lands within one tick of close, against a 90-minute default grace.
    //
    // A job unfinished at close is carried to the next open day. That is the modelled
    // behaviour anyway — the car stays in the shop overnight.
    const closesAt = this.deps.calendar.closesAt(now, 'BAY');
    const graceMs = this.deps.calendar.graceMinutes * 60_000;
    // The last legal instant for the shift to end, for the clamp below.
    const graceLimit = closesAt === null ? now : new Date(closesAt.getTime() + graceMs - 1);
    const workBound = closesAt !== null && closesAt.getTime() < dayEnd.getTime() ? closesAt : dayEnd;

    const target = this.deps.jobsToday(now);
    const worked = await this.workUntil(report, workBound, { rosters, target });
    now = worked.now;

    // SHIFT-OUT, at the end of the worked window rather than at midnight.
    //
    // Clamped to the last legal instant, for the phases that do take one (maintenance
    // dates its purchase orders from it). Belt and braces only: the protection that
    // matters is the bound above, because `clockOut` ignores this and the backend
    // stamps its own clock.
    const shiftClosedAt = now.getTime() > graceLimit.getTime() ? graceLimit : now;
    await this.deps.shift.clockOut(shiftClosedAt);
    await this.deps.shift.approveTime(shiftClosedAt);

    // MAINTENANCE, on the due virtual day of the run.
    if (dayNumber % 7 === 0) {
      await this.deps.maintenance.cycleCount(shiftClosedAt);
      report.cycleCount = true;
    }
    if (dayNumber % 30 === 0) {
      await this.deps.maintenance.restock(shiftClosedAt);
      report.restock = true;
    }

    // AFTER HOURS. Mobile units keep working once the bays have shut, and only now —
    // with the shift closed and nobody on the clock — can that happen without writing
    // a payroll entry outside the shop's hours. Bounded by the day's end so the stretch
    // cannot spend tomorrow's intake; the day's own target carries over rather than
    // restarting, so "12 customers a day" stays 12.
    if (this.deps.calendar.isOpen(now, 'MOBILE_UNIT') && now.getTime() < dayEnd.getTime()) {
      const afterHours = await this.workUntil(report, dayEnd, {
        rosters,
        target,
        startedAlready: worked.started,
        kindLimit: 'MOBILE_UNIT',
      });
      now = afterHours.now;
    }

    report.carriedOut = this.carried.length;
    return report;
  }

  /**
   * May this job take a step at this instant?
   *
   * A mobile-unit job always may. A bay job may inside the window, and inside the
   * grace *only to finish* — which is the same thing here, because a job in the
   * grace has already started and the intake loop above refuses to open new work
   * once the window has closed.
   */
  private mayWorkNow(job: RunnableJob, now: Date): boolean {
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

    for (;;) {
      if (now.getTime() >= until.getTime()) {
        break;
      }

      // Top up to the concurrency limit while something may take new work. New work
      // never starts inside the overrun grace: `claimableKind` reads `isOpen`, which
      // the grace is deliberately not part of.
      const kind = this.claimableKind(now, options.kindLimit);
      while (kind !== null && active.length < this.deps.concurrency && started < target) {
        if (rosters === undefined) {
          // Lazily, and only once something could actually be claimed — a closed day
          // with no mobile unit free should not spend a board read to find out.
          rosters = await this.deps.discovery.rosters(now);
          for (const roster of rosters) {
            this.deps.ledger.reconcile(roster);
          }
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
      const runnable = active.filter((entry) => this.mayWorkNow(entry.job, now));
      if (runnable.length === 0) {
        break;
      }
      await Promise.all(runnable.map((entry) => entry.job.advance()));

      // One clock read per tick, reused by the next iteration's gate check. Reading
      // it twice would double the run's /system/time traffic, and at a thousandfold
      // scale those round trips are themselves virtual minutes off the window.
      now = await this.deps.now();
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
  private async advanceCarriedOnly(report: DayReport, until: Date): Promise<void> {
    let now = await this.deps.now();
    for (;;) {
      if (now.getTime() >= until.getTime()) {
        return;
      }
      const runnable = this.carried.filter(
        (entry) => entry.job.outcome === 'in-progress' && this.mayWorkNow(entry.job, now),
      );
      if (runnable.length === 0) {
        return;
      }
      await Promise.all(runnable.map((entry) => entry.job.advance()));

      now = await this.deps.now();
      for (const entry of [...this.carried]) {
        if (entry.job.outcome === 'in-progress') {
          continue;
        }
        this.carried.splice(this.carried.indexOf(entry), 1);
        this.settle(entry, report, now);
      }
    }
  }

  /** A finished job: count it, then give the bay and the mechanic back. */
  private settle(entry: ActiveJob, report: DayReport, at: Date): void {
    const { job } = entry;
    if (job.outcome === 'completed') {
      report.workordersCompleted += 1;
      if (job.workorderId) report.workorderIds.push(job.workorderId);
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
      // A failed job's workorder still exists and is still the run's record.
      if (job.workorderId) report.workorderIds.push(job.workorderId);
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
