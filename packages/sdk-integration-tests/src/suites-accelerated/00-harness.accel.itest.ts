import { SeederRandom } from '@durion-sdk/seeder';
import { AcceleratedConfig } from '../harness/acceleratedConfig';
import { loadAcceleratedContext, type AcceleratedContext } from '../harness/acceleratedContext';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas } from '../harness/personas';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';

/**
 * ACCELERATED COPY of ../suites/00-harness.itest.ts, with the clock, calendar and
 * feasibility plumbing added.
 *
 * Runs first (`jest.accelerated.sequencer.js`, `maxWorkers: 1`) and is the fastest way
 * to find out that an accelerated run is pointed at the wrong backend, anchored to
 * the wrong year, or moving at a scale the shop cannot work in — before
 * `z-year-volume` spends hours discovering the same thing.
 */
describe('accelerated harness', () => {
  let context: ItestContext;
  let accel: AcceleratedFixture;
  let accelContext: AcceleratedContext;
  let personas: Personas;
  let config: ItestConfig;

  beforeAll(async () => {
    context = loadContext();
    accel = await acceleratedFixture();
    accelContext = loadAcceleratedContext();
    config = ItestConfig.fromEnv();
    personas = new Personas(config);
    await personas.login();
  }, 180_000);

  it('rehydrates the bootstrap reference data', () => {
    // The runId namespace differs from the non-accelerated suites' `itest-`, which
    // is what keeps a year of accelerated records separable from an interaction run.
    expect(context.runId).toMatch(/^accel-\d+-[a-z0-9]+$/);
    expect(context.referenceCache.locationId).not.toHaveLength(0);
    expect(context.referenceCache.serviceEntityIds.length).toBeGreaterThan(0);
    expect(context.referenceCache.productEntityIds.length).toBeGreaterThan(0);
    expect(context.referenceCache.employees.technicians.length).toBeGreaterThan(0);
  });

  it('authenticates every persona and can call the backend as each', async () => {
    const random = new SeederRandom(1422);
    void random; // deterministic data source, shared pattern for the other suites

    for (const persona of ['admin', 'advisor', 'tech', 'manager', 'parts', 'acct', 'controller'] as const) {
      const clients = personas.as(persona);
      expect(clients.username).not.toHaveLength(0);
      expect(clients.auth.getToken()).not.toHaveLength(0);
      // A token is not proof of the right tenant: ask what this one is bound to.
      const tenant = await clients.security.tenantAPIApi.getMyTenant();
      expect({ slug: tenant.slug, id: tenant.id.toLowerCase() }).toEqual(config.tenant);
    }
  });

  it('reports the run mode it will test under', () => {
    expect(['single-credential', 'role']).toContain(context.mode);
    if (context.mode === 'single-credential') {
      console.log('[accel] single-credential mode: role-enforcement tests will be skipped');
    }
  });

  it('is talking to an accelerated backend anchored a year in the past', async () => {
    const reading = await accel.clock.read();

    expect(reading.accelerated).toBe(true);
    expect(reading.scale).toBeGreaterThan(1);
    // The whole point of the deployment: a year of history to fill in.
    const gapDays = (reading.realStart.getTime() - reading.virtualStart.getTime()) / 86_400_000;
    expect(gapDays).toBeGreaterThanOrEqual(360);
    expect(reading.virtualTime.getTime()).toBeGreaterThanOrEqual(reading.virtualStart.getTime());
    console.log(
      `[accel] virtual ${reading.virtualTime.toISOString()} at scale ${reading.scale}; ` +
        `anchors ${reading.virtualStart.toISOString()} → ${reading.realStart.toISOString()}; ` +
        `converged=${reading.converged}`,
    );
  });

  it('has not already spent the year it was deployed to cover', async () => {
    // Once the clock converges on wall time every further write is dated today, so
    // a converged clock at the start means the deployment needs fresh anchors.
    expect((await accel.clock.read()).converged).toBe(false);
  });

  it('agrees with global setup about the timeline', async () => {
    const reading = await accel.clock.read();
    // Two runs against the same realStart are the same year; a mismatch here means
    // the backend was redeployed underneath this run.
    expect(reading.realStart.toISOString()).toBe(accelContext.clock.realStart);
    expect(reading.scale).toBe(accelContext.clock.scale);
  });

  it('moves: the virtual clock is measurably faster than the wall clock', async () => {
    const first = await accel.clock.read();
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const second = await accel.clock.read();

    const realMs = Date.now() - startedAt;
    const virtualMs = second.virtualTime.getTime() - first.virtualTime.getTime();
    const observedScale = virtualMs / realMs;
    console.log(`[accel] observed scale ≈ ${observedScale.toFixed(0)} against a reported ${first.scale}`);

    expect(virtualMs).toBeGreaterThan(realMs);
    // Generous bounds: this is one sample over one real second, so it is checking
    // that the clock is accelerating roughly as advertised, not measuring it.
    expect(observedScale).toBeGreaterThan(first.scale / 10);
  }, 60_000);

  it('found the run feasible before it started writing', () => {
    const { feasibility } = accelContext;
    console.log(
      `[accel] ${feasibility.openRealSeconds.toFixed(1)}s real per open window, ` +
        `${feasibility.openWindowsPerJob} window(s) per job, ${feasibility.jobsPerDay} job(s)/day, ` +
        `expecting ~${feasibility.expectedWorkorders}`,
    );
    expect(feasibility.ok).toBe(true);
    expect(feasibility.jobsPerDay).toBeGreaterThanOrEqual(1);
    expect(feasibility.expectedWorkorders).toBeGreaterThanOrEqual(1);
  });

  it('has a shop calendar that opens, closes, and keeps mobile units working', async () => {
    const at = await accel.now();
    const calendar = accel.calendar;

    // Whatever day the clock is on, the calendar must be able to name the next time
    // a bay may work — and it must be a day the shop opens, inside its hours.
    const open = calendar.nextOpen(at, 'BAY');
    expect(calendar.isWorkingDay(open)).toBe(true);
    expect(calendar.isOpen(open, 'BAY')).toBe(true);
    expect(open.getTime()).toBeGreaterThanOrEqual(at.getTime());

    // A mobile unit is never waiting for the shop to open.
    expect(calendar.isOpen(at, 'MOBILE_UNIT')).toBe(true);
    expect(calendar.nextOpen(at, 'MOBILE_UNIT').getTime()).toBe(at.getTime());

    console.log(
      `[accel] virtual ${at.toISOString()}: bay ${calendar.isOpen(at, 'BAY') ? 'open' : 'closed'}, ` +
        `next bay window ${open.toISOString()}`,
    );
  });

  it('published its hours to the sites it will work, or said why not', () => {
    const accelConfig = AcceleratedConfig.fromEnv();
    if (accelConfig.publishCalendar) {
      // Operating hours cannot be read back — LocationResponseDTO carries none —
      // so publishing them is the only way the backend's own refusals and this
      // run's gate can agree.
      expect(accelContext.calendarPublishedTo.length).toBeGreaterThan(0);
      console.log(`[accel] hours published to ${accelContext.calendarPublishedTo.length} site(s)`);
    } else {
      expect(accelContext.calendarPublishedTo).toEqual([]);
      console.log('[accel] ITEST_ACCEL_PUBLISH_CALENDAR=false — the suites gate themselves only');
    }
  });

  it('waits in virtual time, and the wait costs far less real time', async () => {
    const before = await accel.now();
    const landed = await accel.elapseVirtual(60);

    const virtualMinutes = (landed.getTime() - before.getTime()) / 60_000;
    expect(virtualMinutes).toBeGreaterThanOrEqual(60);
    console.log(`[accel] waited out ${virtualMinutes.toFixed(1)} virtual minute(s)`);
  }, 120_000);
});
