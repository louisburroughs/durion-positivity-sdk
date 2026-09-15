/**
 * Shop floor load — puts an active workorder on every free bay and mobile unit
 * it can staff, across every site that has them.
 *
 * A populate run, not a test: it asserts nothing and is deliberately NOT a
 * `*.itest.ts`, so `npm run test:integration` never picks it up and it never
 * shares a run id, a globalSetup or a fixture with the suites. Its records are
 * tagged with their own `floor-*` run id so a floor load is distinguishable
 * from suite data in any later query.
 *
 * It uses what is already there. Locations, bays, mobile units and technicians
 * are discovered, never created — the seeder's BootstrapOrchestrator is not run
 * here, and neither is the security bootstrap, because both write reference and
 * role data this run has no business changing. What it does create is the work:
 * a customer, a vehicle and an estimate per job, promoted to a workorder,
 * because a workorder cannot be placed on a bay without one.
 *
 *   npm run populate:shop-floor
 *
 * Needs the same ITEST_* environment as the suites (see
 * BACKEND_INTERACTION_TEST_SPEC.md) and the packages built (`npm run build`),
 * since it resolves `@durion-sdk/*` through node_modules like the seeder does.
 */
import { SeederRandom, type ReferenceCache } from '@durion-sdk/seeder';
import { AssignServicePositionRequestResourceTypeEnum as ResourceType } from '@durion-sdk/workorder';
import { assertNonAcceleratedBackend } from '../harness/acceleratedClock';
import {
  addLaborLine,
  approveAndPromote,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  readString,
  seedFromRunId,
  type BuilderContext,
} from '../harness/builders';
import { call, formatError, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadEnvFile } from '../harness/loadEnvFile';
import { Personas, type DomainClients } from '../harness/personas';
import { createStarterActivationPort, StarterActivation } from '../harness/StarterActivation';
import { createTenantPort, TenantPreflight } from '../harness/TenantPreflight';
import {
  formatCoverageReport,
  planFloor,
  type PlannedJob,
  type ShopPosition,
  type SiteRoster,
} from './shopFloorPlan';

const TAG = '[floor]';
const LABOR_PRICE = 95;

const log = (message: string): void => console.log(`${TAG} ${message}`);

/** What became of one planned job. `assigned` means placed but not started. */
type JobState = 'working' | 'assigned' | 'failed';

