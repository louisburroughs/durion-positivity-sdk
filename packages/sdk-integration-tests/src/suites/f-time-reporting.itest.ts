import { randomUUID } from 'crypto';
import { SeederRandom } from '@durion-sdk/seeder';
import {
  addLaborLine,
  approveAndPromote,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  readString,
  seedFromRunId,
  type BuilderContext,
  type CreatedCustomer,
  type PromotedWorkorder,
} from '../harness/builders';
import { call, expectHttpError, isHttpStatus } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas, type DomainClients } from '../harness/personas';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite F — reporting time and deciding on it, across the two clocks the
 * backend keeps.
 *
 * They are genuinely different things and the suite treats them separately.
 * pos-workorder's labor entries bill a technician's time to one service line on
 * one workorder; pos-people's work sessions are the payroll clock — clock in,
 * break, clock out, submit — and know nothing about workorders. F1-F7 cover the
 * first, F8-F9 the second.
 *
 * **A gap the approval tests are shaped around.** Nothing in either service
 * creates a decidable time entry. pos-workorder's `time_entry` table has an
 * approve and a reject endpoint and no writer at all; pos-people's
 * `timekeeping_entry` is fed by `TimekeepingIngestionService.ingestWorkSession`,
 * whose `WorkSessionCompletedEvent` is published nowhere outside that service's
 * own unit tests — submitting a work session does not raise it. So no call this
 * suite can make will ever move an entry to APPROVED, and a test that waited for
 * one would hang rather than report the cause.
 *
 * F10-F12 therefore assert what *is* reachable and stays true either way: who
 * the decision belongs to, and the documented shapes of the batch contract —
 * an unknown entry comes back as a per-entry failure rather than a failed
 * batch, a rejection with no reason is refused outright. When the ingestion
 * bridge lands, those tests keep passing and a positive approval belongs
 * alongside them.
 */
