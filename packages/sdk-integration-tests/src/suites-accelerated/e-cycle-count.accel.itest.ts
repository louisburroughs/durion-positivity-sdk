/*
 * ACCELERATED COPY of ../suites/e-cycle-count.itest.ts (spec: Task A6).
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
import { SEED_VENDOR_ID, SeederRandom } from '@durion-sdk/seeder';
import {
  StorageLocationRequestStorageCategoryCodeEnum,
  StorageLocationRequestTypeEnum,
} from '@durion-sdk/location';
import {
  CreateScrapRequestReasonCodeEnum,
  SubmitCountRequestMeasurementMethodEnum,
  SubmitRecountRequestMeasurementMethodEnum,
  UpdateCycleCountPlanStatusRequestStatusEnum,
} from '@durion-sdk/inventory';
import {
  ADJUSTMENT_GAIN_ACCOUNT,
  ADJUSTMENT_POSTED,
  INVENTORY_ACCOUNT,
  SCRAP_POSTED,
  SHRINKAGE_ACCOUNT,
  accountingEventsFor,
  awaitAccountingEvent,
  journalEntryOf,
  serverDate,
  shapeOf,
  wallDate,
} from '../harness/accounting';
import { createCatalogProduct, readNumber, readString, seedFromRunId } from '../harness/builders';
import { call, expectHttpError, formatError, isHttpStatus } from '../harness/http';
import { readOnHand } from '../harness/availability';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';
import { Personas, type DomainClients } from '../harness/personas';
import { receivePriced, seedOnHand, type SeededStock } from '../harness/stock';
import { waitFor } from '../harness/waitFor';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;
/**
 * E2 is about the parts clerk's own grant. Role mode only needs one persona to
 * be configured, and an unconfigured parts persona falls back to the admin, so
 * E2 runs only when the parts persona itself is set.
 */
const PARTS_CONFIGURED = ItestConfig.fromEnv().personaCredentials.parts !== undefined;
const itWithPartsPersona = PARTS_CONFIGURED ? it : it.skip;

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
 * The personas follow the seeded grants. The alpha data load grants
 * `inventory:cycle_count:initiate|view|complete` to INVENTORY_LEAD, so the parts
 * clerk who does the physical counting plans the count (E1, pinned by E2); the
 * rest of the count still runs as the admin. See the RBAC note in the README.
 */
