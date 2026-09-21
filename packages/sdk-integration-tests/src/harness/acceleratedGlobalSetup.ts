// Imported by path, not by package name, for the same reason globalSetup.ts is:
// Jest applies moduleNameMapper to the suites but NOT to globalSetup, so
// '@durion-sdk/seeder' here would resolve through node_modules to
// packages/sdk-seeder/dist — whatever was last built — and the fixtures would
// silently run stale bootstrap code while the suites run current sources.
import {
  BootstrapOrchestrator,
  SecurityBootstrap,
  SeederAuth,
  SeederConfig,
  type ReferenceCache,
} from '../../../sdk-seeder/src/lib';
import { AcceleratedConfig, assessFeasibility, type LatencyMeasurement } from './acceleratedConfig';
import { AcceleratedJournal } from './acceleratedJournal';
import { AcceleratedLock } from './acceleratedLock';
import { saveAcceleratedContext } from './acceleratedContext';
import { AcceleratedRoleWindows, createRoleWindowPort } from './acceleratedRoleWindows';
import {
  AcceleratedStaffingWindows,
  createStaffingWindowPort,
} from './acceleratedStaffingWindows';
import { ItestConfig } from './ItestConfig';
import { saveContext } from './ItestContext';
import { loadEnvFile } from './loadEnvFile';
import { createPersonaPorts, PersonaBootstrap } from './PersonaBootstrap';
import { createStarterActivationPort, StarterActivation } from './StarterActivation';
import { createTenantPort, TenantPreflight } from './TenantPreflight';
import { assertAcceleratedBackend } from './virtualClock';

/**
 * Runs once, before any accelerated suite.
 *
 * Everything the non-accelerated globalSetup does — config, security bootstrap,
 * starter activation, tenant preflight, persona preflight, reference bootstrap —
 * plus the five things only an accelerated run needs:
 *
 *  1. the *inverse* clock guard: this backend must be accelerated, anchored a
 *     year back, and still accelerating;
 *  2. the personas' role windows back-dated to the virtual anchor, because a
 *     role granted in wall time has not started yet on this clock;
 *  3. the shop calendar published to every site the run will touch, because
 *     operating hours cannot be read back from the API and an unpublished
 *     calendar means the backend and the tests disagree about when work is legal;
 *  4. a feasibility check, measured rather than assumed, so a six-hour run that
 *     could only ever write two invoices is refused in the first minute;
 *  5. the run journal, so an interrupted year resumes instead of restarting.
 */
