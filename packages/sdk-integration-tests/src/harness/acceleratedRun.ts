/**
 * The year, assembled.
 *
 * Wires the clock, the timer, the calendar, the ledger, the ports and the job
 * factory into one loop over virtual days, and returns what it wrote. Shared by
 * the asserting suite (`z-year-volume.accel.itest.ts`) and the populate run
 * (`runs/acceleratedYear.ts`) so there is exactly one implementation of "a year of
 * shop activity" and the two differ only in whether they assert.
 */
import { SeederRandom } from '@durion-sdk/seeder';
import { AcceleratedConfig } from './acceleratedConfig';
import { loadAcceleratedContext, type AcceleratedContext } from './acceleratedContext';
import { AcceleratedDayRunner, type DayReport } from './acceleratedDayRunner';
import { AcceleratedJob } from './acceleratedJob';
import { AcceleratedJournal } from './acceleratedJournal';
import {
  createAppointmentPort,
  createDiscoveryPort,
  createMaintenancePort,
  createShiftPort,
} from './acceleratedPorts';
import { createPersonAccount, createVehicle, seedFromRunId, type BuilderContext } from './builders';
import { ItestConfig } from './ItestConfig';
import { loadContext, type ItestContext } from './ItestContext';
import { Mutex } from './mutex';
import { Personas } from './personas';
import { ResourceLedger } from './resourceLedger';
import { ClockConvergedError, VirtualClock } from './virtualClock';
import { VirtualTimer } from './virtualTimer';

export type StopReason = 'days-complete' | 'converged' | 'budget' | 'failed';

export interface YearRunResult {
  runId: string;
  stoppedBecause: StopReason;
  /** Why the run stopped, in words, for the log and the assertion message. */
  stopDetail: string;
  daysAttempted: number;
  reports: DayReport[];
  totals: {
    workordersCompleted: number;
    workordersFailed: number;
    invoicesFinalized: number;
    invoicesPaid: number;
    estimatesDeclined: number;
    appointmentsBooked: number;
    appointmentsConverted: number;
    openDaysWorked: number;
    cycleCounts: number;
    restocks: number;
  };
  /** Virtual dates the run touched, first and last. */
  virtualSpan: { from: string; to: string };
  /** Distinct `YYYY-MM` an invoice was finalized in. */
  invoicedMonths: string[];
  ledger: ResourceLedger;
  journal: AcceleratedJournal;
  failures: string[];
}

export interface YearRunOptions {
  /** Overrides the configured day count, for the parity suites' short runs. */
  days?: number;
  log?: (message: string) => void;
}

const DAY_MS = 86_400_000;

/**
 * Drives virtual days until the configured count is reached, the clock converges,
 * or the wall-clock budget runs out — whichever comes first. Never throws for a
 * day that went wrong: the failures are returned, so the caller decides whether a
 * bad day fails a test or just gets logged by a populate run.
 */
