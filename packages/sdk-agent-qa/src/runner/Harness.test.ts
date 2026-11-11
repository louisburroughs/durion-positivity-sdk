import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModelPort } from '../agent/loop';
import { buildCatalog } from '../catalog/buildCatalog';
import { loadQaConfig, type QaConfig } from '../config';
import { buildDayPlan, type DayPlanOptions } from '../day/dayPlan';
import { SWEEP_SCENARIO_ID } from '../scenarios/library';
import { defineScenarios } from '../scenarios/types';
import { call, fakeBackend, invokerFor, ScriptedModel, type FakeBackend, type Route, type Script } from '../testing/fakes';
import { Harness, type BackendPort } from './Harness';
import type { ScenarioResult } from './runScenario';

const catalog = buildCatalog();

const SCENARIOS = defineScenarios([
  {
    id: 'morning',
    title: 'Morning',
    cadence: 'daily',
    at: '08:00',
    persona: 'manager',
    kind: 'operations',
    goal: 'List locations.',
    operations: ['location.LocationAPIApi.listLocations'],
    expect: [{ kind: 'call', operation: 'location.LocationAPIApi.listLocations', outcome: 'success' }],
  },
  {
    id: 'afternoon',
    title: 'Afternoon',
    cadence: 'daily',
    at: '14:00',
    persona: 'advisor',
    kind: 'operations',
    goal: 'List carts.',
    operations: ['order.SalesOrdersApi.listCarts'],
    expect: [{ kind: 'call', operation: 'order.SalesOrdersApi.listCarts' }],
  },
  {
    id: 'access-drill',
    title: 'Access drill',
    cadence: 'weekly',
    weekday: 2,
    at: '09:00',
    persona: 'tech',
    kind: 'error',
    requiresRoleMode: true,
    goal: 'Expect 403.',
    operations: ['security.UserAPIApi.listUsers'],
    expect: [{ kind: 'http', statuses: [403] }],
  },
]);

const MORNING: Script = [[call('location__LocationAPIApi__listLocations')], [call('finish', { verdict: 'completed', summary: 'ok' })]];

interface World {
  harness: Harness;
  backend: FakeBackend;
  config: QaConfig;
  stateDir: string;
  setTime(local: string): void;
  preflights: number;
  locks: string[];
}

/** `local` is shop time in March 2026 after the 8th (UTC-4). The 10th is a Tuesday. */
function world(options: { model?: ModelPort; route?: Route; env?: Record<string, string>; scenarios?: typeof SCENARIOS; preflight?: () => Promise<void> } = {}): World {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qa-harness-'));
  const backend = fakeBackend(options.route ?? ((request) => (request.method === 'GET' ? { status: 200, body: [] } : undefined)));
  const config = loadQaConfig({ QA_STATE_DIR: stateDir, QA_JITTER_MINUTES: '0', QA_MIN_GAP_MINUTES: '0', QA_SWEEP_MAX: '0', QA_VISITS_MAX: '0', ...options.env }, 'http://gateway.test');
  let now = new Date('2026-03-10T10:00:00-04:00');
  const self: World = {
    backend,
    config,
    stateDir,
    preflights: 0,
    locks: [],
    setTime: (local) => {
      now = new Date(`${local.replace(' ', 'T')}:00-04:00`);
    },
    harness: undefined as unknown as Harness,
  };
  const port: BackendPort = {
    roleMode: false,
    personas: ['admin', 'advisor', 'tech', 'manager'],
    tenantSlug: 'alpha',
    preflight:
      options.preflight ??
      (async () => {
        self.preflights += 1;
      }),
    holdEnvironmentLock: (runId) => {
      self.locks.push(`hold ${runId}`);
      return { release: () => self.locks.push('release') };
    },
  };
  self.harness = new Harness({
    config: { ...config, baseUrlFor: (pkg) => (pkg === 'internal' || pkg === 'documents' ? undefined : `http://gateway.test/${pkg}`) },
    catalog,
    invoker: invokerFor(backend),
    backend: port,
    model: options.model ?? new ScriptedModel(MORNING),
    scenarios: options.scenarios ?? SCENARIOS,
    log: () => undefined,
    now: () => now,
  });
  return self;
}

const dayFiles = (state: World, date = '2026-03-10'): string[] => fs.readdirSync(path.join(state.stateDir, 'runs', date)).sort();