export default async function acceleratedGlobalSetup(): Promise<void> {
  const envFile = loadEnvFile();
  if (envFile.file !== null) {
    const detail = envFile.skipped.length > 0 ? ` (shell overrides: ${envFile.skipped.join(', ')})` : '';
    console.log(`[accel] loaded ${envFile.applied.length} vars from ${envFile.file}${detail}`);
  }

  const config = ItestConfig.fromEnv();
  const accel = AcceleratedConfig.fromEnv();

  // The guard first: every stage below writes, and none of it should happen
  // against a backend on the normal clock.
  const clock = await stage('accelerated clock check', () =>
    assertAcceleratedBackend(config.baseUrl, {
      maxSkewMs: accel.maxSkewMs,
      }),
  );
  console.log(
    `[accel] clock: virtual ${clock.virtualTime.toISOString()} at scale ${clock.scale} ${clock.zone}; ` +
      `anchors ${clock.virtualStart.toISOString()} → ${clock.realStart.toISOString()}`,
  );

  // One accelerated run at a time. Taken as early as the timeline is known and
  // before anything is written, so a second run fails on the lock rather than
  // halfway through someone else's year. Released on exit, SIGINT and SIGTERM by
  // the lock itself.
  const lockRunId = `accel-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  const lock = new AcceleratedLock(accel.lockPath, { runId: lockRunId, realStart: clock.realStart });
  lock.acquire();
  console.log(`[accel] holding ${accel.lockPath}`);
  if (accel.lockUri) {
    // Not enforced here: a lock file cannot see another machine. Logged so the run
    // record says which advisory object the operator was meant to be holding.
    console.log(`[accel] advisory lock for this environment: ${accel.lockUri} (held by the workflow, not this process)`);
  }

  const adminConfig = SeederConfig.fromValues({
    baseUrl: config.baseUrl,
    securityServiceUrl: config.securityServiceUrl,
    username: config.admin.username,
    password: config.admin.password,
    seed: config.seed,
    tenantSlug: config.tenant.slug,
    tenantId: config.tenant.id,
  });

  console.log(`[accel] mode=${config.mode} tenant=${config.tenant.slug} baseUrl=${config.baseUrl}`);

  await stage('security bootstrap', () => new SecurityBootstrap(adminConfig).run());

  // Before starter activation, which logs every persona in: roles granted in
  // wall time start in this backend's future, and login refuses an account
  // with no role in effect (403 USER_HAS_NO_ROLES).
  const { bridged } = await stage('persona role windows', () =>
    new AcceleratedRoleWindows(config, createRoleWindowPort(config)).run(clock.virtualStart),
  );
  for (const line of bridged) {
    console.log(`[accel] role window back-dated: ${line}`);
  }

  const activation = new StarterActivation(config, createStarterActivationPort(config));
  if (activation.applies) {
    const { activated, alreadyActive } = await stage('starter activation', () => activation.run());
    console.log(
      `[accel] starter activation: activated ${activated.join(', ') || 'none'}; ` +
        `already active ${alreadyActive.join(', ') || 'none'}`,
    );
  }

  const bound = await stage('tenant preflight', () =>
    new TenantPreflight(config, createTenantPort(config)).run(),
  );
  console.log(`[accel] tenant binding verified: ${bound.join(', ')}`);

  const auth = new SeederAuth(adminConfig);
  await stage('admin login', () => auth.login());

  const personaBootstrap = new PersonaBootstrap(config, ...personaPortsFor(auth, config.tenant.slug));
  if (personaBootstrap.applies) {
    const { verified, assignments } = await stage('persona preflight', () =>
      personaBootstrap.verifyAndProvision(),
    );
    console.log(`[accel] personas verified: ${verified.join(', ')}`);
    for (const assignment of assignments) {
      console.log(`[accel] role assigned: ${assignment}`);
    }
  }

  const refs = await stage('reference bootstrap', () => new BootstrapOrchestrator(adminConfig, auth).run());

  // After the bootstrap, because these are the assignments it just made or
  // found, and before any booking: pos-shop-manager decides a mechanic is
  // present by asking whether an ACTIVE staffing assignment covers the booked
  // date, and one written in wall time covers nothing in this backend's virtual
  // year (durion-positivity-backend#2140).
  const { createPeopleClient } = await import('@durion-sdk/people');
  const { backdated, unreadable } = await stage('staffing windows', () =>
    new AcceleratedStaffingWindows(
      createStaffingWindowPort(createPeopleClient(auth.buildSdkConfig('people'))),
    ).run(everyEmployee(refs), clock.virtualStart),
  );
  for (const line of backdated) {
    console.log(`[accel] staffing window back-dated: ${line}`);
  }
  for (const line of unreadable) {
    console.log(`[accel] staffing window unread: ${line}`);
  }

  if (personaBootstrap.applies) {
    const { links, limitations } = await stage('persona person-links', () =>
      personaBootstrap.linkPersons(refs.employees),
    );
    for (const link of links) {
      console.log(`[accel] linked ${link}`);
    }
    for (const limitation of limitations) {
      console.log(`[accel] role-mode limitation: ${limitation}`);
    }
  }

  // The virtual span this run will cover, which decides the default holiday set.
  const virtualEnd = new Date(clock.virtualTime.getTime() + accel.days * 86_400_000);
  const calendar = accel.calendarFor(clock.virtualStart, virtualEnd);

  // Publish the hours. `LocationResponseDTO` returns no operatingHours,
  // holidayClosures or timezone — they are write-only on patchLocation — so this
  // is the only way the backend's own scheduling refusals can agree with the gate
  // the suites apply. Without it the suites still gate themselves, and say so.
  const calendarPublishedTo: string[] = [];
  if (accel.publishCalendar) {
    const published = await stage('publish shop calendar', () =>
      publishCalendar(auth, accel, calendar, { from: clock.virtualTime, to: virtualEnd }),
    );
    calendarPublishedTo.push(...published);
    console.log(`[accel] published operating hours and closures to ${published.length} site(s)`);
  } else {
    console.log(
      '[accel] ITEST_ACCEL_PUBLISH_CALENDAR=false — the suites gate themselves, but the backend was not ' +
        'told the hours, so its own scheduling refusals may disagree with them',
    );
  }

  // Feasibility, measured. The warm-up figure is deliberately pessimistic: it is
  // the first lifecycle of the run, against cold caches and cold replicas.
  const latency = await stage('measure lifecycle latency', () => measureLatency(config.baseUrl));
  const openDays = calendar.countOpenDays(clock.virtualTime, virtualEnd);
  const sampledOpenDays = Math.floor(openDays / accel.sampleEvery);
  const feasibility = assessFeasibility({
    scale: clock.scale,
    shortestOpenMinutes: calendar.shortestOpenMinutes(),
    graceMinutes: accel.graceMinutes,
    latency,
    concurrency: accel.concurrency,
    sampledOpenDays,
  });

  console.log(
    `[accel] feasibility: ${feasibility.openRealSeconds.toFixed(1)}s of real time per open window, ` +
      `${feasibility.openWindowsPerJob} window(s) per job, ${feasibility.jobsPerDay} job(s)/day across ` +
      `${sampledOpenDays} worked open day(s) — expecting ~${feasibility.expectedWorkorders} workorder(s), ` +
      `floor ${accel.minWorkordersOverride ?? feasibility.minWorkorders}`,
  );
  if (!feasibility.ok) {
    // Released here as well as on exit: a refused run should not leave the
    // environment locked while the operator works out which scale to redeploy at.
    lock.release();
    throw new Error(
      `[accel] this run cannot produce a usable year: ${feasibility.reason}\n` +
        'Nothing has been written beyond the idempotent bootstrap. See README, "Accelerated year run".',
    );
  }

  // The journal decides the runId: a resumed year keeps the original, so its
  // records stay one retrievable set.
  const proposedRunId = `accel-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  const { journal, resumed, replacedRunId } = AcceleratedJournal.open(accel.journalPath, {
    runId: proposedRunId,
    realStart: clock.realStart,
    virtualStart: clock.virtualStart,
    scale: clock.scale,
  });
  journal.flush();
  if (resumed) {
    const totals = journal.totals();
    console.log(
      `[accel] resuming run ${journal.runId} from ${accel.journalPath}: ${journal.lastDayNumber()} day(s) done, ` +
        `${totals.workorders} workorder(s), ${totals.paid} paid invoice(s)`,
    );
  } else if (replacedRunId) {
    // Said out loud, because the alternative was a run that silently wore a spent
    // identity and collided with the records the previous attempt left behind.
    console.log(
      `[accel] the journal at ${accel.journalPath} recorded nothing under ${replacedRunId}, so this run keeps ` +
        `its own id ${journal.runId} rather than inheriting one whose fixtures may already exist`,
    );
  }

  const contextFile = saveContext({ runId: journal.runId, mode: config.mode, referenceCache: refs });
  const accelFile = saveAcceleratedContext({
    clock: {
      virtualTime: clock.virtualTime.toISOString(),
      realStart: clock.realStart.toISOString(),
      virtualStart: clock.virtualStart.toISOString(),
      scale: clock.scale,
      zone: clock.zone,
    },
    feasibility,
    journalPath: accel.journalPath,
    calendarPublishedTo,
    resumed,
  });
  console.log(`[accel] runId=${journal.runId} context=${contextFile} accel=${accelFile}`);
}