export async function runAcceleratedYear(options: YearRunOptions = {}): Promise<YearRunResult> {
  const log = options.log ?? ((message: string) => console.log(`[accel] ${message}`));

  const config = ItestConfig.fromEnv();
  const accel = AcceleratedConfig.fromEnv();
  const context: ItestContext = loadContext();
  const accelContext: AcceleratedContext = loadAcceleratedContext();

  const clock = new VirtualClock(config.baseUrl, { maxSkewMs: accel.maxSkewMs });
  const timer = new VirtualTimer(clock, { pollMs: accel.pollMs });

  const first = await clock.read();
  const virtualEnd = new Date(first.virtualTime.getTime() + accel.days * DAY_MS);
  const calendar = accel.calendarFor(first.virtualStart, virtualEnd);

  const personas = new Personas(config);
  await personas.login();
  const as = {
    admin: personas.as('admin'),
    advisor: personas.as('advisor'),
    manager: personas.as('manager'),
    tech: personas.as('tech'),
    parts: personas.as('parts'),
    controller: personas.as('controller'),
  };

  const ctx: BuilderContext = {
    runId: context.runId,
    random: new SeederRandom(seedFromRunId(`${context.runId}:accelerated-year`)),
    refs: context.referenceCache,
  };

  const ledger = new ResourceLedger();
  const timerLock = new Mutex();
  const { journal } = AcceleratedJournal.open(accelContext.journalPath, {
    runId: context.runId,
    realStart: first.realStart,
    virtualStart: first.virtualStart,
    scale: first.scale,
  });

  const appointments = createAppointmentPort({
    advisor: as.advisor,
    admin: as.admin,
    ctx,
    calendar,
    leadDaysMin: accel.appointmentLeadDaysMin,
    leadDaysMax: accel.appointmentLeadDaysMax,
    customerFor: async () => {
      const customer = await createPersonAccount(as.advisor, ctx);
      // Vehicle registration is still ADMIN-only, so the fixture is split across
      // two personas — the same split Suite A makes.
      const vehicleId = await createVehicle(as.admin, ctx, customer.partyId);
      return { partyId: customer.partyId, vehicleId };
    },
  });

  // Jobs per open day, capped by what the feasibility guard said actually fits.
  const feasibleJobsPerDay = Math.max(1, accelContext.feasibility.jobsPerDay);
  let jobSequence = 0;

  const runner = new AcceleratedDayRunner({
    calendar,
    ledger,
    discovery: createDiscoveryPort(as.admin, as.manager),
    shift: createShiftPort(as.admin, as.manager, ctx.refs),
    maintenance: createMaintenancePort(as.parts, as.manager, ctx),
    appointments,
    now: () => clock.now(),
    waitUntil: async (target, description) => {
      await timer.waitUntil(target, description);
    },
    createJob: (claim) => {
      jobSequence += 1;
      return new AcceleratedJob(`job-${jobSequence} (${claim.position.kind} ${claim.position.name})`, {
        as,
        ctx,
        claim,
        now: () => clock.now(),
        timerLock,
        // A fraction of invoices are deliberately left unpaid when AR aging is
        // wanted; the default of 0 pays every one.
        leaveUnpaid: accel.unpaidRatio > 0 && ctx.random.chance(accel.unpaidRatio),
      });
    },
    concurrency: accel.concurrency,
    jobsToday: () =>
      Math.min(
        feasibleJobsPerDay,
        Math.max(accel.jobsPerDayMin, ctx.random.int(accel.jobsPerDayMin, accel.jobsPerDayMax)),
      ),
    log,
  });

  const totalDays = options.days ?? accel.days;
  const reports: DayReport[] = [];
  const failures: string[] = [];
  const deadline = Date.now() + accel.runBudgetMs;
  const startedFrom = journal.lastDayNumber();
  let stoppedBecause: StopReason = 'days-complete';
  let stopDetail = `all ${totalDays} virtual day(s) driven`;
  let lastVirtualDate = first.virtualTime.toISOString().slice(0, 10);

  if (startedFrom > 0) {
    log(`resuming at virtual day ${startedFrom + 1} of ${totalDays}`);
  }

  for (let dayNumber = startedFrom + 1; dayNumber <= totalDays; dayNumber += 1) {
    if (Date.now() >= deadline) {
      stoppedBecause = 'budget';
      stopDetail =
        `the ${Math.round(accel.runBudgetMs / 60_000)}-minute wall-clock budget ran out at virtual day ` +
        `${dayNumber - 1} (${lastVirtualDate})`;
      break;
    }

    // Sampling thins the intake on a fast clock: only every Nth open day takes new
    // work. Carried jobs are still advanced on the days in between.
    const sampled = accel.sampleEvery === 1 || dayNumber % accel.sampleEvery === 1 % accel.sampleEvery;

    let report: DayReport;
    try {
      report = await runner.runDay(dayNumber, { sampled });
    } catch (error) {
      if (error instanceof ClockConvergedError) {
        stoppedBecause = 'converged';
        stopDetail = `the clock converged on wall time during virtual day ${dayNumber}: ${error.message}`;
        break;
      }
      // A day that threw rather than reporting is a harness fault, not a shop
      // failure, and the run stops: continuing would write into a state nobody
      // has accounted for.
      stoppedBecause = 'failed';
      stopDetail = `virtual day ${dayNumber} failed outright: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(stopDetail);
      break;
    }

    reports.push(report);
    lastVirtualDate = report.virtualDate;
    failures.push(...report.failures);

    journal.recordDay({
      virtualDate: report.virtualDate,
      dayNumber: report.dayNumber,
      skipped: report.skipped,
      workordersCompleted: report.workordersCompleted,
      invoicesFinalized: report.invoicesFinalized,
      invoicesPaid: report.invoicesPaid,
      estimatesDeclined: report.estimatesDeclined,
      appointmentsBooked: report.appointmentsBooked,
      carriedIn: report.carriedIn,
      carriedOut: report.carriedOut,
      cycleCount: report.cycleCount,
      restock: report.restock,
    });
    for (const workorderId of report.workorderIds) {
      journal.recordWorkorder(workorderId);
    }
    for (const invoiceId of report.invoiceIds) {
      journal.recordInvoice(invoiceId);
    }
    journal.recordOpenClaims(
      ledger.activeClaims().map((claim) => ({
        positionId: claim.position.id,
        technicianId: claim.technicianId,
        workorderId: claim.workorderId,
      })),
    );
    journal.flush();

    if (report.skipped === undefined) {
      log(
        `day ${report.dayNumber} (${report.virtualDate}): ${report.workordersCompleted} completed, ` +
          `${report.invoicesPaid} paid, ${report.estimatesDeclined} declined, ${report.carriedOut} carried` +
          `${report.workordersFailed > 0 ? `, ${report.workordersFailed} FAILED` : ''}`,
      );
    }

    // The next day begins when the virtual calendar says so.
    if (dayNumber < totalDays) {
      try {
        await timer.waitForNextDay(await clock.now());
      } catch (error) {
        if (error instanceof ClockConvergedError) {
          stoppedBecause = 'converged';
          stopDetail = `the clock converged on wall time after virtual day ${dayNumber} (${report.virtualDate})`;
          break;
        }
        throw error;
      }
    }
  }

  const sum = (pick: (report: DayReport) => number): number => reports.reduce((total, report) => total + pick(report), 0);

  const result: YearRunResult = {
    runId: context.runId,
    stoppedBecause,
    stopDetail,
    daysAttempted: reports.length,
    reports,
    totals: {
      workordersCompleted: sum((report) => report.workordersCompleted),
      workordersFailed: sum((report) => report.workordersFailed),
      invoicesFinalized: sum((report) => report.invoicesFinalized),
      invoicesPaid: sum((report) => report.invoicesPaid),
      estimatesDeclined: sum((report) => report.estimatesDeclined),
      appointmentsBooked: sum((report) => report.appointmentsBooked),
      appointmentsConverted: sum((report) => report.appointmentsConverted),
      openDaysWorked: reports.filter((report) => report.skipped === undefined).length,
      cycleCounts: reports.filter((report) => report.cycleCount).length,
      restocks: reports.filter((report) => report.restock).length,
    },
    virtualSpan: {
      from: reports[0]?.virtualDate ?? lastVirtualDate,
      to: lastVirtualDate,
    },
    invoicedMonths: [
      ...new Set(reports.filter((report) => report.invoicesFinalized > 0).map((report) => report.virtualDate.slice(0, 7))),
    ].sort(),
    ledger,
    journal,
    failures,
  };

  log(
    `stopped: ${stopDetail}. ${result.totals.workordersCompleted} workorder(s), ` +
      `${result.totals.invoicesFinalized} invoice(s), ${result.totals.invoicesPaid} paid, across ` +
      `${result.totals.openDaysWorked} worked day(s) from ${result.virtualSpan.from} to ${result.virtualSpan.to}`,
  );
  return result;
}

/** The volume floor this run must clear, as global setup computed it. */
export function volumeFloor(): number {
  const accel = AcceleratedConfig.fromEnv();
  const accelContext = loadAcceleratedContext();
  return accel.minWorkordersOverride ?? accelContext.feasibility.minWorkorders;
}
