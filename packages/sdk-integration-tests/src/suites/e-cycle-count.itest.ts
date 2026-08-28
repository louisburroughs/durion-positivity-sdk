import { randomUUID } from 'crypto';
import {
  StorageLocationRequestStorageCategoryCodeEnum,
  StorageLocationRequestTypeEnum,
} from '@durion-sdk/location';
import {
  SubmitCountRequestMeasurementMethodEnum,
  SubmitRecountRequestMeasurementMethodEnum,
  UpdateCycleCountPlanStatusRequestStatusEnum,
} from '@durion-sdk/inventory';
import { call, expectHttpError } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas, type DomainClients } from '../harness/personas';
import { seedOnHand, type SeededStock } from '../harness/stock';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite E — planning a cycle count and executing it, from an empty bin to a
 * posted variance.
 *
 * The count runs against a storage location this run creates and stocks
 * itself. That isolation is not tidiness: task generation counts *every*
 * stocked (bin, SKU) pair in the plan's scope, so a plan aimed at the shop's
 * real bins would both take an unbounded number of tasks and reconcile stock
 * the other suites are asserting deltas against. A private bin holding two
 * synthetic SKUs makes the expected quantity, the variance, and the posted
 * adjustment all exactly predictable.
 *
 * Stock arrives the way the backend's own seed driver puts it there — bulk
 * ingest raises an adjustment request per row, and approving the request is
 * what posts the ledger entry. Nothing here writes to a database or depends on
 * a Flyway-seeded row.
 *
 * The personas follow the seeded grants exactly, and those grants are narrower
 * than they look: `inventory:cycle_count:initiate|view|complete` are granted to
 * ADMIN alone, so the parts clerk who does the physical counting in real life
 * cannot plan or record one. E2 and E12 pin that down rather than papering over
 * it — see the RBAC note in the README.
 */