describe('Harness.tick', () => {
  it('runs a scenario when its time comes, once, and writes the evidence', async () => {
    const state = world();
    state.setTime('2026-03-10 07:30');
    await expect(state.harness.tick()).resolves.toMatchObject({ status: 'idle', results: [] });

    state.setTime('2026-03-10 08:05');
    const tick = await state.harness.tick();
    expect(tick.status).toBe('ran');
    expect(tick.results).toEqual([expect.objectContaining({ scenarioId: 'morning', verdict: 'passed', callsByStatus: { '200': 1 } })]);
    expect(state.backend.requests.map((request) => request.path)).toEqual(['/location/v1/locations']);
    expect(state.backend.requests[0].headers.get('Authorization')).toBe('Bearer token-manager');
    expect(state.locks).toEqual([expect.stringMatching(/^hold qa-2026-03-10-/), 'release']);

    expect(dayFiles(state)).toEqual(['1205-morning.json', '1205-morning.transcript.jsonl', 'calls.jsonl', 'report.md']);
    const report = fs.readFileSync(state.harness.reportPath(), 'utf8');
    expect(report).toMatch(/1 scenarios: 1 passed/);
    expect(report).toMatch(/\| location \| yes \| 1\/\d+ \|/);

    state.setTime('2026-03-10 08:20');
    await expect(state.harness.tick()).resolves.toMatchObject({ status: 'idle' });
    expect(state.backend.requests).toHaveLength(1);
  });

  it('runs one due scenario per pass and leaves the rest due, daily work first', async () => {
    const state = world({ model: new ScriptedModel([[call('finish', { verdict: 'blocked', summary: 'nothing to do' })]]), env: { QA_MAX_LATENESS_MINUTES: '600' } });
    state.setTime('2026-03-10 15:00');
    const order: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const tick = await state.harness.tick();
      order.push(tick.results.map((result) => result.scenarioId).join(',') || tick.status);
    }
    expect(order).toEqual(['morning', 'afternoon', 'access-drill', 'idle']);
  });

  it('spaces scenarios by the minimum gap', async () => {
    const state = world({ env: { QA_MIN_GAP_MINUTES: '15', QA_MAX_LATENESS_MINUTES: '600' } });
    state.setTime('2026-03-10 14:30');
    expect((await state.harness.tick()).status).toBe('ran');
    state.setTime('2026-03-10 14:40');
    expect((await state.harness.tick()).status).toBe('spacing');
    state.setTime('2026-03-10 14:46');
    expect((await state.harness.tick()).status).toBe('ran');
  });

  it('skips, without calling anything, a scenario that needs per-persona logins it does not have', async () => {
    const state = world({ scenarios: defineScenarios([{ ...SCENARIOS[2] }]) });
    state.setTime('2026-03-10 09:30');
    const tick = await state.harness.tick();
    expect(tick.results).toEqual([expect.objectContaining({ scenarioId: 'access-drill', verdict: 'skipped' })]);
    expect(state.backend.requests).toEqual([]);
    expect((await state.harness.tick()).status).toBe('idle');
  });

  it('does nothing on a day the shop is closed', async () => {
    const state = world();
    state.setTime('2026-03-15 10:00'); // Sunday
    await expect(state.harness.tick()).resolves.toMatchObject({ status: 'closed' });
  });

  it('yields to another process that holds the run lock', async () => {
    const state = world();
    fs.writeFileSync(path.join(state.stateDir, 'run.lock'), JSON.stringify({ pid: process.ppid, startedAt: '2026-03-10T12:00:00Z' }));
    state.setTime('2026-03-10 08:05');
    await expect(state.harness.tick()).resolves.toMatchObject({ status: 'busy' });
    expect(state.backend.requests).toEqual([]);
  });

  it('leaves a scenario due when the backend did not answer, so it is retried', async () => {
    const state = world();
    state.backend.fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const harness = new Harness({
      config: state.config,
      catalog,
      invoker: invokerFor(state.backend),
      backend: { roleMode: false, personas: ['manager'], tenantSlug: 'alpha', preflight: async () => undefined, holdEnvironmentLock: () => ({ release: () => undefined }) },
      model: new ScriptedModel(MORNING),
      scenarios: SCENARIOS,
      log: () => undefined,
      now: () => new Date('2026-03-10T08:05:00-04:00'),
    });
    const tick = await harness.tick();
    expect(tick.results).toEqual([expect.objectContaining({ scenarioId: 'morning', verdict: 'infra' })]);
    expect(harness.plan().slots.find((slot) => slot.scenario.id === 'morning')?.status).toBe('due');
  });

  it('releases the run lock and reports the error when the preflight refuses the backend', async () => {
    const state = world({
      preflight: async () => {
        throw new Error('the backend is running the accelerated clock profile');
      },
    });
    state.setTime('2026-03-10 08:05');
    await expect(state.harness.tick()).rejects.toThrow(/accelerated clock/);
    expect(fs.existsSync(path.join(state.stateDir, 'run.lock'))).toBe(false);
    expect(state.backend.requests).toEqual([]);
  });

  it('fails a scenario on a 5xx and puts the correlation id in the report', async () => {
    const state = world({ route: () => ({ status: 500, body: { code: 'INTERNAL_ERROR' } }) });
    state.setTime('2026-03-10 08:05');
    const [result] = (await state.harness.tick()).results;
    expect(result).toMatchObject({ verdict: 'failed', serverErrors: [expect.objectContaining({ operationId: 'location.LocationAPIApi.listLocations', status: 500 })] });
    const report = fs.readFileSync(state.harness.reportPath(), 'utf8');
    expect(report).toMatch(/## Server errors and undecodable responses/);
    expect(report).toContain(`X-Correlation-Id \`${state.backend.requests[0].headers.get('X-Correlation-Id')}\``);
  });
});

