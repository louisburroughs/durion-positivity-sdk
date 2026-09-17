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
import type { SiteRoster } from '../runs/shopFloorPlan';
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
  skipped?: 'closed' | 'sampled-out';
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
    const dayEnd = nextUtcMidnight(now);

    // A closed day is not skipped silently: mobile work and carried jobs still
    // run, and the day is recorded so a gap in the journal always means a gap in
    // the run rather than a closed Sunday.
    if (!this.deps.calendar.isWorkingDay(now)) {
      report.skipped = 'closed';
      this.log(`day ${dayNumber} (${report.virtualDate}) — shop closed; advancing ${this.carried.length} carried job(s)`);
      await this.advanceCarriedOnly(report, dayEnd);
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
      // day started with.
      report.virtualDate = now.toISOString().slice(0, 10);
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

    // WORK. Carried jobs first: they are already holding a bay, and finishing them
    // is what frees capacity for today's intake. Their holds come back into the
    // working set so this day can carry them on again if it also runs out of time.
    const active: ActiveJob[] = [...this.carried];
    for (const entry of active) {
      this.deps.ledger.resume(entry.claim);
    }
    this.carried = [];
    const target = this.deps.jobsToday(now);
    let started = 0;

    for (;;) {
      if (now.getTime() >= dayEnd.getTime()) {
        break;
      }

      // Top up to the concurrency limit while the shop is open and the day still
      // wants work. New work never starts inside the overrun grace.
      while (active.length < this.deps.concurrency && started < target && this.deps.calendar.isOpen(now, 'BAY')) {
        const claim = this.nextClaim(rosters, now);
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

    // Whatever is still open at close keeps its bay and its mechanic and is
    // carried: the car is still in the shop.
    for (const entry of active) {
      this.deps.ledger.carry(entry.claim);
      this.carried.push(entry);
      this.log(`  carried ${entry.job.label} to the next open day at step '${entry.job.nextStep}'`);
    }
    report.carriedOut = this.carried.length;

    // SHIFT-OUT.
    await this.deps.shift.clockOut(now);
    await this.deps.shift.approveTime(now);

    // MAINTENANCE, on the due virtual day of the run.
    if (dayNumber % 7 === 0) {
      await this.deps.maintenance.cycleCount(now);
      report.cycleCount = true;
    }
    if (dayNumber % 30 === 0) {
      await this.deps.maintenance.restock(now);
      report.restock = true;
    }

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
  private nextClaim(rosters: SiteRoster[], now: Date): Claim | null {
    for (const roster of rosters) {
      const claim = this.deps.ledger.claim(roster.locationId, now);
      if (claim) {
        return claim;
      }
    }
    return null;
  }
}