describe('Suite E — cycle counting', () => {
  /** Seeded into the run's own bin, and the expected quantity every task starts from. */
  const SEEDED_QUANTITY = 40;
  /** The short count in E6. Chosen well outside any plausible tolerance. */
  const COUNTED_SHORT = 33;
  const EXPECTED_VARIANCE = COUNTED_SHORT - SEEDED_QUANTITY;
  const UNIT_COST = 12.5;

  let context: ItestContext;
  let personas: Personas;
  let admin: DomainClients;
  let parts: DomainClients;
  let tech: DomainClients;

  let siteId: string;
  /** The storage location this run counts — created in beforeAll, used as the plan's only zone. */
  let zoneId: string;
  let stock: SeededStock;
  /** The parts clerk's employee record: who the tasks are assigned to and who counts them. */
  let auditorId: string;

  let planId: string;
  let exactTaskId: string;
  let varianceTaskId: string;
  let adjustmentId: string;

  /** Tomorrow: createCycleCountPlan rejects a scheduledDate that is not in the future. */
  const tomorrow = (): Date => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  };

  const taskFor = async (taskId: string) =>
    call('getCycleCountTask', () => admin.inventory.cycleCountQueryApi.getCycleCountTask({ taskId }));

  beforeAll(async () => {
    context = loadContext();
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    admin = personas.as('admin');
    parts = personas.as('parts');
    tech = personas.as('tech');
    siteId = context.referenceCache.locationId;
    auditorId = context.referenceCache.employees.partsClerk;

    const bin = await call('createStorageLocation', () =>
      admin.location.storageLocationApi.createStorageLocation({
        siteId,
        storageLocationRequest: {
          name: `Itest cycle count ${context.runId}`,
          type: StorageLocationRequestTypeEnum.Bin,
          storageCategoryCode: StorageLocationRequestStorageCategoryCodeEnum.General,
        },
      }),
    );
    zoneId = bin.id;
    console.log(`[E] counting bin ${zoneId} at site ${siteId}`);

    stock = await seedOnHand(parts, admin, {
      locationId: zoneId,
      quantity: SEEDED_QUANTITY,
      skus: [`ITEST-CC-${context.runId}-EXACT`, `ITEST-CC-${context.runId}-VARIANCE`],
    });
    console.log(`[E] seeded ${SEEDED_QUANTITY} of each of ${stock.skus.join(', ')}`);
  }, 180_000);

  it('E1 — the plan is created against the run\'s own bin', async () => {
    const plan = await call('createCycleCountPlan', () =>
      admin.inventory.cycleCountPlansApi.createCycleCountPlan({
        createCycleCountPlanRequest: {
          locationId: siteId,
          planName: `Itest cycle count ${context.runId}`,
          scheduledDate: tomorrow(),
          zoneIds: [zoneId],
        },
      }),
    );
    planId = plan.planId;
    console.log(`[E1] plan ${planId} status = ${plan.status}`);

    expect(plan.status).toBe('PLANNED');
    expect(plan.zoneIds).toContain(zoneId);
    expect(plan.locationId).toBe(siteId);
  }, 120_000);

  // The parts clerk is the one who counts stock in the building, and
  // INVENTORY_LEAD holds none of inventory:cycle_count:*. This asserts the
  // seeded grants as they stand, not as they arguably should be: if the role
  // gains the permission, this test is the one that says so, and the plan
  // creation above should move to the clerk at the same time.
  itInRoleMode('E2 — the parts clerk cannot plan a count', async () => {
    const status = await expectHttpError(
      parts.inventory.cycleCountPlansApi.createCycleCountPlan({
        createCycleCountPlanRequest: {
          locationId: siteId,
          planName: `Itest refused ${context.runId}`,
          scheduledDate: tomorrow(),
          zoneIds: [zoneId],
        },
      }),
      401,
      403,
    );
    console.log(`[E2] INVENTORY_LEAD refused cycle_count:initiate with HTTP ${status}`);
  }, 120_000);

  it('E3 — generating tasks finds exactly the two stocked SKUs and starts the plan', async () => {
    const generated = await call('generateCycleCountTasks', () =>
      admin.inventory.cycleCountPlansApi.generateCycleCountTasks({
        planId,
        generateCycleCountTasksRequest: { auditorId },
      }),
    );
    console.log(
      `[E3] scanned ${generated.locationsScanned} location(s), created ${generated.tasksCreated}, ` +
        `skipped ${generated.tasksSkippedExisting}, plan ${generated.planStatus}`,
    );

    expect(generated.tasksCreated).toBe(stock.skus.length);
    expect(generated.planStatus).toBe('STARTED');

    const bySku = new Map(generated.tasks.map((task) => [task.itemSku, task]));
    for (const sku of stock.skus) {
      const task = bySku.get(sku);
      expect(task).toBeDefined();
      // binLocation is the storage-location UUID as text — the form the
      // conflict detector and the adjustment posting both scope on.
      expect(task?.binLocation).toBe(zoneId);
      expect(task?.auditorId).toBe(auditorId);
      expect(task?.status).toBe('ASSIGNED');
      expect(Number(task?.expectedQuantity)).toBe(SEEDED_QUANTITY);
    }

    exactTaskId = bySku.get(stock.skus[0])!.taskId;
    varianceTaskId = bySku.get(stock.skus[1])!.taskId;
  }, 180_000);

  it('E4 — the plan lists both tasks and each reads back individually', async () => {
    const tasks = await call('listCycleCountPlanTasks', () =>
      admin.inventory.cycleCountPlansApi.listCycleCountPlanTasks({ planId }),
    );
    console.log(`[E4] plan ${planId} lists ${tasks.length} task(s)`);
    expect(tasks.map((task) => task.taskId).sort()).toEqual([exactTaskId, varianceTaskId].sort());

    const task = await taskFor(exactTaskId);
    expect(task.taskId).toBe(exactTaskId);
    expect(task.countEntriesCount).toBe(0);
  }, 120_000);

  it('E5 — an exact count is accepted and closes the task with no adjustment', async () => {
    const counted = await call('submitCycleCount', () =>
      admin.inventory.cycleCountOperationsApi.submitCycleCount({
        submitCountRequest: {
          taskId: exactTaskId,
          auditorId,
          actualQuantity: SEEDED_QUANTITY,
          measurementMethod: SubmitCountRequestMeasurementMethodEnum.ManualCount,
        },
      }),
    );
    console.log(
      `[E5] variance ${counted.variance}, withinTolerance ${counted.withinTolerance}, ` +
        `task ${counted.taskStatus}`,
    );

    expect(Number(counted.variance)).toBe(0);
    expect(counted.withinTolerance).toBe(true);
    expect(counted.taskStatus).toBe('ACCEPTED_WITHIN_TOLERANCE');
    expect(counted.recountSequenceNumber).toBe(0);
  }, 120_000);

  it('E6 — a short count is held for review rather than auto-reconciled', async () => {
    const counted = await call('submitCycleCount', () =>
      admin.inventory.cycleCountOperationsApi.submitCycleCount({
        submitCountRequest: {
          taskId: varianceTaskId,
          auditorId,
          actualQuantity: COUNTED_SHORT,
          measurementMethod: SubmitCountRequestMeasurementMethodEnum.ManualCount,
          varianceReason: 'Itest: deliberate short count',
        },
      }),
    );
    console.log(
      `[E6] variance ${counted.variance}, withinTolerance ${counted.withinTolerance}, ` +
        `task ${counted.taskStatus}`,
    );

    expect(Number(counted.variance)).toBe(EXPECTED_VARIANCE);
    expect(counted.withinTolerance).toBe(false);
    // No tolerance row is configured for a synthetic SKU at a brand-new bin, so
    // the resolver falls through to zero tolerance and only an exact match is
    // accepted. CONFLICT would mean a movement landed in the count window,
    // which cannot happen for a SKU nothing else touches.
    expect(counted.taskStatus).toBe('COUNTED_PENDING_REVIEW');
  }, 120_000);

  it('E7 — the auditor may recount once, and the recount supersedes the first count', async () => {
    const recounted = await call('submitCycleCountRecount', () =>
      admin.inventory.cycleCountOperationsApi.submitCycleCountRecount({
        submitRecountRequest: {
          taskId: varianceTaskId,
          auditorId,
          actualQuantity: COUNTED_SHORT,
          measurementMethod: SubmitRecountRequestMeasurementMethodEnum.ManualCount,
          // The auditor's own one immediate recount; a second one needs
          // TRIGGER_RECOUNT_ANY, which no persona in this suite holds.
          permission: 'TRIGGER_RECOUNT_SELF',
          varianceReason: 'Itest: recount confirms the short count',
        },
      }),
    );
    console.log(`[E7] recount ${recounted.recountSequenceNumber}, task ${recounted.taskStatus}`);

    expect(recounted.recountSequenceNumber).toBe(1);
    expect(Number(recounted.variance)).toBe(EXPECTED_VARIANCE);
    expect(recounted.limitExceeded).toBe(false);

    const task = await taskFor(varianceTaskId);
    expect(task.countEntriesCount).toBe(2);
    expect(task.latestCountEntryId).toBe(recounted.countEntryId);
  }, 120_000);

  it('E8 — the parts clerk raises the adjustment, which needs a manager tier', async () => {
    const adjustment = await call('createCycleCountAdjustment', () =>
      parts.inventory.cycleCountAdjustmentsApi.createCycleCountAdjustment({
        createAdjustmentRequest: {
          taskId: varianceTaskId,
          stockItemId: stock.skus[1],
          quantityOnHandBefore: SEEDED_QUANTITY,
          countedQuantity: COUNTED_SHORT,
          costAtTimeOfAdjustment: UNIT_COST,
          createdByUserId: parts.username,
          reasonCode: 'CYCLE_COUNT_VARIANCE',
        },
      }),
    );
    adjustmentId = adjustment.adjustmentId;
    console.log(
      `[E8] adjustment ${adjustmentId} status ${adjustment.status}, tier ${adjustment.requiredApprovalTier}`,
    );

    expect(Number(adjustment.quantityChange)).toBe(EXPECTED_VARIANCE);
    // The seeded TIER_1_MANAGER threshold is 0 units, so any variance at all
    // requires a decision; nothing auto-approves.
    expect(adjustment.status).toBe('PENDING_APPROVAL');
    expect(adjustment.requiredApprovalTier).toBe('TIER_1_MANAGER');
  }, 120_000);

  itInRoleMode('E9 — the clerk who raised the adjustment cannot approve it', async () => {
    const status = await expectHttpError(
      parts.inventory.cycleCountAdjustmentsApi.approveCycleCountAdjustment({
        adjustmentId,
        approveAdjustmentRequest: { notes: 'Itest: should be refused' },
      }),
      401,
      403,
    );
    console.log(`[E9] INVENTORY_LEAD refused adjustment:approve with HTTP ${status}`);
  }, 120_000);

  it('E10 — approving the adjustment posts it to the ledger', async () => {
    const pending = await call('listPendingCycleCountAdjustments', () =>
      admin.inventory.cycleCountAdjustmentsApi.listPendingCycleCountAdjustments(),
    );
    expect(pending.map((item) => item.adjustmentId)).toContain(adjustmentId);

    const approved = await call('approveCycleCountAdjustment', () =>
      admin.inventory.cycleCountAdjustmentsApi.approveCycleCountAdjustment({
        adjustmentId,
        approveAdjustmentRequest: { notes: `Itest run ${context.runId}` },
      }),
    );
    console.log(`[E10] adjustment ${adjustmentId} -> ${approved.status}, ledger ${approved.ledgerEntryId}`);

    // Approval and posting happen in one transaction, so the response already
    // carries the posted state; POSTED is the terminal one, APPROVED the step
    // before it, and either proves the decision was taken.
    expect(['APPROVED', 'POSTED']).toContain(approved.status);
    expect(approved.approvedByUserId).toBeTruthy();
    expect(approved.ledgerEntryId).toBeTruthy();

    // Deliberately the adjustment's own row, not the environment-wide pending
    // count: alpha is shared and the seeder's inventory loop raises adjustments
    // of its own, so a global tally can stay flat while this one is decided.
    const settled = await call('getCycleCountAdjustment', () =>
      admin.inventory.cycleCountAdjustmentsApi.getCycleCountAdjustment({ adjustmentId }),
    );
    console.log(`[E10] adjustment re-read as ${settled.status}, posted ${settled.postedAt?.toISOString()}`);
    expect(['APPROVED', 'POSTED']).toContain(settled.status);

    const stillPending = await call('listPendingCycleCountAdjustments', () =>
      admin.inventory.cycleCountAdjustmentsApi.listPendingCycleCountAdjustments(),
    );
    expect(stillPending.map((item) => item.adjustmentId)).not.toContain(adjustmentId);
  }, 180_000);

  it('E11 — the counted plan completes and is approved', async () => {
    const completed = await call('updateCycleCountPlanStatus', () =>
      admin.inventory.cycleCountPlansApi.updateCycleCountPlanStatus({
        planId,
        updateCycleCountPlanStatusRequest: { status: UpdateCycleCountPlanStatusRequestStatusEnum.CompletedPendingApproval },
      }),
    );
    expect(completed.status).toBe('COMPLETED_PENDING_APPROVAL');

    const approved = await call('updateCycleCountPlanStatus', () =>
      admin.inventory.cycleCountPlansApi.updateCycleCountPlanStatus({
        planId,
        updateCycleCountPlanStatusRequest: { status: UpdateCycleCountPlanStatusRequestStatusEnum.Approved },
      }),
    );
    console.log(`[E11] plan ${planId} -> ${approved.status}`);
    expect(approved.status).toBe('APPROVED');
  }, 120_000);

  it('E12 — lifecycle negatives: an approved plan is terminal and a counted task is not re-counted', async () => {
    // APPROVED has no outgoing transitions, so going back to STARTED is
    // refused. IllegalStateException maps to 409 in pos-inventory.
    const reopened = await expectHttpError(
      admin.inventory.cycleCountPlansApi.updateCycleCountPlanStatus({
        planId,
        updateCycleCountPlanStatusRequest: { status: UpdateCycleCountPlanStatusRequestStatusEnum.Started },
      }),
      409,
    );
    console.log(`[E12] reopening an approved plan refused with HTTP ${reopened}`);

    // submitCycleCount requires ASSIGNED; the exact task closed in E5.
    const recounted = await expectHttpError(
      admin.inventory.cycleCountOperationsApi.submitCycleCount({
        submitCountRequest: {
          taskId: exactTaskId,
          auditorId,
          actualQuantity: SEEDED_QUANTITY,
          measurementMethod: SubmitCountRequestMeasurementMethodEnum.ManualCount,
        },
      }),
      409,
    );
    console.log(`[E12] re-counting a closed task refused with HTTP ${recounted}`);

    // A plan that never existed is a 404, not an empty task list.
    const missing = await expectHttpError(
      admin.inventory.cycleCountPlansApi.listCycleCountPlanTasks({ planId: randomUUID() }),
      404,
    );
    console.log(`[E12] tasks for an unknown plan refused with HTTP ${missing}`);
  }, 180_000);

  itInRoleMode('E13 — a technician can neither read nor record a count', async () => {
    const read = await expectHttpError(
      tech.inventory.cycleCountQueryApi.getCycleCountTask({ taskId: varianceTaskId }),
      401,
      403,
    );
    const write = await expectHttpError(
      tech.inventory.cycleCountOperationsApi.submitCycleCount({
        submitCountRequest: {
          taskId: varianceTaskId,
          auditorId,
          actualQuantity: 1,
          measurementMethod: SubmitCountRequestMeasurementMethodEnum.ManualCount,
        },
      }),
      401,
      403,
    );
    console.log(`[E13] TECHNICIAN refused cycle_count:view with ${read} and :complete with ${write}`);

    // The clerk who raised the adjustment can still read it back: INVENTORY_LEAD
    // holds inventory:adjustment:view even though it holds no cycle_count
    // permission at all. That split is the RBAC gap E2 pins down, seen from the
    // other side.
    const seen = await call('getCycleCountAdjustment', () =>
      parts.inventory.cycleCountAdjustmentsApi.getCycleCountAdjustment({ adjustmentId }),
    );
    expect(seen.adjustmentId).toBe(adjustmentId);
  }, 120_000);
});