/**
 * Writes the run's hours and closures onto every site, and returns the ids it
 * reached.
 *
 * `patchLocation` is a partial update, so only the scheduling fields move; the
 * address, the type and the name are left alone. A site that refuses the patch is
 * reported and skipped rather than failing setup: a location-scoped grant that
 * does not cover every site is a configuration the run can still work around,
 * since the suites gate themselves regardless.
 *
 * The timezone goes with the hours, and has to. pos-shop-manager evaluates a
 * booking in **facility-local** time (DECISION-015): it reads the location
 * replica's timezone, converts the requested instant into it, and compares the
 * result against these `openTime`/`closeTime` strings. Publishing 08:00-18:00
 * without saying which 08:00 leaves them meaning whatever zone the site already
 * carried — on alpha, an Eastern one, which made a 09:00 UTC booking land at
 * 04:00 local and come back as OUTSIDE_OPERATING_HOURS with a time the caller
 * never sent. ShopCalendar does its arithmetic in UTC because the accelerated
 * clock contract fixes `pos.time.accelerated.zone=UTC`, so UTC is what the sites
 * this run drives are told to keep, and the two sides then agree.
 */
/**
 * The zone the published hours are written in, and the zone the sites are set to.
 *
 * Not configurable: `ShopCalendar` is pure UTC arithmetic by deliberate choice —
 * a local zone would introduce DST transitions the accelerated clock does not
 * have — so anything else here would put the gate and the backend's own refusals
 * back out of step.
 */
const CALENDAR_ZONE = 'UTC';

