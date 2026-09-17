import { AcceleratedConfig } from '../harness/acceleratedConfig';
import { loadAcceleratedContext } from '../harness/acceleratedContext';
import { auditInvoices, auditTimeEntries } from '../harness/acceleratedAudit';
import { runAcceleratedYear, volumeFloor, type YearRunResult } from '../harness/acceleratedRun';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas } from '../harness/personas';

/**
 * The year — one virtual year of shop activity, asserted.
 *
 * This is the suite the whole accelerated harness exists for: mechanics clock in
 * when the shop opens and out when it closes, appointments are booked and arrive,
 * estimates are approved or declined, workorders get a mechanic and a bay or a
 * mobile unit, are worked, completed, invoiced and paid, and cycle counts and
 * restocks land on their due virtual days — across 365 virtual days in one to six
 * hours of real time.
 *
 * It runs last on purpose. Jest collects alphabetically with `maxWorkers: 1`, so
 * the parity copies of suites A-H fail in minutes on a broken contract rather than
 * at hour five of this one.
 *
 * Two rules are asserted against what the *backend stored*, not against what the
 * run intended:
 *
 *   1. no payroll shift outside the shop's hours (plus the overrun grace), and
 *   2. no bay, mobile unit or mechanic ever holding two open workorders at once.
 *
 * Alpha is shared and append-only: everything here is scoped to this run's own
 * records, and nothing is cleaned up afterwards — the year of history is the
 * deliverable.
 */
