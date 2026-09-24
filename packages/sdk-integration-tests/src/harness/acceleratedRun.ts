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
import { formatError } from './http';
import { ItestConfig } from './ItestConfig';
import { loadContext, type ItestContext } from './ItestContext';
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
    scraps: number;
  };
  /** Virtual dates the run touched, first and last. */
  virtualSpan: { from: string; to: string };
  /** Distinct `YYYY-MM` an invoice was finalized in. */
  invoicedMonths: string[];
  ledger: ResourceLedger;
  journal: AcceleratedJournal;
  failures: string[];
  /**
   * Workorders an interrupted run left holding a bay, which this run released rather
   * than completed.
   *
   * Deliberately NOT in `failures`: the suite asserts `failures` is empty, and a
   * resume that cleanly reclaims its predecessor's bays is the journal working as
   * designed, not a failed day. They are reported so the open workorders are visible.
   */
  reclaimed: string[];
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

  const clock = new VirtualClock(config.baseUrl, {
    maxSkewMs: accel.maxSkewMs,
  });
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

  const failures: string[] = [];

  // Claims the interrupted run left behind. Reconciliation would see these bays as
  // occupied and keep them out of service for the rest of the year, with no job
  // object left to finish or release them — so the workorders are released here and
  // named, rather than silently stranding a bay and a mechanic.
  const stranded = journal.snapshot().openClaims;
  const reclaimed: string[] = [];
  /**
   * Claims an interrupted run left that this one could not release.
   *
   * Carried into *every* later journal write, not just the first: `recordOpenClaims`
   * replaces the whole list at the end of each day, and these are not ledger claims
   * (reconciliation marks the position held but mints no `Claim`), so writing only the
   * ledger's view would erase the record of the bay nobody can unpick after day one.
   */
  const stillStuck: typeof stranded = [];
  if (stranded.length > 0) {
    log(`${stranded.length} claim(s) were left open by the interrupted run; releasing them`);
    for (const claim of stranded) {
      if (!claim.workorderId) {
        log(`  ${claim.positionId}/${claim.technicianId}: no workorder recorded, nothing to release`);
        continue;
      }
      let releasedBoth = true;
      // Best effort, in the order that frees the board: the position first, then the
      // technician. A failure here is reported rather than fatal — the run can work
      // the remaining bays, and a human needs to know which one it could not reclaim.
      for (const [what, attempt] of [
        [
          'service position',
          () =>
            as.manager.workorder.servicePositionAPIApi.releaseServicePosition({
              workorderId: claim.workorderId as string,
              reason: `Released on resume: left open by an interrupted run [${context.runId}]`,
            }),
        ],
        [
          'technician',
          () =>
            as.manager.workorder.technicianAssignmentAPIApi.releaseTechnician({
              workorderId: claim.workorderId as string,
              reason: `Released on resume: left open by an interrupted run [${context.runId}]`,
            }),
        ],
      ] as Array<[string, () => Promise<unknown>]>) {
        try {
          await attempt();
        } catch (error) {
          releasedBoth = false;
          log(
            `  WARNING: could not release the ${what} on workorder ${claim.workorderId} ` +
              `(${claim.positionId}/${claim.technicianId}): ${await formatError(error)}. ` +
              'The next reconciliation will count it busy until this is unpicked by hand.',
          );
        }
      }

      if (releasedBoth) {
        log(`  released ${claim.positionId}/${claim.technicianId} from workorder ${claim.workorderId}`);
        reclaimed.push(
          `workorder ${claim.workorderId} was left open by an interrupted run and was released rather than ` +
            'completed — it is not part of this run\'s completed work',
        );
      } else {
        // Kept in the journal: it is the only record of which bay is still stuck, and
        // clearing it would leave nothing for a later resume to retry or a human to find.
        stillStuck.push(claim);
        failures.push(
          `workorder ${claim.workorderId} is still holding ${claim.positionId}/${claim.technicianId} — ` +
            'the release failed and the bay stays out of service until it is unpicked by hand',
        );
      }
    }
    journal.recordOpenClaims(stillStuck);
    journal.flush();
  }

  // What the run is *asked* for, and what the timeline can actually still give.
  //
  // The anchors say how long the timeline was; by the time a suite is dispatched the
  // containers have been closing that gap since they booted, so some of it is already
  // spent. Asking the deployment to have been made longer than it was is the wrong
  // question — a run configured for the same length as the deployment could never
  // satisfy it. The run takes what is left instead, and says so.
  const requestedDays = options.days ?? accel.days;
  const drivableDays = Math.floor(first.remainingDays);
  const totalDays = Math.max(1, Math.min(requestedDays, drivableDays));
  if (totalDays < requestedDays) {
    log(
      `the clock has ${first.remainingDays.toFixed(1)} virtual day(s) left before it converges, so this ` +
        `run drives ${totalDays} of the ${requestedDays} configured (ITEST_ACCEL_DAYS). Re-dispatch the ` +
        'stack for a longer run.',
    );
  }
  const reports: DayReport[] = [];
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

    // Recorded before the day runs. After-hours mobile work can leave the clock on the
    // next calendar day, and `waitForNextDay` adds a day to whatever it is given — so
    // passing the *end* instant would skip a virtual day every time, and a 365-day run
    // would span two calendar years and converge halfway through.
    const dayStart = await clock.now();

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
      scrap: report.scrap,
    });
    for (const workorderId of report.workorderIds) {
      journal.recordWorkorder(workorderId, report.workorderKinds[workorderId]);
    }
    for (const invoiceId of report.invoiceIds) {
      journal.recordInvoice(invoiceId);
    }
    journal.recordOpenClaims([
      ...stillStuck,
      ...ledger.activeClaims().map((claim) => ({
        positionId: claim.position.id,
        technicianId: claim.technicianId,
        workorderId: claim.workorderId,
      })),
    ]);
    journal.flush();

    if (report.skipped === undefined) {
      log(
        `day ${report.dayNumber} (${report.virtualDate}): ${report.workordersCompleted} completed, ` +
          `${report.invoicesPaid} paid, ${report.estimatesDeclined} declined, ${report.carriedOut} carried` +
          `${report.workordersFailed > 0 ? `, ${report.workordersFailed} FAILED` : ''}`,
      );
    }

    // The next day begins when the virtual calendar says so — measured from this day's
    // start. Already past it (the work ran through midnight) returns at once.
    if (dayNumber < totalDays) {
      try {
        await timer.waitForNextDay(dayStart);
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
      scraps: reports.filter((report) => report.scrap).length,
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
    reclaimed,
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
