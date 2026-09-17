/*
 * ACCELERATED COPY of ../suites/c-workorder-execution.itest.ts (spec: Task A6).
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
import { SeederRandom } from '@durion-sdk/seeder';
import { AssignServicePositionRequestResourceTypeEnum } from '@durion-sdk/workorder';
import {
  addLaborLine,
  addPartLine,
  approveAndPromote,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  readNumber,
  readString,
  requireField,
  seedFromRunId,
  type BuilderContext,
  type CreatedCustomer,
  type PromotedWorkorder,
} from '../harness/builders';
import { findStockedProduct, readOnHand } from '../harness/availability';
import { call, expectApiError, expectHttpError, isHttpStatus, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';
import { Personas, type DomainClients } from '../harness/personas';
import { waitFor } from '../harness/waitFor';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite C — executing a promoted workorder, from approval to paid invoice.
 *
 * The steps run in order and share one workorder: this is a lifecycle, and a
 * timer cannot be stopped before it is started. Personas follow the seeded
 * grants exactly — the manager approves, assigns and closes; the technician
 * executes; the advisor raises the change request and bills; accounting takes
 * the payment.
 */
/**
 * Stops whatever timer the acting user has running, tolerating the one failure
 * that means "there was nothing to stop".
 *
 * Deliberately narrow: swallowing every error here would hide a 401, a 403 or a
 * 500 and turn a real regression into a later, stranger failure.
 */
const stopTimersIfRunning = async (as: DomainClients): Promise<void> => {
  try {
    await as.workorder.workexecTimeTrackingAPIApi.stopTimers();
  } catch (error) {
    // 409 NO_ACTIVE_TIMER: no timer was running for this mechanic.
    if (!isHttpStatus(error, 409)) {
      throw error;
    }
  }
};