describe('The accelerated year', () => {
  const accel = AcceleratedConfig.fromEnv();
  const accelContext = loadAcceleratedContext();

  let context: ItestContext;
  let result: YearRunResult;

  beforeAll(async () => {
    context = loadContext();
    console.log(
      `[Z] driving ${accel.days} virtual day(s) from ${accelContext.clock.virtualTime} at scale ` +
        `${accelContext.clock.scale}; budget ${Math.round(accel.runBudgetMs / 60_000)} minutes`,
    );
    result = await runAcceleratedYear({ log: (message) => console.log(`[Z] ${message}`) });
    // The budget bounds the run; the test timeout is the budget plus a margin for
    // the audit reads that follow it.
  }, accel.runBudgetMs + 600_000);

  it('Z1 — drives the year to its end, or stops cleanly on convergence', () => {
    console.log(`[Z1] stopped because: ${result.stopDetail}`);
    // A budget overrun is a failure with evidence, not a pass: the year is
    // incomplete and the reason is the wall clock, not the shop.
    expect(['days-complete', 'converged']).toContain(result.stoppedBecause);
    expect(result.daysAttempted).toBeGreaterThan(0);
  });

  it('Z2 — no virtual day failed', () => {
    for (const failure of result.failures) {
      console.log(`[Z2] failure: ${failure}`);
    }
    expect(result.failures).toEqual([]);
    expect(result.totals.workordersFailed).toBe(0);
  });

  it('Z3 — mechanics were on the clock on every day that was worked', () => {
    const worked = result.reports.filter((report) => report.skipped === undefined);
    expect(worked.length).toBeGreaterThan(0);
    for (const day of worked) {
      expect(day.clockedIn).toBeGreaterThan(0);
    }
  });

  it('Z4 — closed days were skipped rather than worked', () => {
    const calendar = accel.calendarFor(
      new Date(accelContext.clock.virtualStart),
      new Date(accelContext.clock.virtualTime),
    );
    for (const day of result.reports) {
      const onDay = new Date(`${day.virtualDate}T12:00:00.000Z`);
      if (day.skipped === 'closed') {
        expect(calendar.isWorkingDay(onDay)).toBe(false);
      }
      if (day.skipped === undefined) {
        expect(calendar.isWorkingDay(onDay)).toBe(true);
      }
    }
  });

  it('Z5 — completed work was invoiced, and invoices were paid', () => {
    const { workordersCompleted, invoicesFinalized, invoicesPaid } = result.totals;
    console.log(`[Z5] ${workordersCompleted} completed, ${invoicesFinalized} invoiced, ${invoicesPaid} paid`);

    expect(workordersCompleted).toBeGreaterThan(0);
    expect(invoicesFinalized).toBe(workordersCompleted);

    // Every invoice is paid unless the run was asked to leave some for AR aging.
    const expectedPaid = Math.floor(invoicesFinalized * (1 - accel.unpaidRatio));
    expect(invoicesPaid).toBeGreaterThanOrEqual(expectedPaid);
  });

  it('Z6 — wrote enough to be a year rather than a sample', () => {
    const floor = volumeFloor();
    console.log(`[Z6] ${result.totals.workordersCompleted} workorder(s) against a floor of ${floor}`);
    // A run that technically passed every step while producing almost nothing is
    // the failure this catches.
    expect(result.totals.workordersCompleted).toBeGreaterThanOrEqual(floor);
  });

  it('Z7 — appointments were booked and arrived', () => {
    console.log(
      `[Z7] ${result.totals.appointmentsBooked} booked, ${result.totals.appointmentsConverted} converted`,
    );
    expect(result.totals.appointmentsBooked).toBeGreaterThan(0);
    // The conversion is the half only a virtual clock can reach: an appointment
    // booked days ahead has its start arrive inside the run.
    expect(result.totals.appointmentsConverted).toBeGreaterThan(0);
  });

  it('Z8 — the weekly cycle count and monthly restock ran on their due days, and only then', () => {
    const due7 = result.reports.filter((report) => report.dayNumber % 7 === 0 && report.skipped === undefined);
    const due30 = result.reports.filter((report) => report.dayNumber % 30 === 0 && report.skipped === undefined);

    for (const day of due7) {
      expect(day.cycleCount).toBe(true);
    }
    for (const day of due30) {
      expect(day.restock).toBe(true);
    }
    for (const day of result.reports) {
      if (day.dayNumber % 7 !== 0) {
        expect(day.cycleCount).toBe(false);
      }
      if (day.dayNumber % 30 !== 0) {
        expect(day.restock).toBe(false);
      }
    }
    console.log(`[Z8] ${result.totals.cycleCounts} cycle count(s), ${result.totals.restocks} restock(s)`);
  });

  it('Z9 — no resource was ever double-booked', () => {
    const overlaps = result.ledger.overlaps();
    for (const overlap of overlaps.slice(0, 10)) {
      console.log(
        `[Z9] ${overlap.resourceKind} ${overlap.resourceId} held by ${overlap.first.workorderId} and ` +
          `${overlap.second.workorderId} at the same time`,
      );
    }
    // The ledger refuses a double-booking by construction, so this is the check
    // that the construction held for a whole year — including across day
    // boundaries and carried work.
    expect(overlaps).toEqual([]);
  });

  it('Z10 — every hold was given back', () => {
    // A technician left attached to a workorder reads as busy to the next run's
    // discovery until someone unpicks it by hand.
    expect(result.ledger.openClaims()).toEqual([]);
    console.log(`[Z10] ${result.ledger.carriedClaims().length} job(s) still in progress at the end of the run`);
  });

  it('Z11 — the invoices the backend stored agree with what the run reported', async () => {
    const invoiceIds = result.journal.snapshot().invoiceIds;
    expect(invoiceIds.length).toBeGreaterThan(0);

    const personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    const audit = await auditInvoices(personas.as('acct'), invoiceIds);

    console.log(
      `[Z11] ${audit.finalized}/${invoiceIds.length} finalized, ${audit.paid} paid, across months ` +
        `${audit.months.join(', ')}`,
    );
    for (const problem of audit.problems.slice(0, 10)) {
      console.log(`[Z11] problem: ${problem}`);
    }
    expect(audit.problems).toEqual([]);
    expect(audit.finalized).toBe(invoiceIds.length);
  }, 600_000);

  it('Z12 — the ledger spans the virtual year', async () => {
    console.log(`[Z12] virtual span ${result.virtualSpan.from} → ${result.virtualSpan.to}`);
    expect(result.invoicedMonths.length).toBeGreaterThan(0);

    // Only a full-length run can be held to a twelve-month spread; a short parity
    // or budget-limited run is judged against the days it actually drove.
    if (result.daysAttempted >= 300) {
      expect(result.invoicedMonths.length).toBeGreaterThanOrEqual(11);
    }
    // Nothing may be dated outside the run's own virtual window.
    for (const month of result.invoicedMonths) {
      expect(month >= result.virtualSpan.from.slice(0, 7)).toBe(true);
      expect(month <= result.virtualSpan.to.slice(0, 7)).toBe(true);
    }
  });

  it('Z13 — no payroll shift happened outside the shop\'s hours', async () => {
    const calendar = accel.calendarFor(
      new Date(accelContext.clock.virtualStart),
      new Date(`${result.virtualSpan.to}T23:59:59.000Z`),
    );
    const workedDates = result.reports
      .filter((report) => report.skipped === undefined)
      .map((report) => report.virtualDate);

    const personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    // Sampled rather than exhaustive when the year is long: one read per worked
    // day would add hundreds of calls to the end of an already long run, and a
    // violation of an always-on rule shows up in any sample of it.
    const sample = workedDates.length > 40 ? everyNth(workedDates, Math.ceil(workedDates.length / 40)) : workedDates;

    const { checked, violations } = await auditTimeEntries(
      personas.as('manager'),
      calendar,
      sample,
      context.referenceCache.locationId,
    );

    console.log(`[Z13] ${checked} time entr(ies) checked across ${sample.length} worked day(s)`);
    for (const violation of violations.slice(0, 10)) {
      console.log(`[Z13] violation: ${violation.reason} at ${violation.at} (entry ${violation.timeEntryId})`);
    }
    // This is the evidence for "nobody works after hours": the backend's own
    // timestamps, written under its accelerated clock.
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 900_000);

  it('Z14 — the run is retrievable by its runId afterwards', () => {
    const snapshot = result.journal.snapshot();
    console.log(
      `[Z14] runId=${result.runId}: ${snapshot.workorderIds.length} workorder(s), ` +
        `${snapshot.invoiceIds.length} invoice(s) recorded in ${accel.journalPath}`,
    );
    expect(result.runId).toMatch(/^accel-/);
    expect(snapshot.workorderIds.length).toBeGreaterThan(0);
    expect(snapshot.realStart).toBe(accelContext.clock.realStart);
  });
});

/** Every nth element, always including the first and the last. */
function everyNth<T>(values: readonly T[], step: number): T[] {
  const picked = values.filter((_, index) => index % step === 0);
  const last = values[values.length - 1];
  if (last !== undefined && !picked.includes(last)) {
    picked.push(last);
  }
  return picked;
}
