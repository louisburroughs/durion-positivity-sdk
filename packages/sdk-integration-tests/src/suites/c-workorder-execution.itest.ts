import { SeederRandom } from '@durion-sdk/seeder';
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
import { call, expectHttpError, isHttpStatus } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
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
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let manager: DomainClients;
  let tech: DomainClients;
  let acct: DomainClients;
  let customer: CreatedCustomer;
  let promoted: PromotedWorkorder;
  let workorderId: string;
  let serviceIds: string[];
  let productId: string;
  let technicianId: string;

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
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    advisor = personas.as('advisor');
    admin = personas.as('admin');
    manager = personas.as('manager');
    tech = personas.as('tech');
    acct = personas.as('acct');
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
    const stocked = await findStockedProduct(
      tech,
      context.referenceCache.productEntityIds,
      context.referenceCache.locationId,
      PART_QUANTITY,
    );
    productId = stocked.productEntityId;
    console.log(
      `[setup] picking part ${context.referenceCache.productNameById.get(productId)} with ${stocked.onHandQty} on hand`,
    );
    technicianId = context.referenceCache.employees.technicians[0];

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

  it('C2 — the technician starts execution', async () => {
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

    // stopTimers targets the authenticated user, so no technician may be
    // assigned yet (C5 does that afterwards): an assignment would strand this
    // timer on someone else. Tolerate "nothing running" on the first stop.
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

    // Real elapsed time: the entry has to carry a duration above zero, and the
    // backend measures the wall clock.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stopped = await call('stopTimers', () =>
      tech.workorder.workexecTimeTrackingAPIApi.stopTimers(),
    );

    console.log(`[C3] stopTimers -> ${JSON.stringify(stopped).slice(0, 200)}`);
    const entries = readNumber(stopped, 'stoppedCount', 'count');
    if (entries !== undefined) {
      expect(entries).toBeGreaterThan(0);
    }

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
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await tech.workorder.workexecTimeTrackingAPIApi.stopTimers();

    const afterBoth = await detail();
    const touched = (afterBoth.services ?? []).filter(
      (item) => item.id === firstItemId || item.id === secondItemId,
    );
    expect(touched).toHaveLength(2);
  }, 180_000);

  it('C5 — the manager assigns a technician, after the timer work', async () => {
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
    console.log(`[C5] assigned technician = ${assigned}`);
    expect(assigned ?? (await detail()).assignedTechnicianId).toBe(technicianId);
  }, 120_000);

  it('C6 — a pick list is requested and released; tasks need a reservation', async () => {
    const onHandBefore = await readOnHand(tech, productId, context.referenceCache.locationId);

    // The workorder facade answers 404 until inventory has been asked for a pick
    // list. Nothing in promotion or start creates one, which is what the seeder's
    // tolerated 404 has been hiding.
    await expectHttpError(
      tech.workorder.workorderPickFacadeApi.getPickTasks({ workorderId }),
      404,
    );

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

    // Released, and still empty. Tasks are generated from a reservation
    // (CreatePickListRequest carries a reservationId), so a list created from a
    // workorder id alone has nothing to pick and nothing reaches pos-workorder's
    // ext_pick_task replica. Recorded rather than asserted away: the spec's C6
    // assumed promotion produced pickable tasks, and on this backend it does not.
    const tasks = await tech.inventory.pickListsApi.listPickTasksForPickList({ pickListId });
    console.log(
      `[C6] pick list ${pickListId} released as ${readString(released, 'status')} with ${tasks.length} task(s)`,
    );
    expect(tasks).toHaveLength(0);

    // With nothing picked, stock must not have moved either.
    const onHandAfter = await readOnHand(tech, productId, context.referenceCache.locationId);
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
    await new Promise((resolve) => setTimeout(resolve, 1_500));
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
      acct.accounting.accountingEventsApi.submitAccountingEvent({
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
