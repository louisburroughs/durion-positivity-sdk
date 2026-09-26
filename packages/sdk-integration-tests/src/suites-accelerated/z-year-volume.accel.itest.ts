import { ADJUSTMENT_POSTED, awaitAccountingEvent, journalEntryOf, shapeOf } from '../harness/accounting';
import { AcceleratedConfig } from '../harness/acceleratedConfig';
import { loadAcceleratedContext } from '../harness/acceleratedContext';
import { auditInvoices, auditLaborSpans, auditTimeEntries } from '../harness/acceleratedAudit';
import { runAcceleratedYear, volumeFloor, type YearRunResult } from '../harness/acceleratedRun';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas } from '../harness/personas';
import type { PositionKind } from '../runs/shopFloorPlan';

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
 * It runs last on purpose, so the parity copies of suites A-H fail in minutes on a
 * broken contract rather than at hour five of this one. The `z-` prefix does not
 * achieve that on its own — Jest orders by recorded duration, slowest first, which
 * put this suite at the head and converged the clock out from under every suite
 * behind it. `jest.accelerated.sequencer.js` pins it here instead.
 *
 * Three rules are asserted against what the *backend stored*, not against what the
 * run intended:
 *
 *   1. no payroll shift outside the shop's hours (plus the overrun grace),
 *   2. no labor span crossing a night, and no bay's labor outside those hours, and
 *   3. no bay, mobile unit or mechanic ever holding two open workorders at once.
 *
 * The first two are separate on purpose. Payroll says the mechanic was in the
 * building; labor says the clock was running on the job. A run can get one right and
 * the other wrong, and the way labor is recorded here — two stamps the backend
 * subtracts, with no notion of opening hours between them — is what would do it.
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
    // Work an interrupted run left behind and this one released is reported separately:
    // a resume that cleanly reclaims its predecessor's bays is the journal working as
    // designed, not a failed day. A release that *failed* is a failure, and lands above.
    for (const note of result.reclaimed) {
      console.log(`[Z2] reclaimed on resume: ${note}`);
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

  it('Z8b — stock was written off on its due days, and every write-off reached a terminal state', async () => {
    const due10 = result.reports.filter((report) => report.dayNumber % 10 === 0 && report.skipped === undefined);
    for (const day of due10) {
      expect(day.scrap).toBe(true);
    }
    for (const day of result.reports) {
      if (day.dayNumber % 10 !== 0) {
        expect(day.scrap).toBe(false);
      }
    }

    // A year that wrote nothing off has not exercised the scrap path at all — every
    // candidate empty on every tenth day means the shop never held stock, which is
    // a finding about the run rather than a passing test.
    expect(result.totals.scraps).toBeGreaterThan(0);

    const personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    const parts = personas.as('parts');

    // Read back from the backend rather than from the run's own tally, for the
    // reason Z11 does: the report says what the harness believes, and the point of
    // the audit is to find out whether the backend agrees.
    const scraps = await parts.inventory.scrapsApi.listScraps({
      locationId: context.referenceCache.locationId,
    });
    const mine = scraps.filter((scrap) => (scrap.notes ?? '').includes(result.runId));
    console.log(`[Z8b] ${mine.length} scrap(s) for this run, of ${scraps.length} at the site`);

    expect(mine.length).toBeGreaterThan(0);

    // PENDING_APPROVAL is the one status the run must never leave behind: every
    // scrap it raises is either auto-approved on value or approved by the manager
    // before the day ends. FAILED is the backend refusing to post one it accepted,
    // which is worth failing the year over.
    const unsettled = mine.filter(
      (scrap) => scrap.status === 'PENDING_APPROVAL' || scrap.status === 'FAILED',
    );
    for (const scrap of unsettled.slice(0, 10)) {
      console.log(`[Z8b] unsettled scrap ${scrap.scrapId}: ${scrap.status} ${scrap.errorMessage ?? ''}`);
    }
    expect(unsettled).toEqual([]);

    // A posted write-off moved stock, so it must carry the SCRAP_OUT entry that
    // moved it. This is the inventory side only; what pos-accounting made of the
    // ScrapPostedV1 fact is suite E's subject (E26, E27), for a costed and an
    // uncosted SKU it controls.
    // APPROVED belongs here with the other two: E14 and the maintenance port both
    // treat it as posted, and leaving it out would drop exactly the write-offs the
    // manager approved — the ones most likely to have gone wrong — out of the audit
    // while the test still passed.
    const posted = mine.filter(
      (scrap) => scrap.status === 'POSTED' || scrap.status === 'AUTO_APPROVED' || scrap.status === 'APPROVED',
    );
    for (const scrap of posted) {
      expect(scrap.ledgerEntryId).toBeTruthy();
      expect(scrap.quantity ?? 0).toBeGreaterThan(0);
    }
    console.log(`[Z8b] ${posted.length} posted write-off(s), each with a ledger entry`);
  }, 600_000);

  it('Z8c — the GL moved 1300 Inventory by exactly what the count variances were worth', async () => {
    // The reconciliation ADR-0044 §4 demands of a fact-fed ledger: every count
    // variance the year posted reached the GL, and for costed SKUs the journal
    // entries move 1300 Inventory by the same signed value the inventory ledger
    // gave the variances — gains up, losses down. Uncosted variances are skipped by
    // design and reported by count, because a year of nothing but skips means the
    // shop never held a costed SKU, which the reconciliation cannot see past. The
    // monthly restock is a priced goods receipt, so restocked SKUs are costed.
    const ids = result.journal.cycleCountAdjustmentIds;
    if (result.totals.cycleCounts > 0) {
      expect(ids.length).toBeGreaterThan(0);
    }

    const personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    const admin = personas.as('admin');
    const waitMs = Math.max(ItestConfig.fromEnv().waitTimeoutMs, 60_000);

    let inventoryValue = 0;
    let glValue = 0;
    let costed = 0;
    let skipped = 0;
    const mismatches: string[] = [];

    for (const adjustmentId of ids) {
      const adjustment = await admin.inventory.cycleCountAdjustmentsApi.getCycleCountAdjustment({ adjustmentId });
      if (!adjustment.ledgerEntryId) {
        // The count port raises task-less adjustments with a non-zero variance, so
        // there is no recompute-to-zero path: an approval with no ledger row is a
        // posting that failed, and a fact that was never produced.
        mismatches.push(`${adjustmentId}: approved as ${adjustment.status} with no ledger entry`);
        continue;
      }
      const entry = await admin.inventory.inventoryLedgerApi.getInventoryLedgerEntry({
        entryId: adjustment.ledgerEntryId,
      });
      const unitCost = Number(entry.unitCost ?? 0);
      const event = await awaitAccountingEvent(admin, ADJUSTMENT_POSTED, adjustmentId, waitMs);

      if (unitCost <= 0) {
        skipped += 1;
        if (event.status !== 'SKIPPED' || event.failureReasonCode !== 'UNCOSTED_FACT' || event.journalEntryId) {
          mismatches.push(`${adjustmentId}: uncosted but ${event.status} ${event.failureReasonCode ?? ''}`);
        }
        continue;
      }

      costed += 1;
      const value = Number(entry.changeInQuantity) * unitCost;
      inventoryValue += value;
      if (event.status !== 'PROCESSED' || !event.journalEntryId) {
        mismatches.push(`${adjustmentId}: costed at ${unitCost} but ${event.status} with no entry`);
        continue;
      }
      const moved = shapeOf(await journalEntryOf(admin, event.journalEntryId)).inventoryNet;
      glValue += moved;
      if (Math.abs(moved - value) >= 0.01) {
        mismatches.push(`${adjustmentId}: ledger ${value.toFixed(4)} vs GL 1300 ${moved.toFixed(4)}`);
      }
    }

    console.log(
      `[Z8c] ${ids.length} count adjustment(s): ${costed} costed, ${skipped} skipped as uncosted; ` +
        `inventory ledger ${inventoryValue.toFixed(2)} vs GL 1300 ${glValue.toFixed(2)}`,
    );
    for (const mismatch of mismatches.slice(0, 10)) {
      console.log(`[Z8c] ${mismatch}`);
    }
    expect(mismatches).toEqual([]);
    expect(Math.abs(glValue - inventoryValue)).toBeLessThan(0.01 * Math.max(1, costed));
  }, 1_800_000);

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

    // Every worked date, not a sample. An earlier version read at most 40 of them,
    // which meant a violation on an unsampled date passed silently — unacceptable
    // for the assertion that *is* the compliance claim. One extra read per worked
    // day is a few hundred calls at the end of a run that already took hours.
    const { checked, violations } = await auditTimeEntries(
      personas.as('manager'),
      calendar,
      workedDates,
      context.referenceCache.locationId,
    );

    console.log(`[Z13] ${checked} time entr(ies) checked across ${workedDates.length} worked day(s)`);
    for (const violation of violations.slice(0, 10)) {
      console.log(`[Z13] violation: ${violation.reason} at ${violation.at} (entry ${violation.timeEntryId})`);
    }
    // This is the evidence for "nobody works after hours": the backend's own
    // timestamps, written under its accelerated clock.
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  }, 900_000);

  it("Z13b — no labor span crosses a night or ran outside the shop's hours", async () => {
    // Z13 is the payroll side — the person was in the building. This is the workorder
    // side: the clock that runs on the job itself. They can disagree, and the way this
    // run records labor is exactly what would make them: the backend computes a labor
    // entry's hours by subtracting its two stamps and knows nothing about opening
    // hours, so a session the day runner failed to suspend at close books the whole
    // night as worked and still looks like a clean row.
    const calendar = accel.calendarFor(
      new Date(accelContext.clock.virtualStart),
      new Date(`${result.virtualSpan.to}T23:59:59.000Z`),
    );

    // Both taken from the journal, and deliberately not from the ledger. The journal
    // spans the whole year including the days an earlier process drove, while the
    // ledger only knows this process's claims — auditing a resumed run against the
    // ledger would classify every workorder from before the restart as a bay and
    // report all of their legitimate mobile spans as violations.
    //
    // The ids include jobs still carried at the end of the run, which are the ones most
    // likely to be holding a labor entry open, because the runner records a workorder
    // when the job first has one rather than when it finishes.
    const snapshot = result.journal.snapshot();
    const workorderIds = snapshot.workorderIds;
    const kindByWorkorderId = new Map<string, PositionKind>(
      Object.entries(snapshot.workorderKinds ?? {}) as Array<[string, PositionKind]>,
    );
    expect(workorderIds.length).toBeGreaterThan(0);
    // A missing classification silently becomes BAY inside the audit, which is the
    // stricter reading but would report a mobile job wrongly. Catch the gap here, where
    // the message says what actually went wrong, rather than as a confusing violation.
    const unclassified = workorderIds.filter((id) => !kindByWorkorderId.has(id));
    expect(unclassified).toEqual([]);

    const personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    const { checked, violations } = await auditLaborSpans(
      personas.as('tech'),
      calendar,
      workorderIds,
      kindByWorkorderId,
    );

    console.log(`[Z13b] ${checked} labor entr(ies) checked across ${workorderIds.length} workorder(s)`);
    for (const violation of violations.slice(0, 10)) {
      console.log(
        `[Z13b] violation: ${violation.reason} at ${violation.at} ` +
          `(entry ${violation.entryId}, workorder ${violation.workorderId})`,
      );
    }
    // The evidence that the suspend-and-resume actually fired: every span opens and
    // closes on one virtual date, and no mechanic is still on a job.
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