async function publishCalendar(
  auth: SeederAuth,
  accel: AcceleratedConfig,
  calendar: ReturnType<AcceleratedConfig['calendarFor']>,
  span: { from: Date; to: Date },
): Promise<string[]> {
  const { createLocationClient } = await import('@durion-sdk/location');
  const client = createLocationClient(auth.buildSdkConfig('location'));

  const hhmm = (minutes: number): string =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

  const operatingHours = [
    ...['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((dayOfWeek) => ({
      dayOfWeek,
      openTime: hhmm(accel.weekdayWindow.openMinutes),
      closeTime: hhmm(accel.weekdayWindow.closeMinutes),
    })),
    ...(accel.saturdayWindow
      ? [
          {
            dayOfWeek: 'SATURDAY',
            openTime: hhmm(accel.saturdayWindow.openMinutes),
            closeTime: hhmm(accel.saturdayWindow.closeMinutes),
          },
        ]
      : []),
    ...(accel.sundayWindow
      ? [
          {
            dayOfWeek: 'SUNDAY',
            openTime: hhmm(accel.sundayWindow.openMinutes),
            closeTime: hhmm(accel.sundayWindow.closeMinutes),
          },
        ]
      : []),
  ];

  const holidayClosures = calendar.closuresBetween(span.from, span.to);

  const locations = await client.locationApi.listLocations();
  const published: string[] = [];

  for (const location of locations) {
    if (!location.id) {
      continue;
    }
    try {
      await client.locationApi.patchLocation({
        locationId: location.id,
        locationPatchRequest: { operatingHours, holidayClosures, timezone: CALENDAR_ZONE },
      });
      published.push(location.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(
        `[accel] could not publish hours to ${location.code ?? location.id}: ${message} — ` +
          'the suites still gate themselves, but this site\'s own refusals may disagree',
      );
    }
  }
  return published;
}

/**
 * How long one gateway round trip takes, and what a whole lifecycle would cost.
 *
 * Measured from the cheapest authenticated-equivalent call available — the clock
 * endpoint — rather than by running a real job: a warm-up workorder would write a
 * record before the feasibility guard has decided whether the run should write
 * anything at all, which is exactly the outcome the guard exists to avoid. The
 * lifecycle estimate is that round trip multiplied by the call count of a job,
 * with a floor that keeps a suspiciously fast local stack honest.
 */
async function measureLatency(baseUrl: string): Promise<LatencyMeasurement> {
  const CALLS_PER_LIFECYCLE = 24;
  const samples: number[] = [];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = Date.now();
    await fetch(`${baseUrl}/system/time`);
    samples.push(Date.now() - startedAt);
  }
  samples.sort((a, b) => a - b);

  // The slowest sample, not the median: the guard is about whether work *fits*,
  // and a window sized on the median overruns half the time.
  const slowest = Math.max(samples[samples.length - 1], 50);
  // Cross-service replication waits dominate a real lifecycle and a clock read
  // cannot see them, so the estimate is deliberately multiplied up rather than
  // taken at face value.
  const stepLatencyMs = slowest * 3;
  return {
    stepLatencyMs,
    jobLatencyMs: stepLatencyMs * CALLS_PER_LIFECYCLE,
    steps: CALLS_PER_LIFECYCLE,
  };
}

/** Spreads into the PersonaBootstrap constructor's (security, people) pair. */
function personaPortsFor(auth: SeederAuth, tenantSlug: string | undefined): [
  ReturnType<typeof createPersonaPorts>['security'],
  ReturnType<typeof createPersonaPorts>['people'],
] {
  const ports = createPersonaPorts(auth, tenantSlug);
  return [ports.security, ports.people];
}

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[accel] global setup failed during ${name}: ${message}${await describeResponse(error)}`);
  }
}

/**
 * Every seeded employee, once each.
 *
 * All of them rather than the technicians alone: the presence check is about
 * technicians, but a service writer or a parts clerk whose assignment starts in
 * the virtual future is the same latent refusal on whatever reads staffing next,
 * and the pass costs one listing per person.
 */
function everyEmployee(refs: ReferenceCache): string[] {
  return [
    ...new Set(
      [
        ...refs.employees.technicians,
        ...refs.employees.serviceWriters,
        refs.employees.manager,
        refs.employees.partsClerk,
      ].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}

async function describeResponse(error: unknown): Promise<string> {
  const response = (error as { response?: Response } | undefined)?.response;
  if (!response || typeof response.status !== 'number') {
    return '';
  }
  let body = '';
  try {
    body = (await response.clone().text()).slice(0, 300);
  } catch {
    body = '(unreadable body)';
  }
  return ` [${response.status} ${response.url}${body ? ` - ${body}` : ''}]`;
}
