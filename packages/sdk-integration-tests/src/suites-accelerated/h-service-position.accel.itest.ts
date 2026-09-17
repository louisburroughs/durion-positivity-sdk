/*
 * ACCELERATED COPY of ../suites/h-service-position.itest.ts (spec: Task A6).
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
import { AssignServicePositionRequestResourceTypeEnum as ResourceType } from '@durion-sdk/workorder';
import {
  addLaborLine,
  approveAndPromote,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  seedFromRunId,
  type BuilderContext,
  type CreatedCustomer,
} from '../harness/builders';
import {
  call,
  expectApiError,
  expectHttpError,
  formatError,
  retryWhileReplicating,
} from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';
import { Personas, type DomainClients } from '../harness/personas';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite H — where a workorder is worked, and who works it (backend #1983-#1985).
 *
 * A workorder's service position (a bay, a mobile unit, or HOLD at its own site)
 * and its technician are two independent assignments. A bay or mobile unit holds
 * at most one open workorder; HOLD holds any number; a workorder has at most one
 * current technician. Suite C covers the technician rule and "closing frees the
 * position" on its own lifecycle; this suite covers contention for a position.
 *
 * The bay and the mobile unit are created by this run. Every other position at
 * the site is shared with the seeder and earlier runs, and any of them may
 * already hold an open workorder, which would turn a contention test into a test
 * of someone else's data. Both are kept afterwards, run-tagged, like every
 * record a run creates. Three workorders are built: W1 takes the bay first, W2
 * contends for it, W3 parks. W1 ends the run open, with a technician and the bay,
 * the way an assigned job looks on the dispatch board.
 */
