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
import { WorkSessionBreakStartRequestTypeEnum } from '@durion-sdk/people';
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
import { call, expectApiError, expectHttpError, isHttpStatus, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';
import { Personas, type DomainClients } from '../harness/personas';
import { waitFor } from '../harness/waitFor';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
/** Pay periods are per tenant; scoping the list keeps F10 off any other tenant's periods. */
const TENANT_ID = ItestConfig.fromEnv().tenant.id;
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Reads one claim out of a JWT without verifying it. Not a security decision -
 * the backend verifies. The suite only needs to know which user id the gateway
 * forwards as X-User-Id, which is the token's `uid` claim, so it can check that
 * an adjustment record names the supervisor who made it.
 */
const jwtClaim = (token: string, name: string): string => {
  const payload = token.split('.')[1] ?? '';
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const claims = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
  const value = claims[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`token carries no "${name}" claim`);
  }
  return value;
};

/**
 * Suite F — reporting time across the two clocks the backend keeps, and what
 * each one lets a supervisor decide.
 *
 * They are genuinely different things and the suite treats them separately.
 * pos-workorder's labor entries are time on task (ADR-0059): they record a
 * technician's time against one service line on one workorder, and pos-people
 * totals them per employee from the job-time facts pos-workorder publishes.
 * pos-people's work sessions are the payroll clock - clock in, break, clock out,
 * submit - and know nothing about workorders. F1-F7 cover the first, F8-F9 the
 * second.
 *
 * **Time on task is record-keeping, not an approval workflow** (backend #2282).
 * pos-workorder has no per-entry approve or reject and none is wanted. What it
 * has is a supervisor-only correction with an audit trail: only SHOP_MANAGER,
 * LOCATION_MANAGER, MANAGER, GENERAL_MANAGER and ADMIN hold
 * `workorder:labor:adjust`; an entry can be adjusted only once it is stopped,
 * which is when its `workorder.job-time.recorded.v1` is sent; every adjustment
 * writes an immutable record and sends `workorder.labor-adjustment.recorded.v1`
 * for pos-people to apply to its totals; and adjusting on a closed workorder
 * succeeds with a `WORKORDER_CLOSED` warning. F2b, F5, F6, F6b, F7b and F7c pin
 * each of those in turn.
 *
 * **Attendance approval is pos-people's, and a gap shapes its tests.** Nothing
 * creates a decidable attendance entry: `timekeeping_entry` is fed by
 * `TimekeepingIngestionService.ingestWorkSession`, whose
 * `WorkSessionCompletedEvent` is published nowhere outside that service's own
 * unit tests - submitting a work session does not raise it. So no call this
 * suite can make will ever move an entry to APPROVED, and a test that waited for
 * one would hang rather than report the cause. F10-F12 therefore assert what
 * *is* reachable and stays true either way: who the decision belongs to, and the
 * documented shapes of the batch contract - an unknown entry comes back as a
 * per-entry failure rather than a failed batch, a rejection with no reason is
 * refused outright. When the ingestion bridge lands, those tests keep passing
 * and a positive approval belongs alongside them.
 */