describe('Suite F — time reporting and approval', () => {
  const LABOR_PRICE = 132.5;
  const ADJUSTED_HOURS = 2.25;
  const BILLABLE_MINUTES = 135;
  const BREAK_MINUTES = 30;

  let context: ItestContext;
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let manager: DomainClients;
  let tech: DomainClients;

  let customer: CreatedCustomer;
  let promoted: PromotedWorkorder;
  let workorderId: string;
  let serviceIds: string[];
  let serviceItemId: string;
  let technicianId: string;
  let locationId: string;

  let laborEntryId: string;
  let workSessionId: string;

  /**
   * Closes whatever payroll session the person already has open, the way the
   * seeder's ShiftSimulator does. Alpha is shared and its loop clocks the same
   * seeded employees in and out, so a run that assumed a clean slate would fail
   * its first clock-in with a conflict caused by someone else.
   */
  const clockOutIfClockedIn = async (as: DomainClients, personId: string): Promise<void> => {
    try {
      await as.people.workSessionsAPIApi.stopWorkSession({ workSessionRequest: { personId } });
    } catch (error) {
      // 404: no open session, which is the state this is trying to reach.
      if (!isHttpStatus(error, 404)) {
        throw error;
      }
    }
  };

  const isoDate = (offsetDays: number): Date => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date;
  };

  beforeAll(async () => {
    context = loadContext();
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    advisor = personas.as('advisor');
    admin = personas.as('admin');
    manager = personas.as('manager');
    tech = personas.as('tech');
    ctx = {
      runId: context.runId,
      // Seeded per suite, not per run: a shared seed makes every suite generate
      // the same VIN, and VINs are globally unique across active vehicles.
      random: new SeederRandom(seedFromRunId(`${context.runId}:f-time-reporting`)),
      refs: context.referenceCache,
    };

    locationId = context.referenceCache.locationId;
    technicianId = context.referenceCache.employees.technicians[0];
    serviceIds = context.referenceCache.serviceEntityIds.slice(0, 2);

    const party = await createPersonAccount(advisor, ctx);
    customer = party;
    const vehicleId = await createVehicle(admin, ctx, party.partyId);
    const estimateId = await createDraftEstimate(advisor, ctx, party.partyId, vehicleId);
    await addLaborLine(advisor, ctx, estimateId, serviceIds[0], LABOR_PRICE);
    promoted = await approveAndPromote(advisor, ctx, estimateId, party);
    workorderId = promoted.workorderId;
    serviceItemId = promoted.serviceItemMap.get(serviceIds[0])!;

    await call('approveWorkorder', () =>
      manager.workorder.workOrderAPIApi.approveWorkorder({
        workorderId,
        approveWorkorderRequest: {
          customerId: customer.partyId,
          signatureData: ctx.random.base64(32),
          signerName: customer.fullName,
          signatureMimeType: 'image/png',
          notes: `Integration test approval [${context.runId}]`,
        },
      }),
    );
    await call('assignTechnician', () =>
      manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId,
        assignTechnicianRequest: {
          technicianId,
          notes: `Integration test assignment [${context.runId}]`,
        },
      }),
    );
    // Labor entries need the workorder past approval; starting it is what the
    // technician does before touching the car.
    await call('startWorkorder', () =>
      tech.workorder.operationalContextApi.startWorkorder({ workorderId }),
    );
    console.log(`[F] workorder ${workorderId}, service item ${serviceItemId}, technician ${technicianId}`);
  }, 300_000);

  it('F1 — the technician opens a labor session on the service line', async () => {
    const entry = await call('startLaborSession', () =>
      tech.workorder.workorderLaborAPIApi.startLaborSession({
        workorderId,
        serviceId: serviceItemId,
        startLaborRequest: {
          technicianId,
          notes: `Integration test labor [${context.runId}]`,
        },
      }),
    );
    laborEntryId = entry.id;
    console.log(`[F1] labor entry ${laborEntryId} active=${entry.active} start=${entry.startTime?.toISOString()}`);

    expect(entry.workorderId).toBe(workorderId);
    expect(entry.active).toBe(true);
    expect(entry.startTime).toBeDefined();
    expect(entry.endTime).toBeUndefined();
    expect(entry.technicianId).toBe(technicianId);
  }, 180_000);

  it('F2 — a second session on the same service is refused while one is open', async () => {
    const status = await expectHttpError(
      tech.workorder.workorderLaborAPIApi.startLaborSession({
        workorderId,
        serviceId: serviceItemId,
        startLaborRequest: { technicianId },
      }),
      400,
      409,
    );
    console.log(`[F2] a concurrent labor session on one service is rejected with HTTP ${status}`);
  }, 120_000);

  it('F3 — stopping the session records the hours worked', async () => {
    // Real elapsed time: hoursWorked is derived from the wall clock, and a stop
    // in the same millisecond as the start proves nothing.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const stopped = await call('stopLaborSession', () =>
      tech.workorder.workorderLaborAPIApi.stopLaborSession({ workorderId, entryId: laborEntryId }),
    );
    console.log(`[F3] labor entry ${laborEntryId} closed, hours=${stopped.hoursWorked}`);

    expect(stopped.id).toBe(laborEntryId);
    expect(stopped.active).toBe(false);
    expect(stopped.endTime).toBeDefined();
    expect(stopped.hoursWorked).toBeDefined();
    expect(Number(stopped.hoursWorked)).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it('F4 — the manager can read the labor history the technician recorded', async () => {
    const history = await call('getLaborHistory', () =>
      manager.workorder.workorderLaborAPIApi.getLaborHistory({ workorderId }),
    );
    console.log(`[F4] workorder ${workorderId} has ${history.length} labor entr(ies)`);

    const entry = history.find((item) => item.id === laborEntryId);
    expect(entry).toBeDefined();
    expect(entry?.active).toBe(false);
    expect(entry?.technicianId).toBe(technicianId);
  }, 120_000);

  it('F5 — the technician adjusts the recorded hours and the adjustment carries its reason', async () => {
    const adjusted = await call('adjustLaborHours', () =>
      tech.workorder.workorderLaborAPIApi.adjustLaborHours({
        workorderId,
        entryId: laborEntryId,
        adjustLaborRequest: {
          hoursWorked: ADJUSTED_HOURS,
          adjustmentReason: `Integration test correction [${context.runId}]`,
        },
      }),
    );
    console.log(`[F5] hours adjusted to ${adjusted.hoursWorked} (${adjusted.adjustmentReason})`);

    expect(Number(adjusted.hoursWorked)).toBe(ADJUSTED_HOURS);
    expect(adjusted.adjustmentReason).toContain(context.runId);
  }, 120_000);

  // workorder:labor:add is granted to TECHNICIAN and ADMIN only. The manager
  // reads labor (F4) but does not write it, which is why the correction above
  // is the technician's to make.
  itInRoleMode('F6 — the manager cannot rewrite the technician\'s hours', async () => {
    const status = await expectHttpError(
      manager.workorder.workorderLaborAPIApi.adjustLaborHours({
        workorderId,
        entryId: laborEntryId,
        adjustLaborRequest: {
          hoursWorked: 99,
          adjustmentReason: 'Integration test: should be refused',
        },
      }),
      401,
      403,
    );
    console.log(`[F6] LOCATION_MANAGER refused workorder:labor:add with HTTP ${status}`);
  }, 120_000);

  it('F7 — a running timer is visible to its own technician, and job totals report the day', async () => {
    await call('startTimer', () =>
      tech.workorder.workexecTimeTrackingAPIApi.startTimer({
        workexecTimerStartRequest: {
          workorderId,
          workorderItemId: serviceItemId,
          laborCode: serviceIds[0],
        },
      }),
    );

    // getActiveTimers reads the authenticated user's own timers, so this is the
    // technician asking what they have running - not a supervisor view.
    const active = await call('getActiveTimers', () =>
      tech.workorder.workexecTimeTrackingAPIApi.getActiveTimers(),
    );
    console.log(`[F7] active timer: ${JSON.stringify(active).slice(0, 200)}`);
    expect(readString(active, 'workorderId')).toBe(workorderId);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stopped = await call('stopTimers', () =>
      tech.workorder.workexecTimeTrackingAPIApi.stopTimers(),
    );
    expect(stopped.stopped?.length ?? 0).toBeGreaterThan(0);

    const totals = await call('getJobTimeTotals', () =>
      manager.workorder.workexecTimeTrackingAPIApi.getJobTimeTotals({
        startDate: isoDate(-1),
        endDate: isoDate(0),
        timezone: 'UTC',
        locationId,
      }),
    );
    console.log(`[F7] job time totals: ${JSON.stringify(totals).slice(0, 300)}`);
    expect(totals).toBeDefined();
  }, 240_000);

  it('F8 — the technician clocks in, takes a break, clocks out and submits the session', async () => {
    await clockOutIfClockedIn(tech, technicianId);

    const started = await call('startWorkSession', () =>
      tech.people.workSessionsAPIApi.startWorkSession({ workSessionRequest: { personId: technicianId } }),
    );
    workSessionId = started.sessionId;
    console.log(`[F8] session ${workSessionId} status=${started.status}`);
    expect(started.personId).toBe(technicianId);
    expect(started.status).toBe('ACTIVE');

    const breakStarted = await call('startWorkSessionBreak', () =>
      tech.people.workSessionsAPIApi.startWorkSessionBreak({ id: workSessionId }),
    );
    expect(breakStarted.sessionId).toBe(workSessionId);
    expect(breakStarted.endedAt).toBeUndefined();

    const breakStopped = await call('stopWorkSessionBreak', () =>
      tech.people.workSessionsAPIApi.stopWorkSessionBreak({ id: workSessionId }),
    );
    expect(breakStopped.endedAt).toBeDefined();

    const ended = await call('stopWorkSession', () =>
      tech.people.workSessionsAPIApi.stopWorkSession({ workSessionRequest: { personId: technicianId } }),
    );
    console.log(`[F8] session ${workSessionId} -> ${ended.status}`);
    expect(ended.status).toBe('ENDED');
    expect(ended.endedAt).toBeDefined();

    const submitted = await call('submitWorkSession', () =>
      tech.people.workSessionsAPIApi.submitWorkSession({
        id: workSessionId,
        workSessionSubmitRequest: {
          billableMinutes: BILLABLE_MINUTES,
          breakMinutes: BREAK_MINUTES,
          submittedAt: new Date(),
        },
      }),
    );
    console.log(`[F8] session ${workSessionId} -> ${submitted.status}`);
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.billableMinutes).toBe(BILLABLE_MINUTES);
    expect(submitted.breakMinutes).toBe(BREAK_MINUTES);
  }, 240_000);

  it('F9 — a session that is already submitted cannot be submitted again, and neither clock accepts a double start', async () => {
    const resubmitted = await expectHttpError(
      tech.people.workSessionsAPIApi.submitWorkSession({
        id: workSessionId,
        workSessionSubmitRequest: {
          billableMinutes: BILLABLE_MINUTES,
          breakMinutes: BREAK_MINUTES,
          submittedAt: new Date(),
        },
      }),
      409,
    );
    console.log(`[F9] re-submitting a SUBMITTED session refused with HTTP ${resubmitted}`);

    const opened = await call('startWorkSession', () =>
      tech.people.workSessionsAPIApi.startWorkSession({ workSessionRequest: { personId: technicianId } }),
    );
    const doubled = await expectHttpError(
      tech.people.workSessionsAPIApi.startWorkSession({ workSessionRequest: { personId: technicianId } }),
      409,
    );
    console.log(`[F9] session ${opened.sessionId} open; a second clock-in refused with HTTP ${doubled}`);

    // Leave the person clocked out: the seeder's shift loop shares these
    // employees and a session left open outlives this run.
    await clockOutIfClockedIn(tech, technicianId);
  }, 180_000);

  itInRoleMode('F10 — timekeeping is the manager\'s to see, not the technician\'s', async () => {
    const periods = await call('listTimePeriods', () =>
      manager.people.timekeepingApprovalAPIApi.listTimePeriods({}),
    );
    console.log(`[F10] ${periods.length} pay period(s) visible to LOCATION_MANAGER`);
    expect(Array.isArray(periods)).toBe(true);

    // Pay periods are opened by the scheduled rollover, not by this suite, so
    // whether one exists is an environment fact. When there is one, read the
    // technician's standing through it; when there is not, the authorization
    // assertions below still carry the test.
    if (periods.length > 0) {
      const period = periods[0];
      const approval = await call('getTimePeriodApproval', () =>
        manager.people.timekeepingApprovalAPIApi.getTimePeriodApproval({
          personId: technicianId,
          timePeriodId: period.timePeriodId,
        }),
      );
      console.log(
        `[F10] period ${period.timePeriodId} (${period.status}): ${approval.totalCount} entr(ies), ` +
          `${approval.pendingCount} pending`,
      );
      expect(approval.personId).toBe(technicianId);
      expect(approval.totalCount).toBe(
        approval.pendingCount + approval.approvedCount + approval.rejectedCount,
      );
    } else {
      console.log('[F10] no pay period exists on this environment; skipped the per-period read');
    }

    const status = await expectHttpError(
      tech.people.timekeepingApprovalAPIApi.listTimePeriods({}),
      401,
      403,
    );
    console.log(`[F10] TECHNICIAN refused people:timekeeping:view with HTTP ${status}`);
  }, 180_000);

  it('F11 — an unknown pay period is a 404, not an empty timesheet', async () => {
    const status = await expectHttpError(
      manager.people.timekeepingApprovalAPIApi.listTimekeepingEntries({
        personId: technicianId,
        timePeriodId: randomUUID(),
      }),
      404,
    );
    console.log(`[F11] entries for an unknown pay period refused with HTTP ${status}`);
  }, 120_000);

  it('F12 — the batch decision contract: unknown entries fail per row, a reasonless rejection fails outright', async () => {
    const unknownEntryId = randomUUID();

    // The documented shape: one bad id does not sink the batch. The response is
    // a 200 carrying a per-entry NOT_FOUND, which is what a UI approving a
    // screenful of rows depends on.
    const approved = await call('approveTimeEntriesBatch', () =>
      manager.people.timeEntryApprovalAPIApi.approveTimeEntriesBatch({
        timeEntryDecisionBatchRequest: { decisions: [{ timeEntryId: unknownEntryId }] },
      }),
    );
    console.log(`[F12] batch approve of an unknown entry: ${JSON.stringify(approved).slice(0, 300)}`);
    expect(JSON.stringify(approved)).toContain('NOT_FOUND');

    // A rejection is different: a missing reason is refused before any entry is
    // touched, so it is a 400 rather than a per-entry failure.
    const reasonless = await expectHttpError(
      manager.people.timeEntryApprovalAPIApi.rejectTimeEntriesBatch({
        timeEntryDecisionBatchRequest: { decisions: [{ timeEntryId: unknownEntryId }] },
      }),
      400,
    );
    console.log(`[F12] a rejection with no reason refused with HTTP ${reasonless}`);

    // An empty batch is a validation failure, not a no-op success.
    const empty = await expectHttpError(
      manager.people.timeEntryApprovalAPIApi.approveTimeEntriesBatch({
        timeEntryDecisionBatchRequest: { decisions: [] },
      }),
      400,
    );
    console.log(`[F12] an empty decision batch refused with HTTP ${empty}`);
  }, 180_000);

  itInRoleMode('F13 — deciding on workorder time entries belongs to the manager, and an unknown entry is a 404', async () => {
    const refused = await expectHttpError(
      tech.workorder.timeEntryAPIApi.approveTimeEntry({ timeEntryId: randomUUID() }),
      401,
      403,
    );
    console.log(`[F13] TECHNICIAN refused workorder:timeEntry:approve with HTTP ${refused}`);

    const missing = await expectHttpError(
      manager.workorder.timeEntryAPIApi.approveTimeEntry({ timeEntryId: randomUUID() }),
      404,
    );
    console.log(`[F13] approving an unknown workorder time entry refused with HTTP ${missing}`);

    const reasonless = await expectHttpError(
      manager.workorder.timeEntryAPIApi.rejectTimeEntry({
        timeEntryId: randomUUID(),
        rejectTimeEntryRequest: { rejectionReason: 'Integration test: unknown entry' },
      }),
      404,
    );
    console.log(`[F13] rejecting an unknown workorder time entry refused with HTTP ${reasonless}`);
  }, 180_000);
});
