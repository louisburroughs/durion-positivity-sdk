import type { Visit } from './dayPlan';
import { concernTerms, prepareStage, type Lookup } from './prepare';

const SITE = { id: 'site-1', code: 'MAIN', name: 'Main Street', slug: 'main' };

function visitOf(overrides: Partial<Visit> = {}): Visit {
  return {
    id: 'main-v01',
    kind: 'service',
    customer: { type: 'individual', status: 'existing', search: { fragment: 'r', ordinal: 2 } },
    vehicle: { status: 'existing' },
    concern: 'Brakes squeal when stopping and the pedal feels soft. Wants them inspected and fixed.',
    arrival: 'walk-in',
    disposition: 'approves',
    payment: 'cash',
    parts: 'stock',
    site: SITE,
    stages: [{ id: 'main-v01-intake', name: 'intake', at: '09:00' }],
    ...overrides,
  };
}

type Responses = Record<string, (input: Record<string, unknown>, persona?: string) => unknown>;

/** A lookup answering from canned bodies, recording every call it was asked to make. */
function fakeLookup(responses: Responses): { lookup: Lookup; calls: Array<{ operationId: string; input: Record<string, unknown>; persona?: string }> } {
  const calls: Array<{ operationId: string; input: Record<string, unknown>; persona?: string }> = [];
  const lookup: Lookup = async (operationId, input, persona) => {
    calls.push({ operationId, input, persona });
    const respond = responses[operationId];
    return respond ? { ok: true, body: respond(input, persona) } : { ok: false, body: undefined };
  };
  return { lookup, calls };
}

const PARTIES = {
  results: [
    { partyId: 'cash', displayName: 'Walk-in customer', houseAccount: 'CASH_SALE', partyType: 'COMMERCIAL', status: 'ACTIVE' },
    { partyId: 'p-1', displayName: 'Rita Rowe', partyType: 'PERSON', status: 'ACTIVE' },
    { partyId: 'c-1', displayName: 'Carolina Power', partyType: 'COMMERCIAL', status: 'ACTIVE' },
    { partyId: 'p-2', displayName: 'Ray Ortiz', partyType: 'PERSON', status: 'ACTIVE' },
  ],
};

const SHOP: Responses = {
  'customer.CRMAccountsApi.browseParties': () => PARTIES,
  'customer.CRMVehiclesApi.listVehiclesForCustomer': () => [{ vehicleId: 'v-1', year: 2019, make: 'Ford', model: 'F-150' }],
  'catalog.ProductsAPIApi.searchCatalogServices': (input) =>
    input['q'] === 'brake' ? [{ id: 's-1', name: 'Brake Pad Replacement - Front', defaultLaborHours: 1.5 }] : [],
  'inventory.InventoryStockApi.listStock': () => ({
    lines: [
      { sku: 'EMPTY-1', available: 0 },
      { sku: 'BRK-9', available: 4 },
    ],
  }),
  'catalog.ProductsAPIApi.searchCatalogProducts': () => ({
    data: [
      { productId: 'prod-0', sku: 'NOT-HERE', name: 'Brake Rotor' },
      { productId: 'prod-9', sku: 'BRK-9', name: 'Brake Pad Set' },
    ],
  }),
};

describe('concernTerms', () => {
  it('turns what the customer said into catalog search terms, most specific first', () => {
    expect(concernTerms('Slow leak in the right rear tire.')).toEqual(['tire repair', 'tire']);
    expect(concernTerms('Oil change and tire rotation')).toEqual(['oil change', 'oil', 'tire', 'rotation']);
    expect(concernTerms('Something nobody planned for')).toEqual(['inspection']);
  });
});

