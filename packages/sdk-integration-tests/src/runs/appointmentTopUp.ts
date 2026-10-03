/**
 * Appointment top-up — keeps every site's next few weeks booked, and turns the
 * appointments that arrived yesterday into estimates.
 *
 * Alpha's appointments come from the accelerated-year run and end with it, so
 * the capacity calendar and schedule views go blank looking forward. Each run:
 *
 *   1. Arrivals. Every live appointment on yesterday's schedule at each site is
 *      bridged to an estimate (`createEstimateFromAppointment`), as a service
 *      advisor would on check-in. The bridge is idempotent on the appointment
 *      id, so a re-run, or a day the run did not book, is safe.
 *   2. Bookings. For each open day from tomorrow out to the horizon, the run
 *      tops the site's bay time up to a target share (`appointmentPlan.ts`),
 *      booking only windows `searchOpenings` reports as bookable — the backend's
 *      own hours, buffers, bay eligibility and rostering — on the bay the
 *      opening names, so every booking lands in that bay's `occupiedMinutes`
 *      and the next run sees it.
 *
 * Each booking gets a new customer and vehicle, created the way the floor load
 * creates its own. `APPT_MAX_PER_RUN` bounds how many one run can create.
 *
 * A populate run, not a test: asserts nothing, is not a `*.itest.ts`, and tags
 * what it writes with its own `appt-*` run id.
 *
 *   npm run populate:appointments
 *
 * Knobs (environment): APPT_HORIZON_DAYS (default 14, at most 42),
 * APPT_TARGET_UTILIZATION (0.35), APPT_JOB_MINUTES (60), APPT_MAX_PER_DAY (6),
 * APPT_MAX_PER_RUN (60). Same ITEST_* environment and build prerequisites as
 * `populate:shop-floor`.
 */
import { randomUUID } from 'node:crypto';
import { SeederRandom } from '@durion-sdk/seeder';
import { AppointmentCreateRequestResourceTypeEnum as AppointmentResource } from '@durion-sdk/shop-manager';
import { assertNonAcceleratedBackend } from '../harness/acceleratedClock';
import { holdEnvironmentLock } from '../harness/environmentLock';
import { createPersonAccount, createVehicle, readString, seedFromRunId, type BuilderContext } from '../harness/builders';
import { call, formatError, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadEnvFile } from '../harness/loadEnvFile';
import { Personas, type DomainClients } from '../harness/personas';
import { createStarterActivationPort, StarterActivation } from '../harness/StarterActivation';
import { createTenantPort, TenantPreflight } from '../harness/TenantPreflight';
import { pickOpenings, planShortfalls, type BookingTargets } from './appointmentPlan';
import { resolveService } from './shopFloorLoad';

const TAG = '[appt]';
const log = (message: string): void => console.log(`${TAG} ${message}`);
const DAY = 86_400_000;

/** Refusals about the *slot*, answered by trying the next opening (as Suite A and the accelerated port do). */
const SLOT_REFUSALS = ['already booked', 'FACILITY_CLOSED', 'OUTSIDE_OPERATING_HOURS', 'CONFLICT'];