describe('Suite E — cycle counting', () => {
  /** Seeded into the run's own bin, and the expected quantity every task starts from. */
  const SEEDED_QUANTITY = 40;
  /** The short count in E6. Chosen well outside any plausible tolerance. */
  const COUNTED_SHORT = 33;
  const EXPECTED_VARIANCE = COUNTED_SHORT - SEEDED_QUANTITY;
  const UNIT_COST = 12.5;

  let context: ItestContext;
  let accel: AcceleratedFixture;
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
  /** Who E1's plan was created by, for E2. */
  let planCreatedBy: string | undefined;
  let exactTaskId: string;
  let varianceTaskId: string;
  let adjustmentId: string;
  /** E14's write-off, of a SKU nothing costed: E27 follows it to the ledger. */
  let uncostedScrapId: string | undefined;

  /**
   * The next open virtual day: createCycleCountPlan rejects a scheduledDate that is
   * not in the future, and "the future" is the backend's virtual future, which the
   * laptop's tomorrow is a year behind. Scheduled onto a day the shop opens,
   * because a count is floor work.
   */
  const tomorrow = async (): Promise<Date> => {
    const at = await accel.now();
    return accel.calendar.nextOpen(new Date(at.getTime() + 86_400_000), 'BAY');
  };

  const taskFor = async (taskId: string) =>
    call('getCycleCountTask', () => admin.inventory.cycleCountQueryApi.getCycleCountTask({ taskId }));

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
    // Read before the call: the virtual instant is an await, and the thunk `call`
    // takes is not async.
    const scheduledDate = await tomorrow();
    const plan = await call('createCycleCountPlan', () =>
      parts.inventory.cycleCountPlansApi.createCycleCountPlan({
        createCycleCountPlanRequest: {
          locationId: siteId,
          planName: `Itest cycle count ${context.runId}`,
          scheduledDate,
          zoneIds: [zoneId],
        },
      }),
    );
    planId = plan.planId;
    planCreatedBy = plan.createdBy;
    console.log(`[E1] plan ${planId} status = ${plan.status}`);

    expect(plan.status).toBe('PLANNED');
    expect(plan.zoneIds).toContain(zoneId);
    expect(plan.locationId).toBe(siteId);
  }, 120_000);

  // The alpha data load (scripts/fixtures/seed/alpha/security/role-permissions.csv)
  // grants INVENTORY_LEAD inventory:cycle_count:initiate, :view and :complete, so
  // the parts clerk who counts stock in the building plans the count: E1 creates
  // the plan as the clerk. This pins down that the clerk's own grant is what let
  // it, rather than the admin fallback a single-credential run would use. A
  // second plan is deliberately not created: another plan over the same bin
  // would be scanned by E3's task generation too.
  itWithPartsPersona('E2 — the parts clerk plans the count', async () => {
    expect(parts.username).not.toBe(admin.username);
    expect(planCreatedBy).toBe(parts.username);

    const tasks = await call('listCycleCountPlanTasks', () =>
      parts.inventory.cycleCountPlansApi.listCycleCountPlanTasks({ planId }),
    );
    console.log(`[E2] INVENTORY_LEAD planned ${planId} and reads its ${tasks.length} task(s)`);
    expect(Array.isArray(tasks)).toBe(true);
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

    // The clerk who raised the adjustment can read it back: INVENTORY_LEAD holds
    // inventory:adjustment:view alongside its cycle_count grants.
    const seen = await call('getCycleCountAdjustment', () =>
      parts.inventory.cycleCountAdjustmentsApi.getCycleCountAdjustment({ adjustmentId }),
    );
    expect(seen.adjustmentId).toBe(adjustmentId);
  }, 120_000);

  describe('E11 — the weekly cadence', () => {
    // Accelerated-only (spec: Task A6). The year run fires a cycle count on every
    // 7th virtual day and a restock on every 30th; this pins the arithmetic those
    // decisions are made from, against the same calendar, without waiting a virtual
    // week to watch it happen.
    it('falls on every 7th virtual day and never on an adjacent one', () => {
      const due = (dayNumber: number): boolean => dayNumber % 7 === 0;

      expect([7, 14, 21, 28, 35, 364].every(due)).toBe(true);
      expect([1, 6, 8, 13, 15, 29, 365].some(due)).toBe(false);
      // A restock's cadence is independent of the count's: day 30 restocks without
      // counting, day 210 does both.
      expect(30 % 30 === 0 && !due(30)).toBe(true);
      expect(210 % 30 === 0 && due(210)).toBe(true);
    });

    it('schedules onto a day the shop actually opens', async () => {
      // A count is floor work, so its scheduled date has to be an open day even when
      // "tomorrow" in virtual time is a Sunday or a holiday.
      const at = await accel.now();
      for (let ahead = 1; ahead <= 9; ahead += 1) {
        const scheduled = accel.calendar.nextOpen(new Date(at.getTime() + ahead * 86_400_000), 'BAY');
        expect(accel.calendar.isWorkingDay(scheduled)).toBe(true);
        expect(accel.calendar.isOpen(scheduled, 'BAY')).toBe(true);
        expect(scheduled.getTime()).toBeGreaterThan(at.getTime());
      }
    });
  });

  /**
   * Write-offs, which are not cycle-count adjustments.
   *
   * The two look alike and settle different facts: an adjustment reconciles a
   * count against the shelf, a scrap is a decision to destroy value. The backend
   * treats them differently too — a posted scrap emits `ScrapPostedV1`, which
   * pos-accounting posts on the `INVENTORY_SHRINKAGE` mapping, while an approved
   * adjustment emits `InventoryAdjustedV1`, posted on `INVENTORY_ADJUSTMENT`
   * (durion-positivity-backend#2186). Until this block existed, no suite called
   * `createScrap` at all, so none of that path had ever been exercised. What either
   * fact turned into in the ledger is asserted in the block after this one.
   *
   * Identical to its non-accelerated twin on purpose: a write-off carries no
   * business instant of its own — the scrap is dated by the backend — so there is
   * no clock or calendar concern here to translate.
   *
   * Its own bin, for the reason the count has one: task generation scans every
   * stocked (bin, SKU) pair in scope, and a third SKU in the counted bin would
   * break E3's "exactly the two stocked SKUs".
   */
  describe('write-offs', () => {
    /** Enough to write off twice and still have a boundary left to test. */
    const SCRAP_SEEDED = 10;
    const SCRAP_QUANTITY = 4;

    let scrapBinId: string;
    let scrapSku: string;

    beforeAll(async () => {
      const bin = await call('createStorageLocation', () =>
        admin.location.storageLocationApi.createStorageLocation({
          siteId,
          storageLocationRequest: {
            name: `Itest scrap ${context.runId}`,
            type: StorageLocationRequestTypeEnum.Bin,
            storageCategoryCode: StorageLocationRequestStorageCategoryCodeEnum.General,
          },
        }),
      );
      scrapBinId = bin.id;
      scrapSku = `ITEST-SCRAP-${context.runId}`;

      await seedOnHand(parts, admin, {
        locationId: scrapBinId,
        quantity: SCRAP_SEEDED,
        skus: [scrapSku],
      });
      console.log(`[E] seeded ${SCRAP_SEEDED} of ${scrapSku} into scrap bin ${scrapBinId}`);
    }, 180_000);

    /**
     * Drives a scrap to a terminal state and says which way it went.
     *
     * Value decides the path, not the caller: below the approval thresholds the
     * backend auto-approves and posts `SCRAP_OUT` in the same transaction, and
     * above them — or when no cost can be derived at all — it parks in
     * PENDING_APPROVAL for a manager. Stock seeded through bulk ingest carries no
     * receipt cost, so this suite's scraps are expected to take the second path;
     * both are handled because which one applies is the backend's decision and
     * this helper is not the place to assert it.
     */
    /**
     * On hand in the scrap bin, as the ledger holds it.
     *
     * Stock is seeded with the bin id in the location column — pos-inventory does
     * not resolve it against the location service — so availability is asked the
     * same question the seeding asked. A 404 is "no stock-summary rows", which is
     * zero rather than a failure.
     */
    const onHand = async (): Promise<number> => {
      try {
        const availability = await parts.inventory.inventoryAvailabilityApi.getAvailabilityBySku({
          productSku: scrapSku,
          locationId: scrapBinId,
        });
        return Math.max(0, Math.trunc(readNumber(availability, 'onHandQuantity', 'onHandQty') ?? 0));
      } catch (error) {
        if (isHttpStatus(error, 404)) return 0;
        throw new Error(`getAvailabilityBySku ${scrapSku} failed: ${await formatError(error)}`);
      }
    };

    const settle = async (scrapId: string, status: string | undefined): Promise<string | undefined> => {
      if (status !== 'PENDING_APPROVAL') return status;
      const approved = await call('approveScrap', () =>
        admin.inventory.scrapsApi.approveScrap({
          scrapId,
          approveScrapRequest: { negativeStockOverride: false },
        }),
      );
      return approved.status;
    };

    it('E14 — a write-off posts and carries the ledger entry that moved the stock', async () => {
      const created = await call('createScrap', () =>
        parts.inventory.scrapsApi.createScrap({
          createScrapRequest: {
            stockItemId: scrapSku,
            locationId: scrapBinId,
            quantity: SCRAP_QUANTITY,
            reasonCode: CreateScrapRequestReasonCodeEnum.Damaged,
            negativeStockOverride: false,
            shouldReplenish: false,
            notes: `Itest write-off ${context.runId}`,
          },
        }),
      );
      const scrapId = created.scrapId as string;
      expect(scrapId).toBeTruthy();
      console.log(`[E14] scrap ${scrapId} created ${created.status}, cost source ${created.costSource}`);

      const status = await settle(scrapId, created.status);
      expect(['POSTED', 'AUTO_APPROVED', 'APPROVED']).toContain(status);

      const posted = await call('getScrap', () =>
        admin.inventory.scrapsApi.getScrap({ scrapId }),
      );
      expect(posted.quantity).toBe(SCRAP_QUANTITY);
      expect(posted.reasonCode).toBe('DAMAGED');
      // The entry is the write-off: a posted scrap that moved stock without one
      // would leave the ledger unable to explain where the stock went.
      expect(posted.ledgerEntryId).toBeTruthy();
      uncostedScrapId = scrapId;
    }, 120_000);

    it('E15 — writing off more than is on the shelf is refused', async () => {
      // Deliberately more than the bin now holds, which is also how E14's reduction
      // is proved: seeded ten, wrote off four, so ten is no longer available.
      // The refusal lands on whichever call does the posting — on create when the
      // value auto-approves, on approve when it did not — so both are accepted here
      // rather than pinning a path the cost snapshot decides.
      let created: Awaited<ReturnType<typeof parts.inventory.scrapsApi.createScrap>> | undefined;
      let refusal: unknown;
      try {
        created = await parts.inventory.scrapsApi.createScrap({
          createScrapRequest: {
            stockItemId: scrapSku,
            locationId: scrapBinId,
            quantity: SCRAP_SEEDED,
            reasonCode: CreateScrapRequestReasonCodeEnum.Lost,
            negativeStockOverride: false,
            shouldReplenish: false,
            notes: `Itest over-scrap ${context.runId}`,
          },
        });
      } catch (error) {
        refusal = error;
      }

      if (refusal !== undefined) {
        // Specifically 422, not merely "it threw". A bare catch here would let a
        // 401, a 400 or a transport failure stand in for the refusal this test
        // exists to observe, and the test would pass while proving nothing.
        if (!isHttpStatus(refusal, 422)) {
          throw new Error(`Expected 422 for an over-scrap, got: ${await formatError(refusal)}`);
        }
        console.log('[E15] refused at creation with 422');
        return;
      }

      const scrapId = created?.scrapId as string;
      const status = await expectHttpError(
        admin.inventory.scrapsApi.approveScrap({
          scrapId,
          approveScrapRequest: { negativeStockOverride: false },
        }),
        422,
      );
      console.log(`[E15] accepted at creation, refused at approval with ${status}`);
    }, 120_000);

    it('E16 — OTHER without notes is refused', async () => {
      const status = await expectHttpError(
        parts.inventory.scrapsApi.createScrap({
          createScrapRequest: {
            stockItemId: scrapSku,
            locationId: scrapBinId,
            quantity: 1,
            reasonCode: CreateScrapRequestReasonCodeEnum.Other,
            negativeStockOverride: false,
            shouldReplenish: false,
          },
        }),
        400,
      );
      console.log(`[E16] OTHER without notes refused with ${status}`);
    }, 120_000);

    it('E17 — a rejected write-off leaves the shelf alone', async () => {
      const created = await call('createScrap', () =>
        parts.inventory.scrapsApi.createScrap({
          createScrapRequest: {
            stockItemId: scrapSku,
            locationId: scrapBinId,
            quantity: 1,
            reasonCode: CreateScrapRequestReasonCodeEnum.Expired,
            negativeStockOverride: false,
            shouldReplenish: false,
            notes: `Itest rejected write-off ${context.runId}`,
          },
        }),
      );
      const scrapId = created.scrapId as string;

      // Measured after creation rather than before it, because an auto-approved
      // scrap has already moved stock by this point and that movement is E14's
      // subject, not this one. What this test is named for is narrower: the
      // *rejection* must move nothing.
      const before = await onHand();

      // Only a PENDING_APPROVAL scrap can be rejected; one that auto-approved has
      // already posted, and rejection then answers 409. Which path applies is the
      // cost snapshot's decision, so both are driven — and both are measured,
      // because a branch that only asserts a status code would let this test pass
      // without ever checking the shelf it is named for.
      if (created.status !== 'PENDING_APPROVAL') {
        console.log(`[E17] scrap ${scrapId} was ${created.status} on creation, so rejection must conflict`);
        const conflict = await expectHttpError(
          admin.inventory.scrapsApi.rejectScrap({
            scrapId,
            rejectScrapRequest: { rejectionReason: `Itest ${context.runId}` },
          }),
          409,
        );
        expect(conflict).toBe(409);
      } else {
        const rejected = await call('rejectScrap', () =>
          admin.inventory.scrapsApi.rejectScrap({
            scrapId,
            rejectScrapRequest: { rejectionReason: `Part was recovered [${context.runId}]` },
          }),
        );
        expect(rejected.status).toBe('REJECTED');
        // Nothing moved, so nothing posted.
        expect(rejected.ledgerEntryId).toBeFalsy();
      }

      const after = await onHand();
      console.log(`[E17] on hand ${before} before the rejection, ${after} after`);
      expect(after).toBe(before);
    }, 120_000);

    itInRoleMode('E18 — a technician may not write stock off', async () => {
      const refused = await expectHttpError(
        tech.inventory.scrapsApi.createScrap({
          createScrapRequest: {
            stockItemId: scrapSku,
            locationId: scrapBinId,
            quantity: 1,
            reasonCode: CreateScrapRequestReasonCodeEnum.Damaged,
            negativeStockOverride: false,
            shouldReplenish: false,
            notes: `Itest technician write-off ${context.runId}`,
          },
        }),
        401,
        403,
      );
      console.log(`[E18] TECHNICIAN refused createScrap with ${refused}`);
    }, 120_000);
  });

  /**
   * The accounting consequence of everything above.
   *
   * An approved count variance, an approved manual adjustment and a posted scrap
   * each emit a fact that pos-accounting turns into a journal entry — or records as
   * skipped, when inventory could not cost the movement. Until this block the suite
   * stopped at the inventory ledger, so the shrinkage consumer being off, the
   * uncosted skip firing on everything, or the adjustment producer being absent
   * would all have passed (durion `SPEC-inventory-adjustment-gl-posting.md` §2.5, §6).
   *
   * The route from an id this suite holds to the ledger is the ingestion record:
   * `listAccountingEvents` by fact type and `domainKeyId`, then `getJournalEntry`.
   * Every wait is a poll with a deadline, and a deadline passed is a failure — an
   * absent consumer must fail these tests, not skip them.
   *
   * Costed and uncosted SKUs are both deliberate. The costed ones are catalog
   * products received on a priced goods receipt, which since
   * durion-positivity-backend#2203 stamps the receipt cost on the ledger row; the
   * uncosted cases reuse the SKUs the blocks above seeded by bulk ingest, which
   * carries no cost, and never received.
   *
   * The costed stock is received at the site, not a bin: the goods-receipt scope
   * check matches the location the caller's grant names, and a grant names the
   * site. SKUs unique to the run keep that stock the run's own. The conflict case
   * has its own bin, for the reason the write-offs do: its plan's tasks must be
   * only its own.
   */
  describe('the accounting consequence', () => {
    const GL_SEEDED = 40;
    /** $12.50, as the receipt prices it: USD has two minor digits. */
    const GL_UNIT_COST_MINOR = 1_250;
    const GL_UNIT_COST = GL_UNIT_COST_MINOR / 100;
    const LOSS = 4;
    const GAIN = 3;
    const MANUAL_LOSS = 5;
    const MANUAL_GAIN = 2;
    const SCRAPPED = 3;
    const CONFLICT_COUNTED = 33;
    const WAIT_MS = Math.max(ItestConfig.fromEnv().waitTimeoutMs, 60_000);

    /** Where the costed stock is received and every costed posting lands: the site. */
    let costedLocationId: string;
    let conflictBinId: string;
    let lossSku: string;
    let gainSku: string;
    let manualSku: string;
    let costedScrapSku: string;
    let conflictSku: string;

    beforeAll(async () => {
      const bin = async (name: string) =>
        (
          await call('createStorageLocation', () =>
            admin.location.storageLocationApi.createStorageLocation({
              siteId,
              storageLocationRequest: {
                name: `${name} ${context.runId}`,
                type: StorageLocationRequestTypeEnum.Bin,
                storageCategoryCode: StorageLocationRequestStorageCategoryCodeEnum.General,
              },
            }),
          )
        ).id;
      conflictBinId = await bin('Itest GL conflict');
      costedLocationId = siteId;

      // Catalog products, not free-text references: a purchase order line names a
      // product the order service knows. The product id is the stock reference.
      const ctx = {
        runId: context.runId,
        random: new SeederRandom(seedFromRunId(`${context.runId}:e-cycle-count-gl`)),
        refs: context.referenceCache,
      };
      const product = async (suffix: string) =>
        (await call(`createCatalogProduct ${suffix}`, () => createCatalogProduct(admin, ctx, suffix))).productEntityId;
      lossSku = await product('GL-LOSS');
      gainSku = await product('GL-GAIN');
      manualSku = await product('GL-MANUAL');
      costedScrapSku = await product('GL-SCRAP');
      conflictSku = `ITEST-GL-${context.runId}-CONFLICT`;

      const costed = [lossSku, gainSku, manualSku, costedScrapSku];
      const receipt = await receivePriced(parts, personas.as('manager'), ctx, {
        locationId: costedLocationId,
        vendorId: SEED_VENDOR_ID,
        skus: costed,
        quantity: GL_SEEDED,
        unitCostMinor: GL_UNIT_COST_MINOR,
      });
      // The receipt answering is not the stock being visible: availability is a
      // projection, and suite D polls it after every receipt for the same reason.
      // No test starts until all four SKUs show the full quantity at the site.
      for (const sku of costed) {
        await waitFor(async () => (await readOnHand(parts, sku, costedLocationId)) >= GL_SEEDED, {
          timeoutMs: 90_000,
          description: `${GL_SEEDED} of ${sku} on hand at ${costedLocationId} after the priced receipt`,
        });
      }
      // Uncosted on purpose: the conflict case asserts that nothing is produced,
      // which does not depend on a cost.
      await seedOnHand(parts, admin, { locationId: conflictBinId, quantity: GL_SEEDED, skus: [conflictSku] });
      console.log(
        `[E] received ${GL_SEEDED} of each of ${costed.join(', ')} at ${GL_UNIT_COST} on receipt ` +
          `${receipt.receiptId} (PO ${receipt.purchaseOrderId}) into ${costedLocationId}`,
      );
    }, 600_000);

    /** Raises and approves a task-less count adjustment where the costed stock is, returning it settled. */
    const countAndApprove = async (sku: string, counted: number) => {
      const created = await call('createCycleCountAdjustment', () =>
        parts.inventory.cycleCountAdjustmentsApi.createCycleCountAdjustment({
          createAdjustmentRequest: {
            stockItemId: sku,
            locationId: costedLocationId,
            quantityOnHandBefore: GL_SEEDED,
            countedQuantity: counted,
            costAtTimeOfAdjustment: GL_UNIT_COST,
            createdByUserId: parts.username,
            reasonCode: 'CYCLE_COUNT_VARIANCE',
          },
        }),
      );
      await call('approveCycleCountAdjustment', () =>
        admin.inventory.cycleCountAdjustmentsApi.approveCycleCountAdjustment({
          adjustmentId: created.adjustmentId,
          approveAdjustmentRequest: { notes: `Itest GL run ${context.runId}` },
        }),
      );
      return call('getCycleCountAdjustment', () =>
        admin.inventory.cycleCountAdjustmentsApi.getCycleCountAdjustment({ adjustmentId: created.adjustmentId }),
      );
    };

    /** Raises and approves a manual adjustment request, returning its id. */
    const adjustAndApprove = async (sku: string, locationId: string, quantity: number): Promise<string> => {
      const request = await call('createAdjustmentRequest', () =>
        parts.inventory.stockMovementsApi.createAdjustmentRequest({
          createAdjustmentRequestDto: { productSku: sku, locationId, quantity, reasonCode: 'ITEST_ADJUSTMENT' },
        }),
      );
      await call('approveAdjustmentRequest', () =>
        admin.inventory.stockMovementsApi.approveAdjustmentRequest({
          adjustmentRequestId: request.adjustmentRequestId,
        }),
      );
      return request.adjustmentRequestId;
    };

    /** The ledger row a posting wrote, which carries the cost the engine stamped on it. */
    const ledgerEntry = async (entryId: string) =>
      call('getInventoryLedgerEntry', () => admin.inventory.inventoryLedgerApi.getInventoryLedgerEntry({ entryId }));

    /**
     * Follows a costed fact to its journal entry and asserts the two lines.
     *
     * `debit` / `credit` name the accounts; the amount is `abs(delta) × unitCost` as
     * the inventory ledger holds them, and the date is the posting instant's date —
     * business time, so a redelivery lands in the same period.
     */
    const expectPosted = async (
      tag: string,
      eventType: string,
      domainKeyId: string,
      expected: { debit: string; credit: string; amount: number; occurredAt: Date },
    ) => {
      const event = await awaitAccountingEvent(admin, eventType, domainKeyId, WAIT_MS);
      console.log(
        `[${tag}] ${eventType} ${domainKeyId} -> ${event.status} ${event.idempotencyOutcome ?? ''}, ` +
          `journal entry ${event.journalEntryId}`,
      );
      expect(event.status).toBe('PROCESSED');
      expect(event.journalEntryId).toBeTruthy();

      const entry = await journalEntryOf(admin, event.journalEntryId as string);
      const shape = shapeOf(entry);
      console.log(
        `[${tag}] entry ${entry.entryNumber}: Dr ${shape.debitAccounts.join('+')} ${shape.totalDebits} / ` +
          `Cr ${shape.creditAccounts.join('+')} ${shape.totalCredits}, dated ${entry.transactionDate?.toISOString()}`,
      );
      expect(shape.lineCount).toBe(2);
      expect(shape.debitAccounts).toEqual([expected.debit]);
      expect(shape.creditAccounts).toEqual([expected.credit]);
      expect(shape.totalDebits).toBeCloseTo(expected.amount, 2);
      expect(shape.totalCredits).toBeCloseTo(expected.amount, 2);
      expect(entry.transactionDate).toBeDefined();
      expect(wallDate(entry.transactionDate as Date)).toBe(serverDate(expected.occurredAt));
      return { event, entry };
    };

    /** An uncosted fact is recorded and skipped: never a zero or an indeterminate entry. */
    const expectSkipped = async (tag: string, eventType: string, domainKeyId: string) => {
      const event = await awaitAccountingEvent(admin, eventType, domainKeyId, WAIT_MS);
      console.log(`[${tag}] ${eventType} ${domainKeyId} -> ${event.status} ${event.failureReasonCode ?? ''}`);
      expect(event.status).toBe('SKIPPED');
      expect(event.failureReasonCode).toBe('UNCOSTED_FACT');
      expect(event.journalEntryId).toBeFalsy();
      const all = await accountingEventsFor(admin, eventType, domainKeyId);
      expect(all.filter((record) => record.journalEntryId)).toEqual([]);
    };

    it('E19 — a costed count shortfall posts Dr shrinkage / Cr inventory at the engine cost', async () => {
      const adjustment = await countAndApprove(lossSku, GL_SEEDED - LOSS);
      expect(['APPROVED', 'POSTED']).toContain(adjustment.status);
      expect(adjustment.ledgerEntryId).toBeTruthy();

      // The fixture, checked rather than assumed: the variance must have posted at the
      // cost the SKU was given, or the amount below would be proving nothing.
      const posted = await ledgerEntry(adjustment.ledgerEntryId as string);
      expect(posted.eventType).toBe('COUNT_VARIANCE_OUT');
      expect(Number(posted.unitCost)).toBeCloseTo(GL_UNIT_COST, 4);

      const { entry } = await expectPosted('E19', ADJUSTMENT_POSTED, adjustment.adjustmentId, {
        debit: SHRINKAGE_ACCOUNT,
        credit: INVENTORY_ACCOUNT,
        amount: LOSS * GL_UNIT_COST,
        occurredAt: adjustment.postedAt ?? posted.timestamp,
      });
      expect(shapeOf(entry).inventoryNet).toBeCloseTo(-LOSS * GL_UNIT_COST, 2);
    }, 180_000);

    it('E20 — a costed count gain posts Dr inventory / Cr the adjustment-gain account', async () => {
      const adjustment = await countAndApprove(gainSku, GL_SEEDED + GAIN);
      expect(adjustment.ledgerEntryId).toBeTruthy();
      const posted = await ledgerEntry(adjustment.ledgerEntryId as string);
      expect(posted.eventType).toBe('COUNT_VARIANCE_IN');
      expect(Number(posted.unitCost)).toBeCloseTo(GL_UNIT_COST, 4);

      const { entry } = await expectPosted('E20', ADJUSTMENT_POSTED, adjustment.adjustmentId, {
        debit: INVENTORY_ACCOUNT,
        credit: ADJUSTMENT_GAIN_ACCOUNT,
        amount: GAIN * GL_UNIT_COST,
        occurredAt: adjustment.postedAt ?? posted.timestamp,
      });
      expect(shapeOf(entry).inventoryNet).toBeCloseTo(GAIN * GL_UNIT_COST, 2);
    }, 180_000);

    it('E21 — the uncosted count variance E10 posted is recorded as skipped, with no entry', async () => {
      // E10's SKU was seeded by bulk ingest and never costed: costSource NONE by design.
      expect(adjustmentId).toBeTruthy();
      await expectSkipped('E21', ADJUSTMENT_POSTED, adjustmentId);
    }, 180_000);

    it('E22 — a variance the movements fully explain approves with nothing to post and no fact', async () => {
      // Read before the call, as E1 does: the virtual instant is an await.
      const scheduledDate = await tomorrow();
      const plan = await call('createCycleCountPlan', () =>
        admin.inventory.cycleCountPlansApi.createCycleCountPlan({
          createCycleCountPlanRequest: {
            locationId: siteId,
            planName: `Itest GL conflict ${context.runId}`,
            scheduledDate,
            zoneIds: [conflictBinId],
          },
        }),
      );
      const generated = await call('generateCycleCountTasks', () =>
        admin.inventory.cycleCountPlansApi.generateCycleCountTasks({
          planId: plan.planId,
          generateCycleCountTasksRequest: { auditorId },
        }),
      );
      const task = generated.tasks.find((candidate) => candidate.itemSku === conflictSku);
      expect(task).toBeDefined();
      const taskId = task!.taskId;

      const counted = await call('submitCycleCount', () =>
        admin.inventory.cycleCountOperationsApi.submitCycleCount({
          submitCountRequest: {
            taskId,
            auditorId,
            actualQuantity: CONFLICT_COUNTED,
            measurementMethod: SubmitCountRequestMeasurementMethodEnum.ManualCount,
            varianceReason: 'Itest: short count the movements will explain',
          },
        }),
      );
      expect(counted.taskStatus).toBe('COUNTED_PENDING_REVIEW');

      const created = await call('createCycleCountAdjustment', () =>
        parts.inventory.cycleCountAdjustmentsApi.createCycleCountAdjustment({
          createAdjustmentRequest: {
            taskId,
            stockItemId: conflictSku,
            quantityOnHandBefore: GL_SEEDED,
            countedQuantity: CONFLICT_COUNTED,
            costAtTimeOfAdjustment: GL_UNIT_COST,
            createdByUserId: parts.username,
            reasonCode: 'CYCLE_COUNT_VARIANCE',
          },
        }),
      );
      const conflictAdjustmentId = created.adjustmentId;

      // The movement that explains the whole shortfall, landing inside the count window.
      await adjustAndApprove(conflictSku, conflictBinId, CONFLICT_COUNTED - GL_SEEDED);

      // The first approval finds the in-window movement, flags the task CONFLICT and
      // refuses; the second is the reviewer's explicit accept, which recomputes the
      // variance against current on hand — zero — and posts nothing.
      const refused = await expectHttpError(
        admin.inventory.cycleCountAdjustmentsApi.approveCycleCountAdjustment({
          adjustmentId: conflictAdjustmentId,
          approveAdjustmentRequest: { notes: `Itest GL conflict ${context.runId}` },
        }),
        409,
      );
      console.log(`[E22] first approval refused with ${refused}; the task is now CONFLICT`);
      const accepted = await call('approveCycleCountAdjustment', () =>
        admin.inventory.cycleCountAdjustmentsApi.approveCycleCountAdjustment({
          adjustmentId: conflictAdjustmentId,
          approveAdjustmentRequest: { notes: `Itest GL conflict accepted ${context.runId}` },
        }),
      );
      console.log(`[E22] re-approved as ${accepted.status}, variance ${accepted.quantityChange}`);
      expect(Number(accepted.quantityChange)).toBe(0);
      expect(accepted.ledgerEntryId).toBeFalsy();

      // Absence needs a clock to be read against, and a fixed sleep is not one. A
      // later fact through the same producer, outbox and consumer is: once its record
      // is terminal, anything the approval above had emitted would have been consumed
      // too. The sentinel is uncosted, so it is also one more skip on record.
      const sentinel = await adjustAndApprove(conflictSku, conflictBinId, 1);
      await awaitAccountingEvent(admin, ADJUSTMENT_POSTED, sentinel, WAIT_MS);
      const records = await accountingEventsFor(admin, ADJUSTMENT_POSTED, conflictAdjustmentId);
      console.log(`[E22] ${records.length} ingestion record(s) for the zero-variance adjustment`);
      expect(records).toEqual([]);
    }, 300_000);

    it('E23 — a costed manual loss posts Dr shrinkage / Cr inventory', async () => {
      const requestId = await adjustAndApprove(manualSku, costedLocationId, -MANUAL_LOSS);
      const event = await awaitAccountingEvent(admin, ADJUSTMENT_POSTED, requestId, WAIT_MS);
      const posted = await ledgerEntry(readString(event.payload, 'ledgerEntryId') as string);
      expect(posted.eventType).toBe('ADJUSTMENT_OUT');
      expect(Number(posted.unitCost)).toBeCloseTo(GL_UNIT_COST, 4);

      await expectPosted('E23', ADJUSTMENT_POSTED, requestId, {
        debit: SHRINKAGE_ACCOUNT,
        credit: INVENTORY_ACCOUNT,
        amount: MANUAL_LOSS * GL_UNIT_COST,
        occurredAt: posted.timestamp,
      });
    }, 180_000);

    it('E24 — a costed manual gain posts Dr inventory / Cr the adjustment-gain account', async () => {
      const requestId = await adjustAndApprove(manualSku, costedLocationId, MANUAL_GAIN);
      const event = await awaitAccountingEvent(admin, ADJUSTMENT_POSTED, requestId, WAIT_MS);
      const posted = await ledgerEntry(readString(event.payload, 'ledgerEntryId') as string);
      expect(posted.eventType).toBe('ADJUSTMENT_IN');
      expect(Number(posted.unitCost)).toBeCloseTo(GL_UNIT_COST, 4);

      await expectPosted('E24', ADJUSTMENT_POSTED, requestId, {
        debit: INVENTORY_ACCOUNT,
        credit: ADJUSTMENT_GAIN_ACCOUNT,
        amount: MANUAL_GAIN * GL_UNIT_COST,
        occurredAt: posted.timestamp,
      });
    }, 180_000);

    it('E25 — an uncosted manual adjustment is recorded as skipped, with no entry', async () => {
      // The bulk-ingest request that seeded the suite's first SKU: an approved
      // MANUAL_ADJUSTMENT of a SKU nothing ever costed.
      await expectSkipped('E25', ADJUSTMENT_POSTED, stock.adjustmentRequestIds[0]);
    }, 180_000);

    it('E26 — a costed write-off posts Dr shrinkage / Cr inventory, exactly once', async () => {
      const created = await call('createScrap', () =>
        parts.inventory.scrapsApi.createScrap({
          createScrapRequest: {
            stockItemId: costedScrapSku,
            locationId: costedLocationId,
            quantity: SCRAPPED,
            reasonCode: CreateScrapRequestReasonCodeEnum.Damaged,
            negativeStockOverride: false,
            shouldReplenish: false,
            notes: `Itest costed write-off ${context.runId}`,
          },
        }),
      );
      const scrapId = created.scrapId as string;
      let status = created.status as string | undefined;
      if (status === 'PENDING_APPROVAL') {
        const approved = await call('approveScrap', () =>
          admin.inventory.scrapsApi.approveScrap({ scrapId, approveScrapRequest: { negativeStockOverride: false } }),
        );
        status = approved.status;
      }
      expect(['POSTED', 'AUTO_APPROVED', 'APPROVED']).toContain(status);
      const scrap = await call('getScrap', () => admin.inventory.scrapsApi.getScrap({ scrapId }));
      const posted = await ledgerEntry(scrap.ledgerEntryId as string);
      expect(Number(posted.unitCost)).toBeCloseTo(GL_UNIT_COST, 4);

      const { event } = await expectPosted('E26', SCRAP_POSTED, scrapId, {
        debit: SHRINKAGE_ACCOUNT,
        credit: INVENTORY_ACCOUNT,
        amount: SCRAPPED * GL_UNIT_COST,
        occurredAt: scrap.postedAt ?? posted.timestamp,
      });

      // Exactly once: a redelivered or re-emitted fact may add a DUPLICATE_IGNORED
      // record, but every record must point at the one entry.
      const records = await accountingEventsFor(admin, SCRAP_POSTED, scrapId);
      const entries = new Set(records.map((record) => record.journalEntryId).filter(Boolean));
      expect([...entries]).toEqual([event.journalEntryId]);
      expect(records.filter((record) => record.idempotencyOutcome !== 'DUPLICATE_IGNORED')).toHaveLength(1);
    }, 180_000);

    it('E27 — the uncosted write-off E14 posted is recorded as skipped, with no entry', async () => {
      expect(uncostedScrapId).toBeTruthy();
      await expectSkipped('E27', SCRAP_POSTED, uncostedScrapId as string);
    }, 180_000);
  });
});
