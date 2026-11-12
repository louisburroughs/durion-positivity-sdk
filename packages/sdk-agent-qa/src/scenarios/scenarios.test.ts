import { buildCatalog } from '../catalog/buildCatalog';
import { buildDayPlan, type DayPlanOptions } from '../day/dayPlan';
import { stageScenario } from '../day/visitScenarios';
import { SCENARIOS, SWEEP_SCENARIO_ID } from './library';
import { defineScenarios, type ScenarioInput } from './types';

const catalog = buildCatalog();
const DAY: DayPlanOptions = {
  visitsMin: 10,
  visitsMax: 10,
  tenantMax: 1000,
  newCustomerRatio: 0.3,
  commercialRatio: 0.3,
  newVehicleRatio: 0.2,
  stockPartsRatio: 0.45,
  specialOrderRatio: 0.2,
  openTime: '08:00',
  closeTime: '17:30',
  seed: 0,
};

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
    // Daily holds only the staff routines; the day's customers are generated (day/dayPlan.ts).
    const minimum = { daily: 5, weekly: 8, monthly: 8 } as const;
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      const set = SCENARIOS.filter((scenario) => scenario.cadence === cadence);
      expect(set.length).toBeGreaterThanOrEqual(minimum[cadence]);
      expect(set.some((scenario) => scenario.kind === 'error')).toBe(true);
    }
    expect(SCENARIOS.map((scenario) => scenario.id)).not.toContain(SWEEP_SCENARIO_ID);
  });

  it('with a day of visits reaches every package the gateway routes, before the sweep adds anything', () => {
    const day = buildDayPlan('2026-03-10', [{ id: 'l-1', code: 'MAIN', name: 'Main Street', slug: 'main', positions: 6 }], DAY);
    const visitOperations = day.visits.flatMap((visit) =>
      visit.stages.flatMap((stage) => stageScenario(visit, stage, {}, { roleMode: false }).operations),
    );
    const pinned = new Set(
      [...SCENARIOS.flatMap((scenario) => scenario.operations), ...visitOperations].map((id) => id.split('.')[0]),
    );
    const routed = catalog.packages.filter((pkg) => pkg !== 'internal' && pkg !== 'documents');
    expect(routed.filter((pkg) => !pinned.has(pkg))).toEqual([]);
  });

  it('runs at every site the routines every shop does for itself, and once the ones that belong to the tenant', () => {
    const perSite = SCENARIOS.filter((scenario) => scenario.perSite).map((scenario) => scenario.id);
    expect(perSite).toEqual(expect.arrayContaining(['open-shop', 'stock-order', 'receive-delivery', 'close-shop', 'weekly-cycle-count']));
    for (const id of ['collections', 'vendor-bills', 'weekly-ap-run', 'monthly-period-close', 'monthly-financial-statements']) {
      expect(SCENARIOS.some((scenario) => scenario.id === id)).toBe(true);
      expect([id, perSite.includes(id)]).toEqual([id, false]);
    }
    for (const scenario of SCENARIOS.filter((entry) => entry.perSite)) {
      expect([scenario.id, /one site|[Pp]ick (one|an active)/.test(scenario.goal)]).toEqual([scenario.id, false]);
    }
  });

  it('orders replenishment stock and receives it, at every site, every day', () => {
    const order = SCENARIOS.find((scenario) => scenario.id === 'stock-order');
    const receive = SCENARIOS.find((scenario) => scenario.id === 'receive-delivery');
    expect(order).toMatchObject({ cadence: 'daily', perSite: true, persona: 'parts' });
    expect(receive).toMatchObject({ cadence: 'daily', perSite: true, persona: 'parts' });
    // The order is approved, or there would be nothing for the delivery to be received against.
    expect(order?.operations).toEqual(
      expect.arrayContaining(['order.PurchaseOrdersApi.createPurchaseOrder', 'order.PurchaseOrdersApi.approvePurchaseOrder']),
    );
    expect(order?.expect).toContainEqual({ kind: 'call', operation: 'order.PurchaseOrdersApi.approvePurchaseOrder', outcome: 'any' });
    expect(receive?.operations).toEqual(
      expect.arrayContaining([
        'inventory.ASNApi.createAsn',
        'inventory.ASNApi.createGoodsReceipt',
        'inventory.PutawayApi.generatePutawayTasks',
        'inventory.PutawayApi.claimPutawayTask',
      ]),
    );
    // Ordered in the morning, delivered after lunch.
    expect((order?.at ?? '') < (receive?.at ?? '')).toBe(true);
  });

  it('keeps the books moving: bills entered and approved daily, vendors paid weekly, commercial accounts collected daily', () => {
    const byId = (id: string) => SCENARIOS.find((scenario) => scenario.id === id);
    expect(byId('vendor-bills')).toMatchObject({ cadence: 'daily', perSite: false });
    expect(byId('vendor-bills')?.operations).toEqual(
      expect.arrayContaining([
        'accounting.VendorBillAPIApi.createVendorBillFromGoodsReceived',
        'accounting.VendorBillAPIApi.matchVendorInvoice',
        'accounting.VendorBillAPIApi.resolveVendorBillMatchException',
        'accounting.VendorBillAPIApi.approveVendorBill',
      ]),
    );
    expect(byId('collections')).toMatchObject({ cadence: 'daily', perSite: false, persona: 'controller' });
    expect(byId('collections')?.operations).toEqual(
      expect.arrayContaining([
        'accounting.AccountingEventsApi.submitAccountingEvent',
        'accounting.PaymentApplicationsApi.listCustomerOpenInvoices',
        'accounting.PaymentApplicationsApi.applyPayment',
      ]),
    );
    expect(byId('weekly-ap-run')?.operations).toContain('accounting.APPaymentsApi.executeApPayment');
    // The vendor payment is pinned in exactly one place: the payment run.
    expect(SCENARIOS.filter((scenario) => scenario.operations.includes('accounting.APPaymentsApi.executeApPayment')).map((scenario) => scenario.id)).toEqual([
      'weekly-ap-run',
    ]);
    // Bills are entered after the afternoon delivery they are for.
    expect((byId('receive-delivery')?.at ?? '') < (byId('vendor-bills')?.at ?? '')).toBe(true);
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
