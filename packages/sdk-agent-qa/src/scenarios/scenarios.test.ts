import { buildCatalog } from '../catalog/buildCatalog';
import { SCENARIOS, SWEEP_SCENARIO_ID } from './library';
import { defineScenarios, type ScenarioInput } from './types';

const catalog = buildCatalog();

describe('scenario library', () => {
  it('names only operations the generated clients have', () => {
    const unknown = SCENARIOS.flatMap((scenario) =>
      scenario.operations.filter((id) => !catalog.byId.has(id)).map((id) => `${scenario.id}: ${id}`),
    );
    expect(unknown).toEqual([]);
  });

  it('only expects calls to operations the scenario pins', () => {
    const unpinned = SCENARIOS.flatMap((scenario) =>
      scenario.expect
        .flatMap((expectation) => (expectation.kind === 'call' ? [expectation.operation] : expectation.kind === 'http' ? (expectation.operations ?? []) : []))
        .filter((id) => !scenario.operations.includes(id))
        .map((id) => `${scenario.id}: ${id}`),
    );
    expect(unpinned).toEqual([]);
  });

  it('covers a day, a week and a month, with error drills at every cadence', () => {
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      const set = SCENARIOS.filter((scenario) => scenario.cadence === cadence);
      expect(set.length).toBeGreaterThanOrEqual(8);
      expect(set.some((scenario) => scenario.kind === 'error')).toBe(true);
    }
    expect(SCENARIOS.map((scenario) => scenario.id)).not.toContain(SWEEP_SCENARIO_ID);
  });

  it('by itself reaches every package the gateway routes, before the sweep adds anything', () => {
    const pinned = new Set(SCENARIOS.flatMap((scenario) => scenario.operations.map((id) => id.split('.')[0])));
    const routed = catalog.packages.filter((pkg) => pkg !== 'internal' && pkg !== 'documents');
    expect(routed.filter((pkg) => !pinned.has(pkg))).toEqual([]);
  });

  it('pins a destructive operation only where that is the point of the scenario', () => {
    const destructive = SCENARIOS.flatMap((scenario) =>
      scenario.operations.filter((id) => catalog.byId.get(id)?.risk === 'destructive').map((id) => `${scenario.id}: ${id}`),
    );
    expect(destructive).toEqual(['monthly-period-close: accounting.AccountingPeriodsApi.closeAccountingPeriod']);
  });

  it('keeps each scenario small enough to hand to a model as direct tools', () => {
    for (const scenario of SCENARIOS) {
      expect([scenario.id, scenario.operations.length <= 16]).toEqual([scenario.id, true]);
    }
  });
});

describe('defineScenarios', () => {
  const base: ScenarioInput = { id: 'x', title: 'X', cadence: 'daily', at: '09:00', persona: 'advisor', kind: 'operations', goal: 'g', operations: [], expect: [] };

  it('requires a weekday for weekly and a day of the month for monthly scenarios', () => {
    expect(() => defineScenarios([{ ...base, cadence: 'weekly' }])).toThrow(/weekday/);
    expect(() => defineScenarios([{ ...base, cadence: 'monthly' }])).toThrow(/dayOfMonth/);
  });

  it('rejects duplicate ids, malformed times and days that not every month has', () => {
    expect(() => defineScenarios([base, base])).toThrow(/duplicate/);
    expect(() => defineScenarios([{ ...base, at: '9am' }])).toThrow();
    expect(() => defineScenarios([{ ...base, cadence: 'monthly', dayOfMonth: 31 }])).toThrow();
  });
});
