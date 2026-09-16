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
 * BACKEND_INTERACTION_TEST_SPEC.md) and the workspace packages built with the
 * root `npm run build`, which compiles them in dependency order, since it
 * resolves `@durion-sdk/*` through node_modules like the seeder does.
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
import { call, formatError, httpStatusOf, retryWhileReplicating } from '../harness/http';
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
import { buildRoster, type StaffingView } from './shopFloorRoster';

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
 * to a workorder, the manager's approval of that workorder, then the
 * technician, then the position, then the start.
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
  // the workorder it left behind, and so the catch knows how far it got.
  let workorderId: string | undefined;
  let technicianAssigned = false;
  let positionAssigned = false;
  try {
    const customer = await createPersonAccount(as.advisor, ctx);
    const vehicleId = await createVehicle(as.admin, ctx, customer.partyId);
    const estimateId = await createDraftEstimate(as.advisor, ctx, customer.partyId, vehicleId);
    await addLaborLine(as.advisor, ctx, estimateId, serviceEntityId, LABOR_PRICE);
    const promoted = await approveAndPromote(as.advisor, ctx, estimateId, customer);
    workorderId = promoted.workorderId;

    // Promotion leaves the workorder DRAFT, and a technician can only be
    // assigned to an APPROVED one: the manager approves it first, as suites C, F
    // and H do.
    await call('approveWorkorder', () =>
      as.manager.workorder.workOrderAPIApi.approveWorkorder({
        workorderId: promoted.workorderId,
        approveWorkorderRequest: {
          customerId: customer.partyId,
          signatureData: ctx.random.base64(32),
          signerName: customer.fullName,
          signatureMimeType: 'image/png',
          notes: `Shop floor load approval [${ctx.runId}]`,
        },
      }),
    );

    await call('assignTechnician', () =>
      as.manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId: promoted.workorderId,
        assignTechnicianRequest: {
          technicianId: job.technicianId,
          notes: `Shop floor load [${ctx.runId}]`,
        },
      }),
    );
    technicianAssigned = true;

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
    positionAssigned = true;

    // Starting is the last step and the only one allowed to be refused.
    // `startWorkorder` acts as the calling persona, and in role mode that is
    // the single configured technician login rather than whichever technician
    // this job was assigned to, so workexec answers 401/403. That refusal is
    // not a failed job: the workorder is built, staffed and on the position,
    // which is what occupies the board — it reads ASSIGNED instead of
    // WORK_IN_PROGRESS.
    //
    // Only that refusal. A 5xx, a transport error or an unexpected 400/409 is a
    // real failure, and swallowing it would report a success whose start
    // outcome nobody checked.
    try {
      await as.tech.workorder.operationalContextApi.startWorkorder({
        workorderId: promoted.workorderId,
      });
      log(`working  ${label} — workorder ${promoted.workorderId}, technician ${job.technicianId}`);
      return { ...base, state: 'working', workorderId: promoted.workorderId };
    } catch (error) {
      const status = httpStatusOf(error);
      const detail = await formatError(error);
      if (status !== 401 && status !== 403) {
        log(`FAILED ${label}: startWorkorder failed with ${status ?? 'no HTTP status'}: ${detail}`);
        return { ...base, state: 'failed', workorderId: promoted.workorderId, detail };
      }
      log(`assigned ${label} — workorder ${promoted.workorderId} placed, start refused (${status}): ${detail}`);
      return { ...base, state: 'assigned', workorderId: promoted.workorderId, detail };
    }
  } catch (error) {
    const detail = await formatError(error);
    log(`FAILED ${label}: ${detail}`);
    if (workorderId !== undefined && technicianAssigned && !positionAssigned) {
      await releaseOrphanedTechnician(as.manager, workorderId, job.technicianId, label, ctx.runId);
    }
    return { ...base, state: 'failed', workorderId, detail };
  }
}

/**
 * Gives a technician back after the position they were assigned for could not
 * be taken.
 *
 * Without this the workorder holds the technician with nowhere to work, and the
 * next run's discovery reads their `assignedWorkorderId` and counts them busy —
 * so one transient placement failure permanently costs the roster a technician
 * until someone reconciles it by hand. Best-effort: if the release itself
 * fails, say so with both ids, because that is the state a human has to unpick.
 */
async function releaseOrphanedTechnician(
  manager: DomainClients,
  workorderId: string,
  technicianId: string,
  label: string,
  runId: string,
): Promise<void> {
  try {
    await manager.workorder.technicianAssignmentAPIApi.releaseTechnician({
      workorderId,
      reason: `Shop floor load: position could not be taken [${runId}]`,
    });
    log(`  released technician ${technicianId} from unplaced workorder ${workorderId} (${label})`);
  } catch (error) {
    log(
      `  WARNING: technician ${technicianId} is still assigned to unplaced workorder ${workorderId} ` +
        `(${label}) and could not be released: ${await formatError(error)}. ` +
        'The next run will count them busy until this is reconciled.',
    );
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

  // The board is aggregated for one date; the same one decides which PTO counts.
  const on = new Date();
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

    let staffing: StaffingView[];
    try {
      staffing = await admin.people.peopleAvailabilityApi.listPeopleAvailability({ locationId });
    } catch (error) {
      log(`${code}: skipped — staffing unavailable: ${await formatError(error)}`);
      continue;
    }

    const outcome = buildRoster({ locationId, code, name: location.name ?? code }, board, staffing, on);
    if (outcome.kind === 'skipped') {
      log(`${code}: skipped — ${outcome.reason}`);
      continue;
    }

    // A site with free positions but no idle technician is kept on purpose: it
    // plans no jobs, and its positions are exactly the ones the coverage report
    // has to name. Dropping it here would understate the shortfall.
    if (outcome.roster.freePositions.length === 0) {
      log(`${code}: skipped — every position is already working`);
      continue;
    }

    rosters.push(outcome.roster);
  }

  return rosters;
}

/**
 * A catalog service to hang the estimate's labor line on. Existing, like
 * everything else this run consumes — it seeds no catalog of its own.
 *
 * There is no "list all services" endpoint: `searchCatalogServices` is a
 * case-insensitive substring match whose contract returns an **empty list for a
 * blank or missing `q`**, not every service, and `listServicesByName` wants an
 * exact whole name (and deserializes its array into a single DTO, which is why
 * CatalogBootstrap avoids it). So the substring is probed: any service name is
 * near-certain to contain one of these letters, and the first probe normally
 * answers.
 */
const SERVICE_NAME_PROBES = ['e', 'a', 'i', 'o', 'r', 's'] as const;

async function resolveService(as: DomainClients): Promise<{ id: string; name: string }> {
  for (const q of SERVICE_NAME_PROBES) {
    const matches = await call(`searchCatalogServices(q=${q})`, () =>
      as.catalog.productsApi.searchCatalogServices({ q, limit: 50 }),
    );
    for (const service of Array.isArray(matches) ? matches : []) {
      const id = readString(service, 'id', 'serviceId', 'entityId');
      if (id) {
        const name = readString(service, 'name') ?? id;
        log(`labor line will use service ${name} (${id})`);
        return { id, name };
      }
    }
  }

  throw new Error(
    `${TAG} no catalog service matched any of "${SERVICE_NAME_PROBES.join('", "')}" — this run places ` +
      'work on existing services and seeds none. Load the catalog fixtures first.',
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

// Guarded so the module can be imported by a test without executing a run.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`${TAG} FATAL`, error);
    process.exit(1);
  });
}