const numberEnv = (name: string, fallback: number, min: number, max: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

interface Settings extends BookingTargets {
  horizonDays: number;
  maxPerRun: number;
}

const settingsFromEnv = (): Settings => ({
  horizonDays: Math.floor(numberEnv('APPT_HORIZON_DAYS', 14, 1, 42)),
  utilization: numberEnv('APPT_TARGET_UTILIZATION', 0.35, 0, 1),
  jobMinutes: Math.floor(numberEnv('APPT_JOB_MINUTES', 60, 15, 480)),
  maxPerDay: Math.floor(numberEnv('APPT_MAX_PER_DAY', 6, 0, 50)),
  maxPerRun: Math.floor(numberEnv('APPT_MAX_PER_RUN', 60, 0, 500)),
});

interface Crew {
  admin: DomainClients;
  advisor: DomainClients;
  manager: DomainClients;
}

interface Totals {
  converted: number;
  booked: number;
  refused: number;
  failed: number;
}

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  if (envFile.file !== null) {
    log(`loaded ${envFile.applied.length} vars from ${envFile.file}`);
  }

  const config = ItestConfig.fromEnv();
  // Alpha stays on the accelerated profile after a run converges; wall time is all this needs.
  await assertNonAcceleratedBackend(config.baseUrl, { allowConverged: true });

  const settings = settingsFromEnv();
  const runId = `appt-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  log(
    `runId=${runId} tenant=${config.tenant.slug} horizon=${settings.horizonDays}d ` +
      `target=${Math.round(settings.utilization * 100)}% job=${settings.jobMinutes}m ` +
      `maxPerDay=${settings.maxPerDay} maxPerRun=${settings.maxPerRun}`,
  );

  // Held for the whole run, shared with the accelerated year: see environmentLock.ts.
  holdEnvironmentLock(runId);

  const activation = new StarterActivation(config, createStarterActivationPort(config));
  if (activation.applies) {
    const { activated } = await activation.run();
    log(`starter activation: ${activated.join(', ') || 'none'}`);
  }
  const bound = await new TenantPreflight(config, createTenantPort(config)).run();
  log(`tenant binding verified: ${bound.join(', ')}`);

  const personas = new Personas(config);
  await personas.login();
  const crew: Crew = { admin: personas.as('admin'), advisor: personas.as('advisor'), manager: personas.as('manager') };

  const service = await resolveService(crew.admin);
  const locations = await call('listLocations', () => crew.admin.location.locationApi.listLocations());
  log(`${locations.length} location(s) found`);

  const now = new Date();
  const totals: Totals = { converted: 0, booked: 0, refused: 0, failed: 0 };
  for (const location of locations) {
    const locationId = location.id;
    const code = location.code ?? locationId ?? '(unknown)';
    if (!locationId) {
      continue;
    }
    const ctx: BuilderContext = {
      runId,
      random: new SeederRandom(seedFromRunId(`${runId}:${code}`)),
      refs: {
        locationId,
        bayIds: [],
        employees: { technicians: [], serviceWriters: [], manager: '', partsClerk: '' },
        serviceEntityIds: [service.id],
        productEntityIds: [],
        serviceNameById: new Map([[service.id, service.name]]),
        productNameById: new Map(),
        employeeNameById: new Map(),
      },
    };

    totals.converted += await convertArrivals(crew, ctx, code, service, now);
    if (totals.booked < settings.maxPerRun) {
      await bookAhead(crew, ctx, code, service, settings, now, totals);
    }
  }

  log('--- summary ---');
  log(
    `converted ${totals.converted} arrival(s) to estimates; booked ${totals.booked} appointment(s), ` +
      `${totals.refused} slot(s) refused, ${totals.failed} failure(s)`,
  );
  if (totals.failed > 0) {
    process.exitCode = 1;
  }
}

/** Yesterday's live appointments at one site, bridged to estimates. Returns how many. */
async function convertArrivals(
  crew: Crew,
  ctx: BuilderContext,
  code: string,
  service: { id: string; name: string },
  now: Date,
): Promise<number> {
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY);
  let schedule;
  try {
    schedule = await crew.advisor.shopManager.scheduleApi.viewSchedule({
      locationId: ctx.refs.locationId,
      date: yesterday,
    });
  } catch (error) {
    log(`${code}: arrivals skipped — schedule unavailable: ${await formatError(error)}`);
    return 0;
  }

  const appointmentIds = new Set(
    (schedule.resources ?? [])
      .flatMap((resource) => resource.events ?? [])
      .filter((event) => String(event.eventType).toUpperCase().includes('APPOINTMENT'))
      .map((event) => event.eventId),
  );

  let converted = 0;
  for (const appointmentId of appointmentIds) {
    try {
      const appointment = await crew.advisor.shopManager.appointmentsApi.getAppointmentById({ appointmentId });
      if (String(appointment.status).toUpperCase().includes('CANCEL')) continue;
      const created = await call(`createEstimateFromAppointment ${appointmentId}`, () =>
        crew.advisor.workorder.estimatesFromAppointmentsApi.createEstimateFromAppointment({
          createEstimateFromAppointmentRequest: {
            idempotencyKey: randomUUID(),
            appointmentId,
            customerId: appointment.crmCustomerId,
            vehicleId: appointment.crmVehicleId,
            locationId: ctx.refs.locationId,
            requestedServices: [service.name],
          },
        }),
      );
      if (readString(created, 'estimateId', 'id')) converted += 1;
    } catch (error) {
      log(`${code}: appointment ${appointmentId} not converted: ${await formatError(error)}`);
    }
  }
  if (appointmentIds.size > 0) {
    log(`${code}: ${converted} of ${appointmentIds.size} arrival(s) on ${yesterday.toISOString().slice(0, 10)} now have estimates`);
  }
  return converted;
}

/** Top one site's upcoming open days up to the target share of bay time. */
async function bookAhead(
  crew: Crew,
  ctx: BuilderContext,
  code: string,
  service: { id: string; name: string },
  settings: Settings,
  now: Date,
  totals: Totals,
): Promise<void> {
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY);
  const last = new Date(tomorrow.getTime() + (settings.horizonDays - 1) * DAY);

  let capacity;
  try {
    capacity = await crew.manager.shopManager.scheduleApi.getScheduleCapacity({
      locationId: ctx.refs.locationId,
      from: tomorrow,
      to: last,
    });
  } catch (error) {
    log(`${code}: bookings skipped — capacity unavailable: ${await formatError(error)}`);
    return;
  }

  const shortfalls = planShortfalls(capacity.days ?? [], settings);
  if (shortfalls.length === 0) {
    log(`${code}: every open day in the next ${settings.horizonDays} is at or above target`);
    return;
  }

  for (const shortfall of shortfalls) {
    const budget = Math.min(shortfall.jobs, settings.maxPerRun - totals.booked);
    if (budget <= 0) {
      log(`${code}: run cap of ${settings.maxPerRun} booking(s) reached`);
      return;
    }

    let openings;
    try {
      openings = await crew.advisor.shopManager.scheduleApi.searchOpenings({
        locationId: ctx.refs.locationId,
        serviceIds: [service.id],
        durationMinutes: settings.jobMinutes,
        earliestStart: new Date(Math.max(shortfall.dayStartAt.getTime(), now.getTime())),
        horizonDays: 1,
        limit: 50,
      });
    } catch (error) {
      log(`${code} ${shortfall.date}: no search: ${await formatError(error)}`);
      continue;
    }

    // Twice the budget, so a refused slot has a spare to fall back on.
    const candidates = pickOpenings(openings.openings ?? [], shortfall.date, budget * 2);
    let bookedToday = 0;
    for (const opening of candidates) {
      if (bookedToday >= budget) break;
      const outcome = await book(crew, ctx, service, opening);
      if (outcome === 'booked') {
        bookedToday += 1;
        totals.booked += 1;
      } else if (outcome === 'refused') {
        totals.refused += 1;
      } else {
        totals.failed += 1;
      }
    }
    log(
      `${code} ${shortfall.date}: booked ${bookedToday} of ${shortfall.jobs} wanted ` +
        `(${shortfall.bookedMinutes}/${shortfall.capacityMinutes} bay-min booked before)` +
        (candidates.length === 0 ? ` — no openings: ${openings.noOpeningReason ?? 'none returned'}` : ''),
    );
  }
}

/**
 * A customer created for a booking whose slot was then refused, kept for the
 * next attempt so a refusal does not leave an unused customer behind.
 */
let spareCustomer: { partyId: string; vehicleId: string } | undefined;

async function book(
  crew: Crew,
  ctx: BuilderContext,
  service: { id: string; name: string },
  opening: { bayId: string; startAt: Date; endAt: Date },
): Promise<'booked' | 'refused' | 'failed'> {
  try {
    if (!spareCustomer) {
      const created = await createPersonAccount(crew.advisor, ctx);
      // Vehicle registration is ADMIN-only, the same split Suite A makes.
      spareCustomer = { partyId: created.partyId, vehicleId: await createVehicle(crew.admin, ctx, created.partyId) };
    }
    const customer = spareCustomer;
    const vehicleId = customer.vehicleId;
    await retryWhileReplicating(
      () =>
        crew.advisor.shopManager.appointmentsApi.createAppointment({
          appointmentCreateRequest: {
            crmCustomerId: customer.partyId,
            crmVehicleId: vehicleId,
            locationId: ctx.refs.locationId,
            startAt: opening.startAt,
            endAt: opening.endAt,
            resourceType: AppointmentResource.Bay,
            resourceId: opening.bayId,
            serviceRequestIds: [service.id],
          },
        }),
      {
        markers: ['CUSTOMER_NOT_FOUND', 'VEHICLE_NOT_FOUND'],
        description: `booking an appointment for party ${customer.partyId}`,
        timeoutMs: 60_000,
      },
    );
    spareCustomer = undefined;
    return 'booked';
  } catch (error) {
    const detail = await formatError(error);
    if (SLOT_REFUSALS.some((marker) => detail.includes(marker))) {
      return 'refused';
    }
    log(`  booking ${opening.bayId} ${opening.startAt.toISOString()} failed: ${detail}`);
    return 'failed';
  }
}

// Guarded so the module can be imported by a test without executing a run.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`${TAG} FATAL`, error);
    process.exit(1);
  });
}