describe('monthly coverage', () => {
  const sweepOnly = { scenarios: defineScenarios([]), env: { QA_SWEEP_MAX: '20', QA_MAX_LATENESS_MINUTES: '600' } };

  it('hands the sweep the packages the month has not reached, as direct tools', async () => {
    const model = new ScriptedModel([[call('finish', { verdict: 'blocked', summary: 'stopping' })]]);
    const state = world({ ...sweepOnly, model });
    state.setTime('2026-03-10 16:30');
    const [result] = (await state.harness.tick()).results;
    expect(result.scenarioId).toBe(SWEEP_SCENARIO_ID);
    const offered = model.requests[0].tools.map((tool) => tool.name).filter((name) => name.includes('__'));
    // 23 routed packages uncovered, 19 open days left in March from the 10th: two a day.
    expect(offered).toHaveLength(2);
    expect(new Set(offered.map((name) => name.split('__')[0])).size).toBe(2);
  });

  it('covers every routed package by month end even if no model ever answers', async () => {
    const state = world({ ...sweepOnly, model: new ScriptedModel([new Error('every configured model failed')]) });
    state.setTime('2026-03-27 16:30'); // inside the last five open days
    const [result] = (await state.harness.tick()).results;
    expect(result.loop?.status).toBe('model-error');

    const summary = state.harness.coverageSummary();
    expect(summary.missing).toEqual([]);
    expect(summary.unitsCalled).toBe(catalog.packages.length - 2);
    const calls = fs.readFileSync(path.join(state.stateDir, 'runs', '2026-03-27', 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.every((entry) => entry.source === 'backstop' && entry.httpMethod === 'GET')).toBe(true);
    expect(state.backend.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('does not use the backstop early in the month', async () => {
    const state = world({ ...sweepOnly, model: new ScriptedModel([new Error('down')]) });
    state.setTime('2026-03-10 16:30');
    await state.harness.tick();
    expect(state.backend.requests).toEqual([]);
    expect(state.harness.coverageSummary().unitsCalled).toBe(0);
  });

  it('has nothing to sweep once the month is covered', async () => {
    const state = world({ ...sweepOnly, model: new ScriptedModel([new Error('down')]) });
    state.setTime('2026-03-27 16:30');
    await state.harness.tick();
    const before = state.backend.requests.length;
    state.setTime('2026-03-28 16:30');
    const tick = await state.harness.tick();
    expect(tick).toMatchObject({ status: 'ran', results: [] });
    expect(state.backend.requests).toHaveLength(before);
  });
});

describe('a customer visit', () => {
  const DAY: DayPlanOptions = { visitsMin: 1, visitsMax: 1, newCustomerRatio: 0, commercialRatio: 0, newVehicleRatio: 0, openTime: '08:00', closeTime: '17:30', seed: 0 };
  /** A seed whose single visit on the 10th is a service job with the given outcome. */
  const seedFor = (disposition: string): number => {
    for (let seed = 0; seed < 500; seed += 1) {
      const [visit] = buildDayPlan('2026-03-10', { ...DAY, seed }).visits;
      if (visit.kind === 'service' && visit.disposition === disposition && visit.arrival === 'walk-in') {
        return seed;
      }
    }
    throw new Error(`no seed gives a ${disposition} service visit`);
  };
  const env = (seed: number): Record<string, string> => ({
    QA_VISITS_MIN: '1',
    QA_VISITS_MAX: '1',
    QA_NEW_CUSTOMER_RATIO: '0',
    QA_COMMERCIAL_RATIO: '0',
    QA_NEW_VEHICLE_RATIO: '0',
    QA_SEED: String(seed),
    QA_MAX_LATENESS_MINUTES: '900',
  });
  const route: Route = (request) => {
    if (request.method === 'POST' && request.path.endsWith('/estimates')) {
      return { status: 201, body: { id: 'est-1', status: 'DRAFT' } };
    }
    if (request.method === 'POST' && request.path.endsWith('/promote')) {
      return { status: 200, body: { id: 'wo-1', status: 'APPROVED' } };
    }
    return request.method === 'GET' ? { status: 200, body: {} } : { status: 200, body: {} };
  };
  const ESTIMATE = {
    operationId: 'workorder.EstimateAPIApi.createEstimate',
    input: { createEstimateRequest: { customerId: 'p-1', vehicleId: 'v-1', crmPartyId: 'p-1', crmVehicleId: 'v-1', crmContactIds: [], currencyUomId: 'USD', locationId: 'l-1' } },
  };
  const FINISH = [call('finish', { verdict: 'completed', summary: 'done' })];

  it('carries what the intake established to the stage that runs later, in another pass', async () => {
    const model = new ScriptedModel([
      [call('sdk_call', ESTIMATE)],
      [call('sdk_call', { operationId: 'workorder.EstimateAPIApi.promoteEstimate', input: { estimateId: 'est-1' } })],
      [call('remember', { key: 'customerName', value: 'Dana Ortiz' })],
      FINISH,
      FINISH,
    ]);
    const state = world({ model, route, scenarios: defineScenarios([]), env: env(seedFor('approves')) });
    state.setTime('2026-03-10 17:00');

    // Only the intake is due: the job cannot go on the floor before the customer has been seen.
    const dueVisitStages = (): string[] =>
      state.harness.plan().slots.filter((slot) => slot.status === 'due' && slot.scenario.id.startsWith('visit-')).map((slot) => slot.scenario.id);
    const nextResult = async (): Promise<ScenarioResult> => {
      for (let pass = 0; pass < 5; pass += 1) {
        const [result] = (await state.harness.tick()).results;
        if (result) {
          return result;
        }
      }
      throw new Error('nothing ran');
    };
    expect(dueVisitStages()).toEqual(['visit-01-intake']);
    const intake = await nextResult();
    expect(intake).toMatchObject({ scenarioId: 'visit-01-intake', persona: 'advisor', verdict: 'passed' });

    const saved = JSON.parse(fs.readFileSync(path.join(state.stateDir, 'runs', '2026-03-10', 'day-plan.json'), 'utf8'));
    expect(saved.memory['visit-01']).toEqual({ estimateId: 'est-1', workorderId: 'wo-1', customerName: 'Dana Ortiz' });

    const before = model.requests.length;
    expect(dueVisitStages()).toEqual(['visit-01-work']);
    const work = await nextResult();
    expect(work).toMatchObject({ scenarioId: 'visit-01-work', persona: 'manager' });
    const brief = model.requests[before].messages[0];
    expect(brief).toMatchObject({ role: 'user', content: expect.stringContaining('- workorderId: wo-1') });
    expect(brief).toMatchObject({ content: expect.stringContaining('- customerName: Dana Ortiz') });

    const report = fs.readFileSync(state.harness.reportPath(), 'utf8');
    expect(report).toMatch(/## Today's customers/);
    expect(report).toMatch(/1 visits: 0 new and 1 returning customers; 0 commercial and 1 individual\./);
    expect(report).toMatch(/intake: PASS · \d\d:\d\d work: /);
  });

  it('skips the work and the checkout when the intake produced no workorder', async () => {
    const model = new ScriptedModel([[call('finish', { verdict: 'blocked', summary: 'no customer found' })]]);
    const state = world({ model, route, scenarios: defineScenarios([]), env: env(seedFor('approves')) });
    state.setTime('2026-03-10 17:00');
    const verdicts: string[] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      for (const result of (await state.harness.tick()).results) {
        verdicts.push(`${result.scenarioId}: ${result.verdict}`);
      }
    }
    expect(verdicts).toEqual(['visit-01-intake: inconclusive', 'visit-01-work: skipped', 'visit-01-checkout: skipped']);
    expect(state.backend.requests).toEqual([]);
  });

  it('plans only the intake for a customer who declines', () => {
    const state = world({ scenarios: defineScenarios([]), env: env(seedFor('declines')) });
    state.setTime('2026-03-10 07:00');
    expect(state.harness.plan().slots.map((slot) => slot.scenario.id).filter((id) => id.startsWith('visit-'))).toEqual(['visit-01-intake']);
  });

  it('has no visits on a closed day', () => {
    const state = world({ scenarios: defineScenarios([]), env: env(0) });
    state.setTime('2026-03-15 10:00');
    expect(state.harness.plan().slots.filter((slot) => slot.scenario.id.startsWith('visit-'))).toEqual([]);
    expect(fs.existsSync(path.join(state.stateDir, 'runs', '2026-03-15'))).toBe(false);
  });
});