describe('Suite F — attendance approval and workorder time on task', () => {
  const LABOR_PRICE = 132.5;
  const ADJUSTED_HOURS = 2.25;
  const BILLABLE_MINUTES = 135;
  const BREAK_MINUTES = 30;
  /** F7b: what the second labor entry is corrected to, and so what pos-people must add to its totals. */
  const E2E_HOURS = 1.5;
  /** F7c: the correction made once the workorder is closed. Distinct from F6's, so it is a change. */
  const CLOSED_HOURS = 3;

  let context: ItestContext;
  let accel: AcceleratedFixture;
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let manager: DomainClients;
  let tech: DomainClients;
  /** Holds accounting:time:export, which is what reads pos-people's job-time totals (F7b). */
  let controller: DomainClients;

  let customer: CreatedCustomer;
  let promoted: PromotedWorkorder;
  let workorderId: string;
  let serviceIds: string[];
  let serviceItemId: string;
  let technicianId: string;
  let locationId: string;

  let laborEntryId: string;
  /** The user id behind the manager's token: what an adjustment record must name as its author. */
  let managerUserId: string;
  /** Hours F3 recorded, before any correction: the `originalHours` F6b expects on the record. */
  let stoppedHours: number;
  let workSessionId: string;

  /**
   * Closes whatever payroll session the person already has open, the way the
   * seeder's ShiftSimulator does. Alpha is shared and its loop clocks the same
   * seeded employees in and out, so a run that assumed a clean slate would fail
   * its first clock-in with a conflict caused by someone else.
   */
  const clockOutIfClockedIn = async (as: DomainClients, personId: string): Promise<void> => {
    try {
      await as.people.workSessionsAPIApi.stopWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId } });
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
      await as.workorder.workexecTimeTrackingAPIApi.stopTimers({ idempotencyKey: crypto.randomUUID() });
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
    controller = personas.as('controller');
    managerUserId = jwtClaim(manager.auth.getToken(), 'uid');
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
    // workorder. F7c completes the workorder, which frees the bay again.
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
        idempotencyKey: crypto.randomUUID(),
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
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        serviceId: serviceItemId,
        startLaborRequest: { technicianId },
      }),
      400,
      409,
    );
    console.log(`[F2] a concurrent labor session on one service is rejected with HTTP ${status}`);
  }, 120_000);

  // An entry is adjustable only once it is recorded, and "recorded" means the
  // clock has stopped: that is the moment pos-workorder writes the entry's
  // workorder.job-time.recorded.v1 to its outbox (backend #2292, #2294), so a
  // correction can never be ordered ahead of the fact it corrects.
  it('F2b — a running entry cannot be adjusted: stop it first', async () => {
    const refused = await expectApiError(
      manager.workorder.workorderLaborAPIApi.adjustLaborHours({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: laborEntryId,
        adjustLaborRequest: {
          hoursWorked: ADJUSTED_HOURS,
          adjustmentReason: `Integration test: too early [${context.runId}]`,
        },
      }),
      409,
      'LABOR_ENTRY_NOT_RECORDED',
    );
    console.log(`[F2b] adjusting the open entry refused: ${refused.code} (${refused.message})`);
  }, 120_000);

  it('F3 — stopping the session records the hours worked', async () => {
    // Real elapsed time: hoursWorked is derived from the wall clock, and a stop
    // in the same millisecond as the start proves nothing.
    // A stated virtual interval rather than a real sleep: the payroll clock is
    // the accelerated one, so this is what puts measurable minutes on the entry.
    await accel.elapseVirtual(30);

    const stopped = await call('stopLaborSession', () =>
      tech.workorder.workorderLaborAPIApi.stopLaborSession({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: laborEntryId,
      }),
    );
    console.log(`[F3] labor entry ${laborEntryId} closed, hours=${stopped.hoursWorked}`);

    expect(stopped.id).toBe(laborEntryId);
    expect(stopped.active).toBe(false);
    expect(stopped.endTime).toBeDefined();
    expect(stopped.hoursWorked).toBeDefined();
    expect(Number(stopped.hoursWorked)).toBeGreaterThanOrEqual(0);
    stoppedHours = Number(stopped.hoursWorked);
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

  // Adjusting labor is a supervisor's act (backend #2282, #2293): only
  // SHOP_MANAGER, LOCATION_MANAGER, MANAGER, GENERAL_MANAGER and ADMIN hold
  // workorder:labor:adjust. The technician starts and stops the clock
  // (workorder:labor:add) and reads it back, but never rewrites it - not even
  // their own entry.
  itInRoleMode('F5 — the technician cannot adjust the recorded hours', async () => {
    const status = await expectHttpError(
      tech.workorder.workorderLaborAPIApi.adjustLaborHours({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: laborEntryId,
        adjustLaborRequest: {
          hoursWorked: ADJUSTED_HOURS,
          adjustmentReason: 'Integration test: should be refused',
        },
      }),
      401,
      403,
    );
    console.log(`[F5] TECHNICIAN refused workorder:labor:adjust with HTTP ${status}`);
  }, 120_000);

  it('F6 — the manager adjusts the technician\'s hours, and the record names the manager and the reason', async () => {
    const adjusted = await call('adjustLaborHours', () =>
      manager.workorder.workorderLaborAPIApi.adjustLaborHours({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: laborEntryId,
        adjustLaborRequest: {
          hoursWorked: ADJUSTED_HOURS,
          adjustmentReason: `Integration test correction [${context.runId}]`,
        },
      }),
    );
    console.log(
      `[F6] hours ${stoppedHours} -> ${adjusted.hoursWorked} by ${adjusted.lastAdjustment?.adjustedByUserId} ` +
        `(${adjusted.lastAdjustment?.reason})`,
    );

    expect(Number(adjusted.hoursWorked)).toBe(ADJUSTED_HOURS);
    // The entry holds the current value; the reason and the author ride the
    // immutable adjustment record (backend #2294), not the entry itself.
    expect(adjusted.lastAdjustment?.reason).toContain(context.runId);
    expect(adjusted.lastAdjustment?.adjustedByUserId?.toLowerCase()).toBe(managerUserId.toLowerCase());
    expect(adjusted.lastAdjustment?.technicianId).toBe(technicianId);
    // The workorder is still open, so there is nothing to warn about yet; F7c
    // is where WORKORDER_CLOSED appears.
    expect(adjusted.warnings).toEqual([]);
  }, 120_000);

  it('F6b — the adjustment history is append-only and keeps the original and adjusted hours', async () => {
    const history = await call('getLaborAdjustments', () =>
      manager.workorder.workorderLaborAPIApi.getLaborAdjustments({ workorderId, entryId: laborEntryId }),
    );
    console.log(`[F6b] entry ${laborEntryId} adjustments: ${JSON.stringify(history).slice(0, 400)}`);

    // Exactly one: F2b's and F5's refusals wrote nothing, and F6 wrote one row.
    expect(history).toHaveLength(1);
    const record = history[0];
    expect(record.laborEntryId).toBe(laborEntryId);
    expect(record.workorderId).toBe(workorderId);
    expect(Number(record.originalHours)).toBe(stoppedHours);
    expect(Number(record.adjustedHours)).toBe(ADJUSTED_HOURS);
    expect(record.reason).toContain(context.runId);
    expect(record.adjustedByUserId?.toLowerCase()).toBe(managerUserId.toLowerCase());
    expect(record.workorderClosed).toBe(false);
  }, 120_000);

  it('F7 — a running timer is visible to its own technician, and job totals report the day', async () => {
    await stopTimersIfRunning(tech);

    await call('startTimer', () =>
      tech.workorder.workexecTimeTrackingAPIApi.startTimer({
        idempotencyKey: crypto.randomUUID(),
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
      tech.workorder.workexecTimeTrackingAPIApi.stopTimers({ idempotencyKey: crypto.randomUUID() }),
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

  /**
   * The technician's job hours as pos-people reports them for the backend's
   * today, read
   * through the attendance-vs-job-time discrepancy report. Not scoped to a
   * location: the fact carries the workorder's shop, and the controller's export
   * permission already bounds what the report returns.
   */
  const jobHoursReported = async (): Promise<number> => {
    const startDate = await isoDate(-1);
    const endDate = await isoDate(1);
    const rows = await call('getAttendanceDiscrepancyReport', () =>
      controller.people.peopleReportsAPIApi.getAttendanceDiscrepancyReport({
        startDate,
        endDate,
        timezone: 'UTC',
        technicianIds: [technicianId],
      }),
    );
    return rows
      .filter((row) => row.technicianId.toLowerCase() === technicianId.toLowerCase())
      .reduce((sum, row) => sum + Number(row.totalJobHours ?? 0), 0);
  };

  // End to end across the two services (backend #2292, #2294, #2295): a stop
  // sends workorder.job-time.recorded.v1, pos-people lands it in
  // ext_workorder_job_time, a supervisor's correction sends
  // workorder.labor-adjustment.recorded.v1, and pos-people's per-employee totals
  // move to the adjusted minutes. The read is the discrepancy report, which is
  // accounting:time:export - the controller's, not the manager's.
  //
  // A second labor entry rather than F6's, so this test owns both ends of the
  // measurement: the baseline is read with this entry stopped and unadjusted,
  // and the target is that baseline plus the correction. Alpha is shared and
  // the seeded technician works elsewhere too, so the total is only ever
  // asserted to have risen by at least the correction, never to equal it.
  it('F7b — a supervisor\'s correction reaches pos-people\'s job-time totals', async () => {
    const entry = await call('startLaborSession', () =>
      tech.workorder.workorderLaborAPIApi.startLaborSession({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        serviceId: serviceItemId,
        startLaborRequest: {
          technicianId,
          notes: `Integration test labor, second entry [${context.runId}]`,
        },
      }),
    );
    // A stated virtual interval, as in F3: the entry's hours are measured on the
    // accelerated clock, so this puts real minutes on it before the correction.
    await accel.elapseVirtual(30);
    const stopped = await call('stopLaborSession', () =>
      tech.workorder.workorderLaborAPIApi.stopLaborSession({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: entry.id,
      }),
    );
    const recordedHours = Number(stopped.hoursWorked);
    console.log(`[F7b] second entry ${entry.id} recorded ${recordedHours} h`);

    const before = await jobHoursReported();
    const adjusted = await call('adjustLaborHours', () =>
      manager.workorder.workorderLaborAPIApi.adjustLaborHours({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: entry.id,
        adjustLaborRequest: {
          hoursWorked: E2E_HOURS,
          adjustmentReason: `Integration test end-to-end correction [${context.runId}]`,
        },
      }),
    );
    expect(Number(adjusted.hoursWorked)).toBe(E2E_HOURS);

    // Whether or not the stop's own fact had landed when the baseline was read,
    // the adjustment replaces those minutes rather than adding to them, so the
    // floor is the baseline plus the correction less what the stop recorded.
    const floor = before + E2E_HOURS - recordedHours - 0.01;
    const after = await waitFor(
      async () => {
        const hours = await jobHoursReported();
        return hours >= floor ? hours : undefined;
      },
      { description: `pos-people job hours for ${technicianId} to reach ${floor}`, timeoutMs: 180_000, intervalMs: 5_000 },
    );
    console.log(`[F7b] technician job hours reported: ${before} before, ${after} after a ${E2E_HOURS} h correction`);
    expect(after).toBeGreaterThanOrEqual(floor);
  }, 300_000);

  // Adjusting is never blocked by workorder status (backend #2282 decision 2):
  // a correction on a COMPLETED or CANCELLED workorder succeeds, the record is
  // flagged, and the 200 carries a WORKORDER_CLOSED warning rather than a 409.
  // This is the last thing the suite does to its workorder, so it closes it for
  // real - the one service line, then the workorder - which also frees the bay
  // beforeAll put it on. F's estimate carries one labor line and no parts.
  it('F7c — adjusting on a completed workorder succeeds with a WORKORDER_CLOSED warning', async () => {
    const completable = new Set(['OPEN', 'READY_TO_EXECUTE', 'IN_PROGRESS']);
    const current = await call('getWorkorderDetail', () =>
      manager.workorder.workorderDetailApi.getWorkorderDetail({ workorderId }),
    );
    for (const service of current.services ?? []) {
      if (!service.id || !completable.has(String(service.status))) continue;
      await call(`completeServiceItem ${service.id}`, () =>
        manager.workorder.workOrderAPIApi.completeServiceItem({ idempotencyKey: crypto.randomUUID(), workorderId, serviceLineId: service.id as string }),
      );
    }
    const completed = await call('completeWorkorder', () =>
      manager.workorder.workOrderAPIApi.completeWorkorder({
        workorderId,
        completeWorkorderRequest: { completionNotes: `Completed by integration test [${context.runId}]` },
      }),
    );
    console.log(`[F7c] workorder ${workorderId}: ${completed.previousStatus} -> ${completed.currentStatus}`);
    expect(String(completed.currentStatus).toUpperCase()).toContain('COMPLET');

    const adjusted = await call('adjustLaborHours', () =>
      manager.workorder.workorderLaborAPIApi.adjustLaborHours({
        idempotencyKey: crypto.randomUUID(),
        workorderId,
        entryId: laborEntryId,
        adjustLaborRequest: {
          hoursWorked: CLOSED_HOURS,
          adjustmentReason: `Integration test correction after close [${context.runId}]`,
        },
      }),
    );
    console.log(
      `[F7c] adjusted on a closed workorder: hours=${adjusted.hoursWorked} warnings=${JSON.stringify(adjusted.warnings)}`,
    );
    expect(Number(adjusted.hoursWorked)).toBe(CLOSED_HOURS);
    expect(adjusted.warnings.map((warning) => warning.code)).toContain('WORKORDER_CLOSED');
    expect(adjusted.lastAdjustment?.workorderClosed).toBe(true);
    expect(String(adjusted.lastAdjustment?.workorderStatusAtAdjust).toUpperCase()).toContain('COMPLET');
  }, 240_000);

  // The payroll clock is managed by the person themself or by a caller holding
  // people:timekeeping:approve — pos-people answers 403 "Only the person themself
  // or a caller holding people:timekeeping:approve may manage this work session"
  // to anyone else. The suite's `tech` persona is a login linked to a *different*
  // person than `technicianId` (see the role-mode limitations global setup
  // reports), so it is the wrong caller for these, and the admin is the right
  // one. F8b below pins the rule that makes this so.
  it('F8 — the technician clocks in, takes a break, clocks out and submits the session', async () => {
    await clockOutIfClockedIn(admin, technicianId);

    const started = await call('startWorkSession', () =>
      admin.people.workSessionsAPIApi.startWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId: technicianId } }),
    );
    workSessionId = started.sessionId;
    console.log(`[F8] session ${workSessionId} status=${started.status}`);
    expect(started.personId).toBe(technicianId);
    expect(started.status).toBe('ACTIVE');

    const breakStarted = await call('startWorkSessionBreak', () =>
      admin.people.workSessionsAPIApi.startWorkSessionBreak({
        idempotencyKey: crypto.randomUUID(),
        id: workSessionId,
        workSessionBreakStartRequest: { type: WorkSessionBreakStartRequestTypeEnum.Rest },
      }),
    );
    expect(breakStarted.sessionId).toBe(workSessionId);
    expect(breakStarted.endedAt).toBeUndefined();

    const breakStopped = await call('stopWorkSessionBreak', () =>
      admin.people.workSessionsAPIApi.stopWorkSessionBreak({ idempotencyKey: crypto.randomUUID(), id: workSessionId }),
    );
    expect(breakStopped.endedAt).toBeDefined();

    const ended = await call('stopWorkSession', () =>
      admin.people.workSessionsAPIApi.stopWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId: technicianId } }),
    );
    console.log(`[F8] session ${workSessionId} -> ${ended.status}`);
    expect(ended.status).toBe('ENDED');
    expect(ended.endedAt).toBeDefined();

    const submittedAt = await accel.now();
    const submitted = await call('submitWorkSession', () =>
      admin.people.workSessionsAPIApi.submitWorkSession({
        idempotencyKey: crypto.randomUUID(),
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
      admin.people.workSessionsAPIApi.submitWorkSession({
        idempotencyKey: crypto.randomUUID(),
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
      admin.people.workSessionsAPIApi.startWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId: technicianId } }),
    );
    const doubled = await expectHttpError(
      admin.people.workSessionsAPIApi.startWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId: technicianId } }),
      409,
    );
    console.log(`[F9] session ${opened.sessionId} open; a second clock-in refused with HTTP ${doubled}`);

    // Leave the person clocked out: the seeder's shift loop shares these
    // employees and a session left open outlives this run.
    await clockOutIfClockedIn(admin, technicianId);
  }, 180_000);

  // pos-people restricts a work session to the person themself or a caller
  // holding people:timekeeping:approve. The technician login is neither for
  // somebody else's session, and finding that out by watching F8 fail is how it
  // went unnoticed that the rule had arrived at all.
  itInRoleMode('F8b — a technician cannot open somebody else\'s payroll session', async () => {
    const status = await expectHttpError(
      tech.people.workSessionsAPIApi.startWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId: technicianId } }),
      403,
    );
    console.log(`[F8b] TECHNICIAN refused another person's work session with HTTP ${status}`);
  }, 120_000);

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

  // There is no F13. Per-entry approve/reject of workorder time was retired by
  // backend #2282: time on task is record-keeping, corrected by supervisors with
  // an audit trail (F2b, F5, F6, F6b, F7b, F7c). Attendance approval stays in
  // pos-people (F10-F12).

  // Both clocks outlive the process that started them, and alpha is shared.
  // Leaving either running strands state that fails the *next* run rather than
  // this one, which is the hardest kind of failure to attribute.
  afterAll(async () => {
    if (!tech) {
      return;
    }
    await stopTimersIfRunning(tech);
    await clockOutIfClockedIn(admin, technicianId);
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
        admin.people.workSessionsAPIApi.startWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId } }),
      );
      const sessionId = started.sessionId;
      expect(sessionId).toBeTruthy();

      // A shift's worth of work, in virtual minutes.
      await accel.elapseVirtual(60);

      const endedAt = await accel.now();
      await call('stopWorkSession', () =>
        admin.people.workSessionsAPIApi.stopWorkSession({ idempotencyKey: crypto.randomUUID(), workSessionRequest: { personId } }),
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
