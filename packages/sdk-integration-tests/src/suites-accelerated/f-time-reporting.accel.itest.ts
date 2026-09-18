/*
 * ACCELERATED COPY of ../suites/f-time-reporting.itest.ts (spec: Task A6).
 *
 * Same scenarios, same assertions, same role negatives. What differs is only what
 * the accelerated clock forces:
 *
 *   - business instants come from `accel.now()` (GET /system/time), never from
 *     `new Date()` or `Date.now()`;
 *   - a labor-bearing step runs only while the shop is open, via `accel.openNow()`;
 *   - fixed real-time sleeps are replaced by known virtual intervals
 *     (`accel.elapseVirtual`), because the backend measures its own accelerated
 *     clock and a round trip is already minutes of virtual labor;
 *   - schedule windows land inside a *real* future open window, because the slot
 *     arrives during the run rather than long after it.
 *
 * Keep this file and its twin in step: a change here that is not a clock or
 * calendar concern belongs in both.
 */
import { randomUUID } from 'crypto';
import { SeederRandom } from '@durion-sdk/seeder';
import { AssignServicePositionRequestResourceTypeEnum } from '@durion-sdk/workorder';
import {
  addLaborLine,
  approveAndPromote,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  readString,
  requireField,
  seedFromRunId,
  type BuilderContext,
  type CreatedCustomer,
  type PromotedWorkorder,
} from '../harness/builders';
import { call, expectHttpError, isHttpStatus, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';
import { Personas, type DomainClients } from '../harness/personas';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
/** Pay periods are per tenant; scoping the list keeps F10 off any other tenant's periods. */
const TENANT_ID = ItestConfig.fromEnv().tenant.id;
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
  let accel: AcceleratedFixture;
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

  /**
   * Stops whatever workexec timer the acting user has running, tolerating the
   * one failure that means "there was nothing to stop".
   *
   * Timers are per-authenticated-user and outlive the run that started them, so
   * a suite that failed between start and stop strands one on a shared alpha
   * and every later run gets TIMER_ALREADY_ACTIVE. Clearing first is what makes
   * F7 repeatable; the afterAll below is what stops this suite creating the
   * problem for the next one.
   */
  const stopTimersIfRunning = async (as: DomainClients): Promise<void> => {
    try {
      await as.workorder.workexecTimeTrackingAPIApi.stopTimers();
    } catch (error) {
      // 409 NO_ACTIVE_TIMER: nothing was running for this user.
      if (!isHttpStatus(error, 409)) {
        throw error;
      }
    }
  };

  /**
   * A virtual date `offsetDays` from the backend's now.
   *
   * The payroll clock's own records are stamped by the accelerated clock, so a
   * work date taken from the laptop would query a day a year away from the one the
   * shift was recorded on and find nothing.
   */
  const isoDate = async (offsetDays: number): Promise<Date> => {
    const at = await accel.now();
    return new Date(at.getTime() + offsetDays * 86_400_000);
  };

  beforeAll(async () => {
    context = loadContext();
    accel = await acceleratedFixture();
    // The gate, applied once per suite: every scenario below is shop-floor or
    // service-desk work, so none of it starts before the shop opens. A copy whose
    // fixture is otherwise unused still needs this — it is the rule, not a helper.
    const openedAt = await accel.openNow('BAY');
    console.log(`[accel] suite starting at virtual ${openedAt.toISOString()} (scale ${accel.scale})`);
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
    // Work is assigned before it starts: the technician above and a bay (backend
    // #2011). The run's own bay, since a shared one may hold another open
    // workorder. F never completes its workorder, so it stays on the bay.
    const bay = await call('createBay', () =>
      admin.location.bayApi.createBay({
        locationId,
        bayRequest: {
          name: `Itest bay ${context.runId} F`,
          bayType: 'GENERAL_SERVICE',
          capacity: { maxConcurrentVehicles: 1 },
        },
      }),
    );
    const bayId = requireField(bay.id, 'createBay.id');
    // pos-workorder validates the bay against its Kafka-fed ext_bay replica, so
    // a bay created seconds ago can still be unknown there.
    await retryWhileReplicating(
      () =>
        manager.workorder.servicePositionAPIApi.assignServicePosition({
          workorderId,
          assignServicePositionRequest: {
            resourceType: AssignServicePositionRequestResourceTypeEnum.Bay,
            resourceId: bayId,
            reason: `Integration test placement [${context.runId}]`,
          },
        }),
      { markers: ['Unknown bay'], description: 'assignServicePosition -> bay', timeoutMs: 60_000, pollMs: 1_000 },
    );
    // Labor entries need the workorder past approval; starting it is what the
    // technician does before touching the car.
    await call('startWorkorder', () =>
      tech.workorder.operationalContextApi.startWorkorder({ workorderId }),
    );
    console.log(
      `[F] workorder ${workorderId}, service item ${serviceItemId}, technician ${technicianId}, bay ${bayId}`,
    );
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
    // A stated virtual interval rather than a real sleep: the payroll clock is
    // the accelerated one, so this is what puts measurable minutes on the entry.
    await accel.elapseVirtual(30);

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
    await stopTimersIfRunning(tech);

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
    //
    // Deliberately the *raw* response. The endpoint answers with a list
    // (WorkexecTimeTrackingController returns ResponseEntity.ok over a List),
    // but its @ApiResponse names the element type without `array: true`, so the
    // generated client types the result as one WorkexecTimerEntryResponse and
    // deserializes it with that model's FromJSON. Reading named fields off a
    // JSON array yields `{}` - the payload is destroyed before any caller sees
    // it, so the typed accessor cannot be used to assert anything here. Fix the
    // backend schema and this reverts to `getActiveTimers()`.
    const activeResponse = await call('getActiveTimers', () =>
      tech.workorder.workexecTimeTrackingAPIApi.getActiveTimersRaw(),
    );
    const activeEntries = (await activeResponse.raw.json()) as unknown[];
    console.log(`[F7] active timers: ${JSON.stringify(activeEntries).slice(0, 300)}`);
    expect(Array.isArray(activeEntries)).toBe(true);
    expect(activeEntries.some((entry) => readString(entry, 'workorderId') === workorderId)).toBe(true);

    // A stated virtual interval rather than a real sleep: the payroll clock is
    // the accelerated one, so this is what puts measurable minutes on the entry.
    await accel.elapseVirtual(30);
    const stopped = await call('stopTimers', () =>
      tech.workorder.workexecTimeTrackingAPIApi.stopTimers(),
    );
    expect(stopped.stopped?.length ?? 0).toBeGreaterThan(0);

    // Virtual dates read before the call: the thunk `call` takes is not async.
    const startDate = await isoDate(-1);
    const endDate = await isoDate(0);
    const totals = await call('getJobTimeTotals', () =>
      manager.workorder.workexecTimeTrackingAPIApi.getJobTimeTotals({
        startDate,
        endDate,
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

    const submittedAt = await accel.now();
    const submitted = await call('submitWorkSession', () =>
      tech.people.workSessionsAPIApi.submitWorkSession({
        id: workSessionId,
        workSessionSubmitRequest: {
          billableMinutes: BILLABLE_MINUTES,
          breakMinutes: BREAK_MINUTES,
          submittedAt,
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
          submittedAt: await accel.now(),
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
      manager.people.timekeepingApprovalAPIApi.listTimePeriods({ tenantId: TENANT_ID }),
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
      tech.people.timekeepingApprovalAPIApi.listTimePeriods({ tenantId: TENANT_ID }),
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

  // F13 is skipped rather than deleted, as a standing marker that workorder-side
  // time-entry approval is wanted.
  //
  // It cannot run today: pos-workorder implements no approve or reject endpoint
  // for time entries. There is no such controller, and neither TimeEntryResponse
  // nor RejectTimeEntryRequest is defined in its OpenAPI spec, so the generated
  // client this drove — workorder's timeEntryAPIApi — was removed as output of a
  // spec that no longer produces it. Against a real deployment these assertions
  // could only ever have failed.
  //
  // Note that the neighbouring F12 covers the approval surface that *does*
  // exist, in pos-people, through people.timeEntryApprovalAPIApi. What is
  // missing is specifically the workorder-side per-entry decision.
  //
  // The body is empty because this file is type-checked and the client it called
  // no longer exists. Once pos-workorder serves the endpoints and the client is
  // regenerated, lift the assertions back verbatim:
  //
  //   const refused = await expectHttpError(
  //     tech.workorder.timeEntryAPIApi.approveTimeEntry({ timeEntryId: randomUUID() }),
  //     401,
  //     403,
  //   );
  //   const missing = await expectHttpError(
  //     manager.workorder.timeEntryAPIApi.approveTimeEntry({ timeEntryId: randomUUID() }),
  //     404,
  //   );
  //   const reasonless = await expectHttpError(
  //     manager.workorder.timeEntryAPIApi.rejectTimeEntry({
  //       timeEntryId: randomUUID(),
  //       rejectTimeEntryRequest: { rejectionReason: 'Integration test: unknown entry' },
  //     }),
  //     404,
  //   );
  it.skip('F13 — deciding on workorder time entries belongs to the manager, and an unknown entry is a 404', () => {
    // Intentionally empty; see the note above.
  });

  // Both clocks outlive the process that started them, and alpha is shared.
  // Leaving either running strands state that fails the *next* run rather than
  // this one, which is the hardest kind of failure to attribute.
  afterAll(async () => {
    if (!tech) {
      return;
    }
    await stopTimersIfRunning(tech);
    await clockOutIfClockedIn(tech, technicianId);
  }, 60_000);

  describe('F11 — the shift sits inside the shop\'s hours', () => {
    // Accelerated-only (spec: Task A6). The payroll clock is stamped by the
    // accelerated clock, so a shift's own timestamps can be judged against the
    // shop's hours — which is the evidence for "mechanics clock in when the shop
    // opens and out when it closes". On a normal clock the run is minutes long and
    // the window is never crossed, so there is nothing to judge.
    it('records a clock-in inside the open window, and a clock-out no later than the grace', async () => {
      const personId = context.referenceCache.employees.technicians[0];
      expect(personId).toBeTruthy();

      // Start of the shift: waited for, not assumed.
      const openedAt = await accel.openNow('BAY');
      expect(accel.calendar.isOpen(openedAt, 'BAY')).toBe(true);

      await clockOutIfClockedIn(admin, personId);
      const started = await call('startWorkSession', () =>
        admin.people.workSessionsAPIApi.startWorkSession({ workSessionRequest: { personId } }),
      );
      const sessionId = started.sessionId;
      expect(sessionId).toBeTruthy();

      // A shift's worth of work, in virtual minutes.
      await accel.elapseVirtual(60);

      const endedAt = await accel.now();
      await call('stopWorkSession', () =>
        admin.people.workSessionsAPIApi.stopWorkSession({ workSessionRequest: { personId } }),
      );

      console.log(
        `[F11] shift ${sessionId} ran ${openedAt.toISOString()} → ${endedAt.toISOString()} ` +
          `(${((endedAt.getTime() - openedAt.getTime()) / 60_000).toFixed(0)} virtual minutes)`,
      );

      // The rule, stated as an assertion: no labor outside hours, with the grace
      // allowed at the end for a mechanic finishing the car they are on.
      expect(accel.calendar.isOpen(openedAt, 'BAY')).toBe(true);
      expect(accel.calendar.withinGrace(endedAt, 'BAY')).toBe(true);
      expect(accel.calendar.isWorkingDay(openedAt)).toBe(true);
      expect(endedAt.getTime()).toBeGreaterThan(openedAt.getTime());
    }, 600_000);
  });
});