interface JobOutcome {
  siteCode: string;
  position: ShopPosition;
  technicianId: string;
  state: JobState;
  workorderId?: string;
  detail?: string;
}

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  if (envFile.file !== null) {
    log(`loaded ${envFile.applied.length} vars from ${envFile.file}`);
  }

  const config = ItestConfig.fromEnv();
  await assertNonAcceleratedBackend(config.baseUrl);

  // Its own namespace, distinct from the suites' `itest-*`: this is what makes
  // the run separable from every other test run in a later query.
  const runId = `floor-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  log(`runId=${runId} mode=${config.mode} tenant=${config.tenant.slug} baseUrl=${config.baseUrl}`);

  // Tenant-aware backends load accounts with a starter password login refuses
  // until it is exchanged, and a token bound to the wrong tenant would write
  // this floor into someone else's data while every call still succeeded.
  const activation = new StarterActivation(config, createStarterActivationPort(config));
  if (activation.applies) {
    const { activated } = await activation.run();
    log(`starter activation: ${activated.join(', ') || 'none'}`);
  }
  const bound = await new TenantPreflight(config, createTenantPort(config)).run();
  log(`tenant binding verified: ${bound.join(', ')}`);

  const personas = new Personas(config);
  await personas.login();
  const admin = personas.as('admin');
  const advisor = personas.as('advisor');
  const manager = personas.as('manager');
  const tech = personas.as('tech');

  const service = await resolveService(admin);
  const rosters = await discoverFloor(admin, manager);

  if (rosters.length === 0) {
    log('no site has both a service position and a technician — nothing to load');
    return;
  }

  const plan = planFloor(rosters);
  log('--- coverage ---');
  for (const line of formatCoverageReport(plan)) {
    log(line);
  }
  log('--- loading ---');

  const outcomes: JobOutcome[] = [];
  for (const sitePlan of plan.sites) {
    if (sitePlan.jobs.length === 0) {
      continue;
    }
    const ctx: BuilderContext = {
      runId,
      // Per site, so two sites in one run never draw the same generated person.
      random: new SeederRandom(seedFromRunId(`${runId}:${sitePlan.site.code}`)),
      refs: referenceCacheFor(sitePlan.site, service),
    };

    for (const job of sitePlan.jobs) {
      outcomes.push(
        await loadPosition({ advisor, admin, manager, tech }, ctx, sitePlan.site, job, service.id),
      );
    }
  }

  report(plan.totals.unstaffed, outcomes);

  if (outcomes.some((outcome) => outcome.state === 'failed')) {
    process.exitCode = 1;
  }
}

/**
 * Builds the one job: a customer, their vehicle, an approved estimate promoted
 * to a workorder, then the technician, then the position, then the start.
 *
 * The order is the backend's: a workorder needs both a technician and a
 * position before it will start (backend #2011), and placing it is what makes
 * the position read as occupied on the board.
 */
async function loadPosition(
  as: { advisor: DomainClients; admin: DomainClients; manager: DomainClients; tech: DomainClients },
  ctx: BuilderContext,
  site: SiteRoster,
  job: PlannedJob,
  serviceEntityId: string,
): Promise<JobOutcome> {
  const label = `${site.code} ${job.position.kind} ${job.position.name}`;
  const base: Omit<JobOutcome, 'state'> = {
    siteCode: site.code,
    position: job.position,
    technicianId: job.technicianId,
  };

  // Carried outside the try so a job that fails *after* promotion still reports
  // the workorder it left behind unplaced.
  let workorderId: string | undefined;
  try {
    const customer = await createPersonAccount(as.advisor, ctx);
    const vehicleId = await createVehicle(as.admin, ctx, customer.partyId);
    const estimateId = await createDraftEstimate(as.advisor, ctx, customer.partyId, vehicleId);
    await addLaborLine(as.advisor, ctx, estimateId, serviceEntityId, LABOR_PRICE);
    const promoted = await approveAndPromote(as.advisor, ctx, estimateId, customer);
    workorderId = promoted.workorderId;

    await call('assignTechnician', () =>
      as.manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId: promoted.workorderId,
        assignTechnicianRequest: {
          technicianId: job.technicianId,
          notes: `Shop floor load [${ctx.runId}]`,
        },
      }),
    );

    // pos-workorder validates the resource against its Kafka-fed replicas of
    // the location domain, so a bay or unit can still be unknown there.
    await retryWhileReplicating(
      () =>
        as.manager.workorder.servicePositionAPIApi.assignServicePosition({
          workorderId: promoted.workorderId,
          assignServicePositionRequest: {
            resourceType: job.position.kind === 'BAY' ? ResourceType.Bay : ResourceType.MobileUnit,
            resourceId: job.position.id,
            reason: `Shop floor load [${ctx.runId}]`,
          },
        }),
      {
        markers: ['Unknown bay', 'Unknown mobile unit'],
        description: `assignServicePosition -> ${job.position.kind}`,
        timeoutMs: 60_000,
        pollMs: 1_000,
      },
    );

    // Starting is the last step and the only optional one. `startWorkorder`
    // acts as the calling persona, and in role mode that is the single
    // configured technician login rather than whichever technician this job was
    // assigned to, so workexec can refuse it. A refusal is not a failed job:
    // the workorder is built, staffed and on the position, which is what
    // occupies the board — it reads ASSIGNED instead of WORK_IN_PROGRESS.
    try {
      await as.tech.workorder.operationalContextApi.startWorkorder({
        workorderId: promoted.workorderId,
      });
      log(`working  ${label} — workorder ${promoted.workorderId}, technician ${job.technicianId}`);
      return { ...base, state: 'working', workorderId: promoted.workorderId };
    } catch (error) {
      const detail = await formatError(error);
      log(`assigned ${label} — workorder ${promoted.workorderId} placed but not started: ${detail}`);
      return { ...base, state: 'assigned', workorderId: promoted.workorderId, detail };
    }
  } catch (error) {
    const detail = await formatError(error);
    log(`FAILED ${label}: ${detail}`);
    return { ...base, state: 'failed', workorderId, detail };
  }
}

/**
 * Every site that has at least one free position and one idle technician.
 *
 * The dispatch board is the source for positions: it lists every ACTIVE bay and
 * mobile unit at a location with the open workorder holding it, so "free" comes
 * from the same read the shop's own board uses, and an INACTIVE unit is absent
 * by that endpoint's own contract rather than by a filter here. Staffing is read
 * from people availability instead, which is the side that actually knows a
 * person's role; the board then says which of them are already on a job.
 */
async function discoverFloor(admin: DomainClients, manager: DomainClients): Promise<SiteRoster[]> {
  const locations = await call('listLocations', () => admin.location.locationApi.listLocations());
  log(`${locations.length} location(s) found`);

  const rosters: SiteRoster[] = [];
  for (const location of locations) {
    const locationId = location.id;
    const code = location.code ?? locationId ?? '(unknown)';
    if (!locationId) {
      continue;
    }

    let board;
    try {
      board = await manager.workorder.dailyDispatchBoardDashboardApi.getDispatchDashboard({ locationId });
    } catch (error) {
      log(`${code}: skipped — dispatch board unavailable: ${await formatError(error)}`);
      continue;
    }

    const positions: Array<{ position: ShopPosition; occupied: boolean }> = [
      ...(board.bays ?? []).map((bay) => ({
        position: { kind: 'BAY' as const, id: bay.bayId, name: bay.bayName ?? bay.bayId },
        occupied: bay.assignedWorkorderId != null || !bay.available,
      })),
      ...(board.mobileUnits ?? []).map((unit) => ({
        position: { kind: 'MOBILE_UNIT' as const, id: unit.unitId, name: unit.unitName ?? unit.unitId },
        occupied: unit.assignedWorkorderId != null || !unit.available,
      })),
    ];

    if (positions.length === 0) {
      log(`${code}: skipped — no bay or mobile unit`);
      continue;
    }

    const busyOnBoard = new Set(
      (board.mechanics ?? [])
        .filter((mechanic) => mechanic.assignedWorkorderId != null || mechanic.onBreak === true)
        .map((mechanic) => mechanic.personId),
    );

    let technicianIds: string[];
    try {
      const availability = await admin.people.peopleAvailabilityApi.listPeopleAvailability({ locationId });
      technicianIds = availability
        .filter((person) => person.assignmentStatus === 'ACTIVE' && person.role === 'TECHNICIAN')
        .map((person) => person.personId);
    } catch (error) {
      log(`${code}: skipped — staffing unavailable: ${await formatError(error)}`);
      continue;
    }

    const roster: SiteRoster = {
      locationId,
      code,
      name: location.name ?? code,
      freePositions: positions.filter((entry) => !entry.occupied).map((entry) => entry.position),
      occupiedPositions: positions.filter((entry) => entry.occupied).map((entry) => entry.position),
      idleTechnicianIds: technicianIds.filter((id) => !busyOnBoard.has(id)),
      busyTechnicianIds: technicianIds.filter((id) => busyOnBoard.has(id)),
    };

    if (roster.freePositions.length === 0) {
      log(`${code}: skipped — every position is already working`);
      continue;
    }
    if (roster.idleTechnicianIds.length === 0) {
      log(`${code}: skipped — no idle technician (${technicianIds.length} technician(s), all on a job)`);
      continue;
    }

    rosters.push(roster);
  }

  return rosters;
}

/**
 * A catalog service to hang the estimate's labor line on. Existing, like
 * everything else this run consumes — it seeds no catalog of its own.
 */
async function resolveService(as: DomainClients): Promise<{ id: string; name: string }> {
  const matches = await call('searchCatalogServices', () =>
    as.catalog.productsApi.searchCatalogServices({ limit: 50 }),
  );
  const list = Array.isArray(matches) ? matches : [];
  for (const service of list) {
    const id = readString(service, 'id', 'serviceId', 'entityId');
    if (id) {
      const name = readString(service, 'name') ?? id;
      log(`labor line will use service ${name} (${id})`);
      return { id, name };
    }
  }
  throw new Error(
    `${TAG} no catalog service found — this run places work on existing services and seeds none. ` +
      'Load the catalog fixtures first.',
  );
}

/**
 * The builders take a seeder ReferenceCache, which is shaped for the one site
 * the seeder bootstraps. This run spans sites, so each gets its own view: the
 * builders read `locationId` (the estimate's site) and `serviceNameById` (the
 * labor line's description), and nothing else on it is reachable from the
 * calls made here.
 */
function referenceCacheFor(site: SiteRoster, service: { id: string; name: string }): ReferenceCache {
  return {
    locationId: site.locationId,
    bayIds: site.freePositions.filter((p) => p.kind === 'BAY').map((p) => p.id),
    employees: {
      technicians: [...site.idleTechnicianIds, ...site.busyTechnicianIds],
      serviceWriters: [],
      manager: '',
      partsClerk: '',
    },
    serviceEntityIds: [service.id],
    productEntityIds: [],
    serviceNameById: new Map([[service.id, service.name]]),
    productNameById: new Map(),
    employeeNameById: new Map(),
  };
}

function report(unstaffed: number, outcomes: JobOutcome[]): void {
  const working = outcomes.filter((outcome) => outcome.state === 'working');
  const assigned = outcomes.filter((outcome) => outcome.state === 'assigned');
  const failed = outcomes.filter((outcome) => outcome.state === 'failed');

  log('--- summary ---');
  log(`${working.length} position(s) working, ${assigned.length} placed but not started, ${failed.length} failed`);
  for (const outcome of failed) {
    log(`  FAILED ${outcome.siteCode} ${outcome.position.kind} ${outcome.position.name}: ${outcome.detail}`);
  }
  if (unstaffed > 0) {
    log(
      `${unstaffed} free position(s) were left empty for want of a technician — see the coverage ` +
        'report above for which, and where.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(`${TAG} FATAL`, error);
  process.exit(1);
});