describe('Suite H — service position and technician assignment', () => {
  const LABOR_PRICE = 95;

  let context: ItestContext;
  let accel: AcceleratedFixture;
  let personas: Personas;
  let ctx: BuilderContext;
  let admin: DomainClients;
  let advisor: DomainClients;
  let manager: DomainClients;
  let tech: DomainClients;

  let siteId: string;
  let technicianId: string;
  /** Created in beforeAll and kept, run-tagged. */
  let bayId: string | undefined;
  /**
   * Created in beforeAll and kept, run-tagged. Left INACTIVE (the default):
   * an ACTIVE unit needs a travel buffer policy, capabilities and coverage rules,
   * none of which the one-open-workorder rule depends on.
   */
  let mobileUnitId: string | undefined;

  interface Built {
    workorderId: string;
    customer: CreatedCustomer;
  }
  let w1: Built;
  let w2: Built;
  let w3: Built;

  const buildWorkorder = async (label: string): Promise<Built> => {
    const customer = await createPersonAccount(advisor, ctx);
    const vehicleId = await createVehicle(admin, ctx, customer.partyId);
    const estimateId = await createDraftEstimate(advisor, ctx, customer.partyId, vehicleId);
    await addLaborLine(advisor, ctx, estimateId, context.referenceCache.serviceEntityIds[0], LABOR_PRICE);
    const { workorderId } = await approveAndPromote(advisor, ctx, estimateId, customer);
    console.log(`[H] ${label} = workorder ${workorderId}`);
    return { workorderId, customer };
  };

  const reason = (what: string) => `Integration test ${what} [${context.runId}]`;

  const assign = (workorderId: string, resourceType: ResourceType, resourceId?: string) =>
    manager.workorder.servicePositionAPIApi.assignServicePosition({
      workorderId,
      assignServicePositionRequest: { resourceType, resourceId, reason: reason(`place ${resourceType}`) },
    });

  const positionOf = (workorderId: string) =>
    call('getServicePosition', () => manager.workorder.servicePositionAPIApi.getServicePosition({ workorderId }));

  const workorderDetail = (workorderId: string) =>
    call('getWorkorderDetail', () => advisor.workorder.workorderDetailApi.getWorkorderDetail({ workorderId }));

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
    advisor = personas.as('advisor');
    manager = personas.as('manager');
    tech = personas.as('tech');
    ctx = {
      runId: context.runId,
      random: new SeederRandom(seedFromRunId(`${context.runId}:h-service-position`)),
      refs: context.referenceCache,
    };
    siteId = context.referenceCache.locationId;
    technicianId = context.referenceCache.employees.technicians[0];

    const bay = await call('createBay', () =>
      admin.location.bayApi.createBay({
        locationId: siteId,
        bayRequest: {
          name: `Itest bay ${context.runId}`,
          bayType: 'GENERAL_SERVICE',
          capacity: { maxConcurrentVehicles: 1 },
        },
      }),
    );
    bayId = bay.id;
    console.log(`[H] created bay ${bayId} at site ${siteId}`);

    const unit = await call('createMobileUnit', () =>
      admin.location.mobileUnitApi.createMobileUnit({
        mobileUnitRequest: { name: `Itest unit ${context.runId}`, baseLocationId: siteId },
      }),
    );
    mobileUnitId = unit.id;
    console.log(`[H] created mobile unit ${mobileUnitId} (${unit.status}) based at site ${siteId}`);

    w1 = await buildWorkorder('W1');
    w2 = await buildWorkorder('W2');
    w3 = await buildWorkorder('W3');
  }, 480_000);

  beforeEach(async () => {
    await personas.refreshIfNeeded();
  });

  afterAll(async () => {
    if (!manager) {
      return;
    }
    // W2 and W3 are left unplaced. W1 is not released: H10 leaves it on the run's
    // own bay, which nothing else contends for. The bay and unit themselves are
    // kept: alpha is append-only and a run's records are its trace (spec:
    // persistence contract).
    for (const built of [w2, w3]) {
      if (!built) continue;
      try {
        await manager.workorder.servicePositionAPIApi.releaseServicePosition({
          workorderId: built.workorderId,
          reason: reason('cleanup'),
        });
      } catch (error) {
        console.log(`[H] cleanup: could not release ${built.workorderId}: ${await formatError(error)}`);
      }
    }
  }, 120_000);

  it('H1 — the manager places W1 on the run\'s bay', async () => {
    // pos-workorder validates the bay against its Kafka-fed ext_bay replica, so
    // a bay created seconds ago can still be unknown there.
    const placed = await retryWhileReplicating(() => assign(w1.workorderId, ResourceType.Bay, bayId), {
      markers: ['Unknown bay'],
      description: 'assignServicePosition W1 -> bay',
      timeoutMs: 60_000,
      pollMs: 1_000,
    });
    console.log(`[H1] W1 placed on ${placed.resourceType} ${placed.resourceId}`);
    expect(placed.resourceType).toBe('BAY');
    expect(placed.resourceId).toBe(bayId);

    const read = await positionOf(w1.workorderId);
    expect(read.resourceId).toBe(bayId);
    expect(read.history?.find((row) => row.current)?.resourceId).toBe(bayId);
  }, 120_000);

  it('H2 — a bay holds one open workorder: W2 is refused, naming W1', async () => {
    const refused = await expectApiError(assign(w2.workorderId, ResourceType.Bay, bayId), 409, 'RESOURCE_OCCUPIED');
    console.log(`[H2] bay refused for W2, occupied by ${refused.referenceId}`);
    expect(refused.referenceId).toBe(w1.workorderId);
    expect((await positionOf(w2.workorderId)).resourceId).toBeUndefined();
  }, 120_000);

  it('H3 — HOLD has no capacity: W2 and W3 both park at their own site', async () => {
    for (const built of [w2, w3]) {
      const parked = await call('assignServicePosition HOLD', () => assign(built.workorderId, ResourceType.Hold));
      // HOLD is the workorder's own site; no id is sent and the site is what comes back.
      expect(parked.resourceType).toBe('HOLD');
      expect(parked.resourceId).toBe(siteId);
    }
  }, 120_000);

  it('H4 — a HOLD naming another real site is refused, and the workorder stays parked', async () => {
    // A real location, not a random id: a backend that accepted any existing site
    // as a HOLD would still pass against an id that exists nowhere.
    const locations = await call('listLocations', () => admin.location.locationApi.listLocations());
    const otherSite = locations.find((location) => location.id !== siteId);
    if (!otherSite) {
      throw new Error(`H4 needs a location other than the suite site ${siteId}; listLocations returned ${locations.length}`);
    }

    const refused = await expectApiError(
      assign(w3.workorderId, ResourceType.Hold, otherSite.id),
      422,
      'SERVICE_POSITION_INVALID',
    );
    console.log(`[H4] HOLD at ${otherSite.name} (${otherSite.id}) refused: ${refused.message}`);

    const after = await positionOf(w3.workorderId);
    expect(after.resourceType).toBe('HOLD');
    expect(after.resourceId).toBe(siteId);
  }, 120_000);

  it('H5 — position and technician are independent: changing one leaves the other', async () => {
    // Technician assignment needs an approved workorder; position assignment does not.
    await call('approveWorkorder W1', () =>
      manager.workorder.workOrderAPIApi.approveWorkorder({
        workorderId: w1.workorderId,
        approveWorkorderRequest: {
          customerId: w1.customer.partyId,
          signatureData: ctx.random.base64(32),
          signerName: w1.customer.fullName,
          signatureMimeType: 'image/png',
          notes: reason('approval'),
        },
      }),
    );
    await call('assignTechnician W1', () =>
      manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId: w1.workorderId,
        assignTechnicianRequest: { technicianId, notes: reason('assignment') },
      }),
    );

    // Moving W1 off the bay keeps its technician...
    const moved = await call('assignServicePosition W1 -> HOLD', () => assign(w1.workorderId, ResourceType.Hold));
    expect(moved.resourceType).toBe('HOLD');
    expect(moved.technicianId).toBe(technicianId);

    // ...and releasing the technician keeps the position.
    await call('releaseTechnician W1', () =>
      manager.workorder.technicianAssignmentAPIApi.releaseTechnician({
        workorderId: w1.workorderId,
        reason: reason('technician release'),
      }),
    );
    const after = await positionOf(w1.workorderId);
    // Status is logged, not asserted: releasing the last technician leaves W1
    // ASSIGNED today, and the backend is to revert it to APPROVED.
    const status = (await workorderDetail(w1.workorderId)).status;
    console.log(
      `[H5] W1 after technician release: ${after.resourceType}, technician ${after.technicianId ?? 'none'}, status ${status}`,
    );
    expect(after.resourceType).toBe('HOLD');
    expect(after.technicianId).toBeUndefined();
  }, 120_000);

  it('H6 — once W1 has left the bay, W2 can take it', async () => {
    const placed = await call('assignServicePosition W2 -> bay', () => assign(w2.workorderId, ResourceType.Bay, bayId));
    expect(placed.resourceType).toBe('BAY');
    expect(placed.resourceId).toBe(bayId);
  }, 120_000);

  it('H7 — releasing leaves W2 unplaced, and the claim stays in history', async () => {
    const released = await call('releaseServicePosition W2', () =>
      manager.workorder.servicePositionAPIApi.releaseServicePosition({
        workorderId: w2.workorderId,
        reason: reason('release'),
      }),
    );
    expect(released.resourceType).toBeUndefined();

    const history = (await positionOf(w2.workorderId)).history ?? [];
    console.log(`[H7] W2 history: ${history.map((row) => `${row.resourceType ?? 'none'}${row.releasedAt ? ' (released)' : ''}`).join(', ')}`);
    expect(history.some((row) => row.resourceId === bayId && row.releasedAt !== undefined)).toBe(true);
  }, 120_000);

  it('H8 — a mobile unit holds one open workorder too', async () => {
    // Like the bay, the unit reaches pos-workorder through a Kafka-fed replica.
    const placed = await retryWhileReplicating(
      () => assign(w3.workorderId, ResourceType.MobileUnit, mobileUnitId),
      {
        markers: ['Unknown mobile unit'],
        description: 'assignServicePosition W3 -> mobile unit',
        timeoutMs: 60_000,
        pollMs: 1_000,
      },
    );
    console.log(`[H8] W3 placed on ${placed.resourceType} ${placed.resourceId}`);
    expect(placed.resourceType).toBe('MOBILE_UNIT');
    expect(placed.resourceId).toBe(mobileUnitId);

    const refused = await expectApiError(
      assign(w1.workorderId, ResourceType.MobileUnit, mobileUnitId),
      409,
      'RESOURCE_OCCUPIED',
    );
    console.log(`[H8] mobile unit refused for W1, occupied by ${refused.referenceId}`);
    expect(refused.referenceId).toBe(w3.workorderId);

    await call('releaseServicePosition W3', () =>
      manager.workorder.servicePositionAPIApi.releaseServicePosition({
        workorderId: w3.workorderId,
        reason: reason('mobile unit release'),
      }),
    );
  }, 180_000);

  itInRoleMode('H9 — a technician cannot place a workorder', async () => {
    const status = await expectHttpError(
      tech.workorder.servicePositionAPIApi.assignServicePosition({
        workorderId: w3.workorderId,
        assignServicePositionRequest: { resourceType: ResourceType.Hold, reason: reason('refused placement') },
      }),
      401,
      403,
    );
    console.log(`[H9] TECHNICIAN refused workorder:operationalContext:override with HTTP ${status}`);
  }, 120_000);

  it('H10 — W1 is left open with a technician and the run\'s bay', async () => {
    // H7 freed the bay. Technician first, then the bay: ASSIGNED is to mean both,
    // so the order works whether the status follows the technician (today) or the
    // pair. Nothing releases W1 afterwards.
    await call('assignTechnician W1', () =>
      manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId: w1.workorderId,
        assignTechnicianRequest: { technicianId, notes: reason('final assignment') },
      }),
    );
    const placed = await call('assignServicePosition W1 -> bay', () => assign(w1.workorderId, ResourceType.Bay, bayId));
    expect(placed.resourceType).toBe('BAY');
    expect(placed.resourceId).toBe(bayId);
    expect(placed.technicianId).toBe(technicianId);

    const status = String((await workorderDetail(w1.workorderId)).status).toUpperCase();
    console.log(`[H10] W1 left on bay ${bayId} with technician ${technicianId}, status ${status}`);
    expect(status).toBe('ASSIGNED');
  }, 120_000);

  it('H11 — the position and the technician survive a virtual day boundary', async () => {
    // Accelerated-only (spec: Task A6). A bay held overnight is the normal state of
    // a car left in the shop, and it is the state the year run depends on: a
    // carried job keeps its bay and its mechanic across midnight, so nothing else
    // may be given them. On a normal clock this boundary never arrives inside a
    // test run.
    const before = await accel.now();
    const held = await call('getServicePosition W1 before midnight', () =>
      manager.workorder.servicePositionAPIApi.getServicePosition({ workorderId: w1.workorderId }),
    );
    expect(held.resourceId).toBe(bayId);

    const crossed = await accel.timer.waitForNextDay(before);
    console.log(
      `[H11] crossed ${before.toISOString().slice(0, 10)} -> ` +
        `${crossed.observed.virtualTime.toISOString().slice(0, 10)} in ${crossed.realElapsedMs}ms real ` +
        `(${crossed.polls} poll(s), scale ${crossed.observed.scale})`,
    );
    expect(crossed.observed.virtualTime.toISOString().slice(0, 10)).not.toBe(before.toISOString().slice(0, 10));

    const after = await call('getServicePosition W1 after midnight', () =>
      manager.workorder.servicePositionAPIApi.getServicePosition({ workorderId: w1.workorderId }),
    );
    expect(after.resourceType).toBe('BAY');
    expect(after.resourceId).toBe(bayId);
    expect(after.technicianId).toBe(technicianId);

    const stillAssigned = String((await workorderDetail(w1.workorderId)).status).toUpperCase();
    expect(stillAssigned).toBe('ASSIGNED');
  }, 300_000);
});