describe('Suite C — workorder execution', () => {
  const LABOR_ONE_PRICE = 145.0;
  const LABOR_TWO_PRICE = 62.5;
  const PART_PRICE = 18.75;
  const PART_QUANTITY = 3;

  let context: ItestContext;
  let accel: AcceleratedFixture;
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let manager: DomainClients;
  let tech: DomainClients;
  /** Stock reads only: see the note at findStockedProduct. */
  let parts: DomainClients;
  let controller: DomainClients;
  let customer: CreatedCustomer;
  let promoted: PromotedWorkorder;
  let workorderId: string;
  let serviceIds: string[];
  let productId: string;
  let technicianId: string;
  /** Created in beforeAll and kept, run-tagged: C1c puts the workorder on it. */
  let bayId: string;

  const detail = async (as: DomainClients = advisor) =>
    call('getWorkorderDetail', () =>
      as.workorder.workorderDetailApi.getWorkorderDetail({ workorderId }),
    );

  /** Builds an estimate with two labor lines and one part line, and promotes it. */
  const buildPromotedWorkorder = async (): Promise<{
    promoted: PromotedWorkorder;
    customer: CreatedCustomer;
  }> => {
    const party = await createPersonAccount(advisor, ctx);
    const vehicleId = await createVehicle(admin, ctx, party.partyId);
    const estimateId = await createDraftEstimate(advisor, ctx, party.partyId, vehicleId);
    await addLaborLine(advisor, ctx, estimateId, serviceIds[0], LABOR_ONE_PRICE);
    await addLaborLine(advisor, ctx, estimateId, serviceIds[1], LABOR_TWO_PRICE);
    await addPartLine(advisor, ctx, estimateId, productId, PART_QUANTITY, PART_PRICE);
    const result = await approveAndPromote(advisor, ctx, estimateId, party);
    return { promoted: result, customer: party };
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
    parts = personas.as('parts');
    controller = personas.as('controller');
    ctx = {
      runId: context.runId,
      // Seeded per suite, not per run: a shared seed makes every suite generate
      // the same VIN, and VINs are globally unique across active vehicles.
      random: new SeederRandom(seedFromRunId(`${context.runId}:c-workorder-execution`)),
      refs: context.referenceCache,
    };

    serviceIds = context.referenceCache.serviceEntityIds.slice(0, 3);
    // The part must be one the shop actually holds: a workorder for an unstocked
    // part never gets a pick list, so C6 would wait for something that cannot
    // arrive.
    // Read stock as the parts clerk. getAvailabilityBySku used to require
    // inventory:on_hand:view / :search - which INVENTORY_LEAD holds and
    // TECHNICIAN does not - while TECHNICIAN carried inventory:availability:read
    // that no endpoint asked for (backend #1494). That is fixed: the endpoint
    // now requires inventory:availability:read and a technician can read
    // availability. The parts clerk is kept here because stock is the parts
    // clerk's concern in this flow, not because the technician is barred.
    const stocked = await findStockedProduct(
      parts,
      context.referenceCache.productEntityIds,
      context.referenceCache.locationId,
      PART_QUANTITY,
    );
    productId = stocked.productEntityId;
    console.log(
      `[setup] picking part ${context.referenceCache.productNameById.get(productId)} with ${stocked.onHandQty} on hand`,
    );
    technicianId = context.referenceCache.employees.technicians[0];

    // The run's own bay: every shared bay at the site may already hold an open
    // workorder, and a bay holds one (backend #1984).
    const bay = await call('createBay', () =>
      admin.location.bayApi.createBay({
        locationId: context.referenceCache.locationId,
        bayRequest: {
          name: `Itest bay ${context.runId} C`,
          bayType: 'GENERAL_SERVICE',
          capacity: { maxConcurrentVehicles: 1 },
        },
      }),
    );
    bayId = requireField(bay.id, 'createBay.id');
    console.log(`[setup] created bay ${bayId}`);

    const built = await buildPromotedWorkorder();
    promoted = built.promoted;
    customer = built.customer;
    workorderId = promoted.workorderId;
  }, 300_000);

  beforeEach(async () => {
    await personas.refreshIfNeeded();
  });

  it('C1 — the manager approves the workorder', async () => {
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

    const approved = await detail();
    console.log(`[C1] approved: status=${approved.status} isStarted=${approved.isStarted}`);
    expect(String(approved.status).toUpperCase()).toContain('APPROV');
  }, 120_000);

  it('C1b — the manager assigns a technician before any work starts', async () => {
    // Work is assigned before it starts: a technician (here) and a bay (C1c),
    // backend #2011.
    await call('assignTechnician', () =>
      manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId,
        assignTechnicianRequest: {
          technicianId,
          notes: `Integration test assignment [${context.runId}]`,
        },
      }),
    );

    const assignment = await call('getTechnicianAssignment', () =>
      manager.workorder.technicianAssignmentAPIApi.getTechnicianAssignment({ workorderId }),
    );
    const assigned = readString(assignment, 'technicianId', 'assignedTechnicianId');
    console.log(`[C1b] assigned technician = ${assigned}`);
    expect(assigned ?? (await detail()).assignedTechnicianId).toBe(technicianId);
  }, 120_000);

  it('C1c — the manager puts the workorder on the run\'s bay, where it stays until completion', async () => {
    // pos-workorder validates the bay against its Kafka-fed ext_bay replica, so
    // the bay beforeAll created can still be unknown there. HOLD is suite H's.
    const placed = await retryWhileReplicating(
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
    console.log(`[C1c] position ${placed.resourceType} ${placed.resourceId}`);
    expect(placed.resourceType).toBe('BAY');
    expect(placed.resourceId).toBe(bayId);
    // The position read answers the technician too, and placing left it alone.
    expect(placed.technicianId).toBe(technicianId);

    // A technician and a bay together are what ASSIGNED means.
    const status = String((await detail()).status).toUpperCase();
    console.log(`[C1c] status=${status}`);
    expect(status).toBe('ASSIGNED');
  }, 120_000);

  it('C2 — the technician starts execution', async () => {
    // From ASSIGNED: C1b and C1c gave the workorder a technician and a bay first.
    await call('startWorkorder', () =>
      tech.workorder.operationalContextApi.startWorkorder({ workorderId }),
    );

    const started = await detail();
    console.log(`[C2] started: status=${started.status} isStarted=${started.isStarted}`);
    // Not merely "truthy": the workorder has to have actually moved. Alpha
    // reports WORK_IN_PROGRESS here, and isStarted is the flag the detail view
    // exposes for it.
    expect(String(started.status).toUpperCase()).toBe('WORK_IN_PROGRESS');
    expect(String(started.isStarted)).toBe('true');
  }, 120_000);

  it('C3 — a timer records labor against the first service item', async () => {
    const serviceItemId = promoted.serviceItemMap.get(serviceIds[0]);
    expect(serviceItemId).toBeTruthy();

    // The timer tracks the technician C1b assigned, with the tech persona recorded
    // as the actor that started it. stopTimers stops timers the caller tracks or
    // started, so the same persona still reaches it. Tolerate "nothing running"
    // on the first stop.
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

    // A known virtual interval, not a real sleep. The backend measures its own
    // accelerated clock, so the twin's 1.5 real seconds would already be minutes of
    // virtual labor here; waiting an explicit 30 virtual minutes makes the duration
    // the test is about a stated quantity rather than a side effect of latency, and
    // at scale 1460 it costs about a second.
    const laborFrom = await accel.now();
    await accel.elapseVirtual(30);
    const stopped = await call('stopTimers', () =>
      tech.workorder.workexecTimeTrackingAPIApi.stopTimers(),
    );

    console.log(`[C3] stopTimers -> ${JSON.stringify(stopped).slice(0, 200)}`);
    const entries = readNumber(stopped, 'stoppedCount', 'count');
    if (entries !== undefined) {
      expect(entries).toBeGreaterThan(0);
    }

    // The labor spanned at least the virtual half hour that was waited out, by the
    // clock the backend itself stamps records with.
    const laborTo = await accel.now();
    const virtualMinutes = (laborTo.getTime() - laborFrom.getTime()) / 60_000;
    console.log(`[C3] labor spanned ${virtualMinutes.toFixed(1)} virtual minute(s) at scale ${accel.scale}`);
    expect(virtualMinutes).toBeGreaterThanOrEqual(30);

    const afterTimer = await detail();
    const service = (afterTimer.services ?? []).find((item) => item.id === serviceItemId);
    console.log(`[C3] first service item: status=${service?.status} hours=${service?.totalLaborHours}`);
    expect(service).toBeDefined();
  }, 180_000);

  it('C4 — starting a second timer without stopping the first is a conflict', async () => {
    const firstItemId = promoted.serviceItemMap.get(serviceIds[0]);
    const secondItemId = promoted.serviceItemMap.get(serviceIds[1]);
    expect(secondItemId).toBeTruthy();

    await call('startTimer (first item, to occupy the technician)', () =>
      tech.workorder.workexecTimeTrackingAPIApi.startTimer({
        workexecTimerStartRequest: {
          workorderId,
          workorderItemId: firstItemId,
          laborCode: serviceIds[0],
        },
      }),
    );

    const status = await expectHttpError(
      tech.workorder.workexecTimeTrackingAPIApi.startTimer({
        workexecTimerStartRequest: {
          workorderId,
          workorderItemId: secondItemId,
          laborCode: serviceIds[1],
        },
      }),
      409,
    );
    console.log(`[C4] a second concurrent timer is rejected with HTTP ${status}`);

    // Recover the way the seeder does: stop, restart on the second item, stop.
    await tech.workorder.workexecTimeTrackingAPIApi.stopTimers();
    await tech.workorder.workexecTimeTrackingAPIApi.startTimer({
      workexecTimerStartRequest: {
        workorderId,
        workorderItemId: secondItemId,
        laborCode: serviceIds[1],
      },
    });
    await accel.elapseVirtual(30);
    await tech.workorder.workexecTimeTrackingAPIApi.stopTimers();

    const afterBoth = await detail();
    const touched = (afterBoth.services ?? []).filter(
      (item) => item.id === firstItemId || item.id === secondItemId,
    );
    expect(touched).toHaveLength(2);
  }, 180_000);

  it('C5 — one technician per workorder: a second assign is refused, a reassign changes it', async () => {
    const otherTechnicianId = context.referenceCache.employees.technicians.find((id) => id !== technicianId);

    // Assign means "none yet". It used to retire the incumbent silently; it now
    // refuses and names who is assigned (backend #1985).
    const refused = await expectApiError(
      manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId,
        assignTechnicianRequest: {
          technicianId: otherTechnicianId ?? technicianId,
          notes: `Second assign [${context.runId}]`,
        },
      }),
      409,
      'TECHNICIAN_ALREADY_ASSIGNED',
    );
    console.log(`[C5] second assign refused, naming current technician ${refused.referenceId}`);
    expect(refused.referenceId).toBe(technicianId);

    if (!otherTechnicianId) {
      console.log('[C5] only one seeded technician; skipped the reassign round trip');
      return;
    }
    // Away and back: the steps after this attribute labor to technicianId.
    for (const [to, label] of [
      [otherTechnicianId, 'away'],
      [technicianId, 'back'],
    ] as const) {
      await call(`reassignTechnician ${label}`, () =>
        manager.workorder.technicianAssignmentAPIApi.reassignTechnician({
          workorderId,
          reassignTechnicianRequest: {
            newTechnicianId: to,
            reason: `Integration test reassign ${label} [${context.runId}]`,
          },
        }),
      );
      const current = await call('getTechnicianAssignment', () =>
        manager.workorder.technicianAssignmentAPIApi.getTechnicianAssignment({ workorderId }),
      );
      expect(readString(current, 'technicianId', 'assignedTechnicianId')).toBe(to);
    }
  }, 120_000);

  it('C6 — promotion generates a pick list whose tasks reach the workorder facade', async () => {
    const onHandBefore = await readOnHand(parts, productId, context.referenceCache.locationId);

    // Promotion raises the pick list itself: pos-workorder publishes a command,
    // pos-inventory generates the list, and the resulting fact lands back in
    // ext_pick_task. That round trip is asynchronous - measured at roughly 30
    // seconds on alpha - so this waits rather than reading once. C6 used to
    // assert the facade 404'd and the list came back empty, which was true of
    // the build before backend #1479 and is precisely wrong now.
    const pickTasks = await waitFor(
      async () => {
        const tasks = await tech.workorder.workorderPickFacadeApi.getPickTasks({ workorderId });
        return tasks.length > 0 ? tasks : undefined;
      },
      { timeoutMs: 120_000, intervalMs: 3_000 },
    );
    console.log(
      `[C6] promotion generated ${pickTasks.length} pick task(s): ${JSON.stringify(pickTasks[0]).slice(0, 200)}`,
    );

    const partTask = pickTasks.find((task) => task.skuId === productId);
    expect(partTask).toBeTruthy();
    expect(partTask?.requiredQty).toBe(PART_QUANTITY);
    // Nothing has been picked yet, so the whole requirement is still outstanding.
    expect(partTask?.pickedQty).toBe(0);
    expect(partTask?.remainingQty).toBe(PART_QUANTITY);

    // The manager raises the list, not the technician: createPickList requires
    // inventory:pick_list:create, which the seeded TECHNICIAN role does not
    // carry - it holds pick_list:execute and pick_list:view. In
    // single-credential mode every persona is the admin login and this passed
    // either way; in role mode a technician here is a 403.
    const pickList = await call('createPickList', () =>
      manager.inventory.pickListsApi.createPickList({
        // priority is declared optional by the spec but lands in a primitive int
        // on the backend, which rejects the null the client sends for an omitted
        // field: "Cannot map `null` into type `int`". So it is always supplied.
        createPickListRequest: { workorderId, priority: 1 },
      }),
    );
    const pickListId = requireField(readString(pickList, 'pickListId', 'id'), 'pickListId');
    expect(readString(pickList, 'status')).toBe('DRAFT');

    const released = await call('releasePickList', () =>
      tech.inventory.pickListsApi.releasePickList({ pickListId }),
    );
    expect(readString(released, 'status')).toBe('READY_TO_PICK');

    // A second, manually requested list is still empty: its tasks come from a
    // reservation (CreatePickListRequest carries a reservationId), not from the
    // workorder id alone. Recorded rather than asserted at a fixed count - the
    // useful assertion is the promotion-generated list above, and pinning this
    // one to zero would fail the day manual requests learn to expand a
    // workorder.
    const tasks = await tech.inventory.pickListsApi.listPickTasksForPickList({ pickListId });
    console.log(
      `[C6] a separately requested list ${pickListId} released as ${readString(released, 'status')} with ${tasks.length} task(s)`,
    );

    // With nothing picked, stock must not have moved either.
    const onHandAfter = await readOnHand(parts, productId, context.referenceCache.locationId);
    console.log(`[C6] on-hand unchanged at ${onHandAfter} (was ${onHandBefore})`);
    expect(onHandAfter).toBe(onHandBefore);
  }, 240_000);

  it('C7 — an approved change request adds a service, which is then worked', async () => {
    const addedServiceId = serviceIds[2];
    const created = await call('createChangeRequest', () =>
      advisor.workorder.changeRequestAPIApi.createChangeRequest({
        workorderId,
        createChangeRequestDTO: {
          workorderId,
          description: `Additional service found during execution [${context.runId}]`,
          services: [{ serviceEntityId: addedServiceId, quantity: 1 }],
        },
      }),
    );
    const changeId = requireChangeId(created);

    await call('approveChangeRequest', () =>
      manager.workorder.changeRequestAPIApi.approveChangeRequest({
        changeId,
        approveChangeRequestDTO: {
          approvalNote: `Approved by integration test [${context.runId}]`,
        },
      }),
    );

    const withChange = await waitFor(
      async () => {
        const current = await detail();
        const added = (current.services ?? []).find(
          (service) => service.serviceEntityId === addedServiceId,
        );
        return added ? { current, added } : undefined;
      },
      { description: `the change-request service on workorder ${workorderId}`, timeoutMs: 60_000 },
    );
    console.log(`[C7] added service item ${withChange.added.id} status=${withChange.added.status}`);

    // Work it like the others so C8 can complete every item.
    await stopTimersIfRunning(tech);
    await tech.workorder.workexecTimeTrackingAPIApi.startTimer({
      workexecTimerStartRequest: {
        workorderId,
        workorderItemId: withChange.added.id,
        laborCode: addedServiceId,
      },
    });
    await accel.elapseVirtual(30);
    await tech.workorder.workexecTimeTrackingAPIApi.stopTimers();
  }, 300_000);

  it('C8 — the manager completes every item, then the workorder', async () => {
    const completable = new Set(['OPEN', 'READY_TO_EXECUTE', 'IN_PROGRESS']);
    const current = await detail();

    for (const service of current.services ?? []) {
      if (!service.id || !completable.has(String(service.status))) continue;
      await call(`completeServiceItem ${service.id}`, () =>
        manager.workorder.workOrderAPIApi.completeServiceItem({
          workorderId,
          serviceLineId: service.id as string,
        }),
      );
    }
    for (const part of current.parts ?? []) {
      if (!part.id || !completable.has(String(part.status))) continue;
      await call(`completePartItem ${part.id}`, () =>
        manager.workorder.workOrderAPIApi.completePartItem({ workorderId, partId: part.id }),
      );
    }

    await call('completeWorkorder', () =>
      manager.workorder.workOrderAPIApi.completeWorkorder({
        workorderId,
        completeWorkorderRequest: {
          completionNotes: `Completed by integration test [${context.runId}]`,
        },
      }),
    );

    const completed = await detail();
    console.log(`[C8] completed: status=${completed.status} isCompleted=${completed.isCompleted}`);
    expect(String(completed.status).toUpperCase()).toContain('COMPLET');

    // Closing a workorder frees its position (C1c put it on the bay): the read
    // names none any more, and the release stays in history.
    const position = await call('getServicePosition', () =>
      manager.workorder.servicePositionAPIApi.getServicePosition({ workorderId }),
    );
    console.log(`[C8] position after completion: ${position.resourceType ?? 'none'}`);
    expect(position.resourceType).toBeUndefined();
    expect(
      position.history?.some(
        (row) => row.resourceType === 'BAY' && row.resourceId === bayId && row.releasedAt !== undefined,
      ),
    ).toBe(true);
  }, 300_000);

  it('C9 — the invoice is generated, finalized and paid', async () => {
    // Invoice generation is asynchronous: the first call records an approval and
    // answers {invoiceId: null, status: PENDING}, and a later call returns the
    // invoice once it exists. The call is safe to repeat - it returns the same
    // invoice rather than making another.
    const first = await call('generateWorkorderInvoice', () =>
      advisor.workorder.workOrderAPIApi.generateWorkorderInvoice({ workorderId }),
    );
    console.log(`[C9] first generate -> ${JSON.stringify(first).slice(0, 200)}`);

    const invoiceId = await waitFor(
      async () => {
        const generated = await advisor.workorder.workOrderAPIApi.generateWorkorderInvoice({
          workorderId,
        });
        return readString(generated, 'invoiceId');
      },
      { description: `an invoice id for workorder ${workorderId}`, timeoutMs: 90_000 },
    );
    console.log(`[C9] invoice id = ${invoiceId}`);

    const finalized = await call('finalizeInvoice', () =>
      advisor.invoice.invoiceApi.finalizeInvoice({
        invoiceId,
        finalizationRequest: {},
      }),
    );
    const total = readNumber(finalized, 'total', 'totalAmount');
    console.log(`[C9] invoice ${invoiceId} finalized with total ${total}`);

    // The workorder carried two estimate labor lines, one part line and the
    // approved change-request service, so the invoice must be worth at least
    // the labor the estimate priced.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(LABOR_ONE_PRICE);

    const accepted = await call('submitAccountingEvent', () =>
      controller.accounting.accountingEventsApi.submitAccountingEvent({
        accountingEventSubmitRequest: {
          eventType: 'INVOICE_PAYMENT',
          organizationId: context.referenceCache.locationId,
          sourceSystem: 'SDK_ITEST',
          payload: {
            invoiceId,
            paymentMethod: 'CREDIT_CARD',
            amountPaid: total ?? 0,
          },
        },
      }),
    );
    console.log(`[C9] payment event accepted: ${JSON.stringify(accepted).slice(0, 200)}`);
    expect(accepted).toBeTruthy();
  }, 300_000);

  it('C10 — a fresh workorder cannot be completed before its items are', async () => {
    const fresh = await buildPromotedWorkorder();
    await manager.workorder.workOrderAPIApi.approveWorkorder({
      workorderId: fresh.promoted.workorderId,
      approveWorkorderRequest: {
        customerId: fresh.customer.partyId,
        signatureData: ctx.random.base64(16),
        signerName: fresh.customer.fullName,
        signatureMimeType: 'image/png',
      },
    });

    const status = await expectHttpError(
      manager.workorder.workOrderAPIApi.completeWorkorder({
        workorderId: fresh.promoted.workorderId,
        completeWorkorderRequest: {
          completionNotes: `Premature completion [${context.runId}]`,
        },
      }),
      400,
      409,
      422,
    );
    console.log(`[C10] completing an unworked workorder is rejected with HTTP ${status}`);
  }, 300_000);

  describe('role-mode negatives', () => {
    itInRoleMode('a technician cannot complete the workorder', async () => {
      await expectHttpError(
        tech.workorder.workOrderAPIApi.completeWorkorder({
          workorderId,
          completeWorkorderRequest: { completionNotes: 'tech attempt' },
        }),
        401,
        403,
      );
    });

    itInRoleMode('an advisor cannot start a labor timer', async () => {
      await expectHttpError(
        advisor.workorder.workexecTimeTrackingAPIApi.startTimer({
          workexecTimerStartRequest: {
            workorderId,
            workorderItemId: promoted.serviceItemMap.get(serviceIds[0]),
            laborCode: serviceIds[0],
          },
        }),
        401,
        403,
      );
    });
  });
});

/** Change-request creation returns an id under one of several names. */
function requireChangeId(created: unknown): string {
  const changeId = readString(created, 'changeId', 'id', 'changeRequestId');
  if (!changeId) {
    throw new Error(`change request response carried no id: ${JSON.stringify(created).slice(0, 200)}`);
  }
  return changeId;
}