describe('prepareStage', () => {
  it('finds the customer, their vehicle, the labor lines and a part on the shelf before the agent starts', async () => {
    const memory: Record<string, string> = {};
    const { lookup, calls } = fakeLookup(SHOP);
    await prepareStage(visitOf(), 'intake', memory, lookup, { roleMode: true });

    // Result 2 of the individuals (the house account and the business are not candidates).
    expect(memory['partyId']).toBe('p-2');
    expect(memory['customerName']).toBe('Ray Ortiz');
    expect(memory['vehicleId']).toBe('v-1');
    expect(memory['vehicleDescription']).toBe('2019 Ford F-150');
    expect(memory['laborLines']).toBe('serviceId s-1, description "Brake Pad Replacement - Front", quantity 1.5');
    expect(memory['partProductId']).toBe('prod-9');
    expect(memory['partLine']).toMatch(/^productId prod-9, description "Brake Pad Set", quantity 1, unitPrice \d+(\.\d+)?$/);

    expect(calls.find((entry) => entry.operationId === 'customer.CRMAccountsApi.browseParties')).toMatchObject({
      input: { name: 'r', partyType: 'PERSON', status: 'ACTIVE' },
    });
    // Stock is read as the parts lead, who may read it; the rest as the advisor.
    expect(calls.find((entry) => entry.operationId === 'inventory.InventoryStockApi.listStock')).toMatchObject({
      input: { scope: 'site-1' },
      persona: 'parts',
    });
  });

  it('gives the same visit the same part price every time it is prepared', async () => {
    const first: Record<string, string> = {};
    const second: Record<string, string> = {};
    await prepareStage(visitOf(), 'intake', first, fakeLookup(SHOP).lookup, { roleMode: true });
    await prepareStage(visitOf(), 'intake', second, fakeLookup(SHOP).lookup, { roleMode: true });
    expect(second['partLine']).toBe(first['partLine']);
  });

  it('makes the job labor only when the site has nothing on the shelf', async () => {
    const memory: Record<string, string> = {};
    const { lookup, calls } = fakeLookup({ ...SHOP, 'inventory.InventoryStockApi.listStock': () => ({ lines: [{ sku: 'X', available: 0 }] }) });
    await prepareStage(visitOf(), 'intake', memory, lookup, { roleMode: true });
    expect(memory['partLine']).toBeUndefined();
    expect(memory['partsNote']).toMatch(/labor only/);
    expect(calls.some((entry) => entry.operationId === 'catalog.ProductsAPIApi.searchCatalogProducts')).toBe(false);
  });

  it('generates a vehicle to register for a customer with none on file', async () => {
    const memory: Record<string, string> = {};
    await prepareStage(visitOf(), 'intake', memory, fakeLookup({ ...SHOP, 'customer.CRMVehiclesApi.listVehiclesForCustomer': () => [] }).lookup, {
      roleMode: true,
    });
    expect(memory['vehicleId']).toBeUndefined();
    expect(memory['vehicleToRegister']).toMatch(/^\d{4} .+, VIN [A-HJ-NPR-Z0-9]{17}, plate \S+$/);
  });

  it('picks billing terms for a new business, and looks up no customer for it', async () => {
    const memory: Record<string, string> = {};
    const { lookup, calls } = fakeLookup({ ...SHOP, 'customer.CRMAccountsApi.listBillingTerms': () => [{ code: 'COD' }, { code: 'NET_30' }] });
    await prepareStage(visitOf({ customer: { type: 'commercial', status: 'new' }, vehicle: { status: 'new' } }), 'intake', memory, lookup, {
      roleMode: true,
    });
    expect(memory['billingTerms']).toBe('NET_30');
    expect(calls.some((entry) => entry.operationId === 'customer.CRMAccountsApi.browseParties')).toBe(false);
  });

  it('leaves the customer of an appointment arrival to the agent, who finds them through the appointment', async () => {
    const memory: Record<string, string> = {};
    const { lookup, calls } = fakeLookup(SHOP);
    await prepareStage(visitOf({ arrival: 'appointment' }), 'intake', memory, lookup, { roleMode: true });
    expect(memory['partyId']).toBeUndefined();
    expect(calls.some((entry) => entry.operationId === 'customer.CRMAccountsApi.browseParties')).toBe(false);
    expect(memory['laborLines']).toBeDefined();
  });

  it('keeps facts already established and prepares nothing for stages past the counter', async () => {
    const memory: Record<string, string> = { partyId: 'known', vehicleId: 'v-known', laborLines: 'given', partLine: 'given' };
    const { lookup, calls } = fakeLookup(SHOP);
    await prepareStage(visitOf(), 'intake', memory, lookup, { roleMode: true });
    expect(calls).toEqual([]);

    await prepareStage(visitOf(), 'work', {}, lookup, { roleMode: true });
    expect(calls).toEqual([]);
  });

  it('tries other letters when the planned search finds nobody of the right kind, and gives up quietly when lookups fail', async () => {
    const memory: Record<string, string> = {};
    const { lookup, calls } = fakeLookup({
      ...SHOP,
      'customer.CRMAccountsApi.browseParties': (input) => (input['name'] === 'r' ? { results: [] } : PARTIES),
    });
    await prepareStage(visitOf(), 'intake', memory, lookup, { roleMode: true });
    expect(calls.filter((entry) => entry.operationId === 'customer.CRMAccountsApi.browseParties')).toHaveLength(2);
    expect(memory['partyId']).toBe('p-2');

    const nothing: Record<string, string> = {};
    await prepareStage(visitOf(), 'intake', nothing, fakeLookup({}).lookup, { roleMode: true });
    expect(nothing).toEqual({});
  });

  it('reads a stock line keyed by product id, and takes any stocked part when none fits the concern', async () => {
    const PRODUCT = '01a18cc7-273b-74b4-98ff-72f4507f0cbc';
    const memory: Record<string, string> = {};
    const { lookup } = fakeLookup({
      ...SHOP,
      'inventory.InventoryStockApi.listStock': () => ({ lines: [{ sku: PRODUCT, available: 95 }] }),
      'catalog.ProductsAPIApi.searchCatalogProducts': () => ({ data: [{ productId: 'prod-x', sku: 'ELSEWHERE', name: 'Brake Rotor' }] }),
      'catalog.ProductsAPIApi.getProductById': (input) => ({ id: input['productId'], name: 'Oil Filter 1' }),
    });
    await prepareStage(visitOf(), 'intake', memory, lookup, { roleMode: true });
    expect(memory['partProductId']).toBe(PRODUCT);
    expect(memory['partLine']).toMatch(new RegExp(`^productId ${PRODUCT}, description "Oil Filter 1", quantity 1, unitPrice`));
  });

  it('matches a catalog product to a stock line keyed by its product id', async () => {
    const memory: Record<string, string> = {};
    const { lookup } = fakeLookup({
      ...SHOP,
      'inventory.InventoryStockApi.listStock': () => ({ lines: [{ sku: '01a18cc7-0000-7000-8000-000000000009', available: 2 }] }),
      'catalog.ProductsAPIApi.searchCatalogProducts': () => ({
        data: [{ productId: '01a18cc7-0000-7000-8000-000000000009', sku: 'BRK-9', name: 'Brake Pad Set' }],
      }),
    });
    await prepareStage(visitOf(), 'intake', memory, lookup, { roleMode: true });
    expect(memory['partDescription']).toBe('Brake Pad Set');
  });
});
