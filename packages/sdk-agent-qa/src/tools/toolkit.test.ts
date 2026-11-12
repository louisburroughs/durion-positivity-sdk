import { buildCatalog } from '../catalog/buildCatalog';
import { CoverageStore } from '../sdk-coverage/CoverageStore';
import { CallLedger } from '../ledger/CallLedger';
import { fakeBackend, invokerFor, type FakeBackend } from '../testing/fakes';
import { ToolRuntime, type QaTool, type SafetyPolicy, type ToolRuntimeOptions } from './toolkit';

const catalog = buildCatalog();
const AT = new Date('2026-03-10T15:00:00Z');

function setup(overrides: Partial<Omit<ToolRuntimeOptions, 'policy'>> & { policy?: Partial<SafetyPolicy> } = {}): {
  runtime: ToolRuntime;
  backend: FakeBackend;
  ledger: CallLedger;
  coverage: CoverageStore;
  tool(name: string): QaTool;
} {
  const backend = fakeBackend((request) => (request.method === 'GET' ? { status: 200, body: [] } : { status: 201, body: {} }));
  const ledger = new CallLedger();
  const coverage = CoverageStore.inMemory('2026-03');
  const { policy, ...rest } = overrides;
  const runtime = new ToolRuntime({
    catalog,
    invoker: invokerFor(backend),
    ledger,
    coverage,
    runId: 'run-1',
    scenarioId: 'scenario-1',
    persona: 'advisor',
    personas: ['admin', 'advisor', 'tech'],
    pinned: ['location.LocationAPIApi.listLocations', 'order.RegisterSessionsApi.recordCashMovement'],
    allowUnvalidated: false,
    maxCalls: 5,
    now: () => AT,
    ...rest,
    policy: { mode: 'mutating', allowDestructive: false, deny: [], ...policy },
  });
  const tools = runtime.tools();
  return {
    runtime,
    backend,
    ledger,
    coverage,
    tool: (name) => {
      const found = tools.find((entry) => entry.name === name);
      if (!found) {
        throw new Error(`no tool ${name}; have ${tools.map((entry) => entry.name).join(', ')}`);
      }
      return found;
    },
  };
}

const sdkCall = (context: ReturnType<typeof setup>, input: Record<string, unknown>) =>
  context.tool('sdk_call').execute(context.tool('sdk_call').schema.parse(input)) as Promise<Record<string, any>>;

describe('ToolRuntime tools', () => {
  it('offers one tool per pinned operation plus the catalog tools and finish', () => {
    const names = setup().runtime.tools().map((tool) => tool.name);
    expect(names).toEqual([
      'location__LocationAPIApi__listLocations',
      'order__RegisterSessionsApi__recordCashMovement',
      'sdk_search',
      'sdk_describe',
      'sdk_call',
      'wait',
      'finish',
    ]);
  });

  it('offers remember only to a scenario with a memory, and writes what it is told', async () => {
    const memory: Record<string, string> = { partyId: 'p-1' };
    const context = setup({ memory });
    const remember = context.tool('remember');
    expect(await remember.execute(remember.schema.parse({ key: 'workorderId', value: 'w-9' }))).toEqual({ remembered: ['partyId', 'workorderId'] });
    expect(memory).toEqual({ partyId: 'p-1', workorderId: 'w-9' });
    expect(remember.schema.safeParse({ key: 'not a key!', value: 'x' }).success).toBe(false);
  });

  it('waits when asked, without really sleeping in tests', async () => {
    const slept: number[] = [];
    const context = setup({ sleep: async (ms) => void slept.push(ms) });
    expect(await context.tool('wait').execute({ seconds: 5 })).toEqual({ waited: 5 });
    expect(slept).toEqual([5000]);
    expect(context.tool('wait').schema.safeParse({ seconds: 600 }).success).toBe(false);
  });

  it('tells the model a replication-lag 503 is temporary, and reports every answered call to onCall', async () => {
    const seen: string[] = [];
    const context = setup({ onCall: (operation, outcome) => void seen.push(`${operation.method} ${outcome.status}`) });
    context.backend.fetchImpl = fakeBackend(() => ({ status: 503, body: { code: 'CUSTOMER_REQUIREMENTS_UNAVAILABLE' } })).fetchImpl;
    const runtime = new ToolRuntime({
      catalog,
      invoker: invokerFor(context.backend),
      ledger: context.ledger,
      coverage: context.coverage,
      policy: { mode: 'mutating', allowDestructive: false, deny: [] },
      runId: 'r',
      scenarioId: 's',
      persona: 'advisor',
      personas: ['advisor'],
      pinned: [],
      allowUnvalidated: false,
      maxCalls: 5,
      onCall: (operation, outcome) => void seen.push(`${operation.method} ${outcome.status}`),
    });
    const result = await runtime.callOperation(catalog.byId.get('workorder.EstimateAPIApi.promoteEstimate')!, { estimateId: 'e-1' });
    expect(result).toMatchObject({ outcome: 'http-error', status: 503, hint: expect.stringMatching(/Temporary/) });
    expect(seen).toEqual(['promoteEstimate 503']);
  });

  it('runs a pinned tool as the scenario persona and records the call in the ledger and coverage', async () => {
    const context = setup();
    const result = (await context.tool('location__LocationAPIApi__listLocations').execute({})) as Record<string, unknown>;
    expect(result).toMatchObject({ outcome: 'success', status: 200 });
    expect(context.backend.requests[0].headers.get('Authorization')).toBe('Bearer token-advisor');
    expect(context.ledger.all()).toEqual([
      expect.objectContaining({
        at: AT.toISOString(),
        runId: 'run-1',
        scenarioId: 'scenario-1',
        operationId: 'location.LocationAPIApi.listLocations',
        pkg: 'location',
        persona: 'advisor',
        kind: 'success',
        status: 200,
        source: 'agent',
      }),
    ]);
    expect(context.coverage.isCalled('location.LocationAPIApi.listLocations')).toBe(true);
  });

  it('sends nothing when the input fails validation, and says what to fix', async () => {
    const context = setup();
    const result = await sdkCall(context, {
      operationId: 'order.RegisterSessionsApi.recordCashMovement',
      input: { sessionId: 's-1', cashMovementRequest: { amount: 'five', currencyCode: 'USD', reason: 'TIP_JAR' } },
    });
    expect(result['outcome']).toBe('invalid-input');
    expect(result['issues'].join('\n')).toMatch(/cashMovementRequest\.amount/);
    expect(result['issues'].join('\n')).toMatch(/cashMovementRequest\.reason/);
    expect(context.backend.requests).toEqual([]);
    expect(context.ledger.all()).toEqual([]);
  });

  it('supplies an Idempotency-Key when the operation needs one and none is given', async () => {
    const context = setup();
    const input = { sessionId: 's-1', cashMovementRequest: { amount: 5, currencyCode: 'USD', reason: 'BANK_DROP' } };
    await sdkCall(context, { operationId: 'order.RegisterSessionsApi.recordCashMovement', input });
    await sdkCall(context, { operationId: 'order.RegisterSessionsApi.recordCashMovement', input: { ...input, idempotencyKey: 'mine' } });
    const [generated, explicit] = context.backend.requests.map((request) => request.headers.get('Idempotency-Key'));
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(explicit).toBe('mine');
  });

  it('allows unvalidated calls only in scenarios that are meant to provoke errors', async () => {
    const args = { operationId: 'order.SalesOrdersApi.createCart', input: { createCartRequest: {} }, validate: false };
    const refused = await sdkCall(setup(), args);
    expect(refused).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/unvalidated/) });

    const context = setup({ allowUnvalidated: true });
    expect(await sdkCall(context, args)).toMatchObject({ outcome: 'success' });
    expect(context.ledger.all()[0]).toMatchObject({ unvalidated: true });
  });

  it('lets a call name another persona, but only a known one', async () => {
    const context = setup();
    await sdkCall(context, { operationId: 'location.LocationAPIApi.listLocations', persona: 'tech' });
    expect(context.backend.requests[0].headers.get('Authorization')).toBe('Bearer token-tech');
    expect(await sdkCall(context, { operationId: 'location.LocationAPIApi.listLocations', persona: 'root' })).toMatchObject({ outcome: 'refused' });
  });

  it('stops calling once the scenario call budget is spent', async () => {
    const context = setup({ maxCalls: 2 });
    const args = { operationId: 'location.LocationAPIApi.listLocations' };
    await sdkCall(context, args);
    await sdkCall(context, args);
    expect(await sdkCall(context, args)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/call budget/) });
    expect(context.backend.requests).toHaveLength(2);
  });

  it('finds operations by keyword and describes them with a JSON Schema', async () => {
    const context = setup();
    const found = (await context.tool('sdk_search').execute({ query: 'cash movement record', pkg: 'order' })) as { matches: Array<{ operationId: string }> };
    expect(found.matches[0].operationId).toBe('order.RegisterSessionsApi.recordCashMovement');

    const described = (await context.tool('sdk_describe').execute({ operationId: 'order.RegisterSessionsApi.recordCashMovement' })) as Record<string, any>;
    expect(described['http']).toBe('POST /v1/orders/sessions/{sessionId}/cash-movements');
    expect(described['inputSchema'].required).toEqual(expect.arrayContaining(['sessionId', 'cashMovementRequest']));

    expect(await context.tool('sdk_describe').execute({ operationId: 'order.Nope.nothing' })).toMatchObject({ error: expect.stringMatching(/sdk_search/) });
  });

  it('records the finish report', async () => {
    const context = setup();
    const finish = context.tool('finish');
    await finish.execute(finish.schema.parse({ verdict: 'completed', summary: 'done' }));
    expect(context.runtime.finishReport).toEqual({ verdict: 'completed', summary: 'done', findings: [] });
  });
});

describe('safety policy', () => {
  const destructive = 'customer.CustomerAPIApi.deleteCustomer';
  const call = (context: ReturnType<typeof setup>, operationId: string) => sdkCall(context, { operationId, input: { id: 'c-1', customerId: 'c-1' }, validate: undefined });

  it('refuses a destructive operation that is not pinned, even when destructive calls are allowed', async () => {
    const context = setup({ policy: { allowDestructive: true } });
    expect(await call(context, destructive)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/destructive/) });
    expect(context.backend.requests).toEqual([]);
  });

  it('refuses a pinned destructive operation unless the run allows destructive calls', async () => {
    expect(await call(setup({ pinned: [destructive] }), destructive)).toMatchObject({ outcome: 'refused' });
    const allowed = setup({ pinned: [destructive], policy: { allowDestructive: true } });
    expect(allowed.runtime.refusal(catalog.byId.get(destructive)!)).toBeUndefined();
  });

  it('refuses every write in read-only mode and still allows reads', async () => {
    const context = setup({ policy: { mode: 'read-only' } });
    expect(await sdkCall(context, { operationId: 'order.SalesOrdersApi.createCart', input: {} })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/read-only/) });
    expect(await sdkCall(context, { operationId: 'location.LocationAPIApi.listLocations' })).toMatchObject({ outcome: 'success' });
  });

  it('refuses operations on the deny list and packages with no route', async () => {
    const context = setup({ policy: { deny: [/^location\./] } });
    expect(await sdkCall(context, { operationId: 'location.LocationAPIApi.listLocations' })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/deny list/) });
    expect(await sdkCall(context, { operationId: 'internal.TaxApi.getTaxTypes' })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/not reachable/) });
    expect(context.backend.requests).toEqual([]);
  });
});

describe('vendor payment limits', () => {
  const PAY = 'accounting.APPaymentsApi.executeApPayment';
  const payment = (grossAmount: number, extra: Record<string, unknown> = {}) => ({
    operationId: PAY,
    input: { executeAPPaymentRequest: { vendorId: 'ven-1', currency: 'USD', grossAmount, paymentMethod: 'ACH', paymentRef: `ref-${grossAmount}`, ...extra } },
  });
  const method = (): string => {
    const operation = catalog.byId.get(PAY)!;
    const request = operation.input.properties['executeAPPaymentRequest'];
    const field = request.kind === 'object' ? request.properties['paymentMethod'] : undefined;
    return field?.kind === 'enum' ? field.values[0] : 'ACH';
  };
  const pay = (context: ReturnType<typeof setup>, grossAmount: number, extra: Record<string, unknown> = {}) =>
    sdkCall(context, payment(grossAmount, { paymentMethod: method(), ...extra }));

  it('pays a vendor only from the task whose job it is', async () => {
    const elsewhere = setup();
    expect(await pay(elsewhere, 100)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/only by the payment run/) });
    expect(elsewhere.backend.requests).toEqual([]);

    const run = setup({ pinned: [PAY] });
    expect(await pay(run, 100)).toMatchObject({ outcome: 'success' });
    expect(run.backend.requests).toHaveLength(1);
  });

  it('refuses a payment above the limit, without sending it', async () => {
    const context = setup({ pinned: [PAY], policy: { vendorPayments: { enabled: true, maxAmount: 1000, maxPerRun: 5 } } });
    expect(await pay(context, 1000.01)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/may not exceed 1000\.00/) });
    expect(await pay(context, 1000)).toMatchObject({ outcome: 'success' });
    expect(context.backend.requests).toHaveLength(1);
  });

  it('stops after the number of payments a run is allowed', async () => {
    const context = setup({ pinned: [PAY], maxCalls: 50, policy: { vendorPayments: { enabled: true, maxAmount: 5000, maxPerRun: 2 } } });
    expect(await pay(context, 10)).toMatchObject({ outcome: 'success' });
    expect(await pay(context, 20)).toMatchObject({ outcome: 'success' });
    expect(await pay(context, 30)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/already made 2 vendor payments/) });
    expect(context.backend.requests).toHaveLength(2);
  });

  it('holds the limits even when the model skips validation, and never passes an override through', async () => {
    const context = setup({ pinned: [PAY], allowUnvalidated: true });
    expect(await sdkCall(context, { ...payment(999999), validate: false })).toMatchObject({ outcome: 'refused' });
    expect(await sdkCall(context, { ...payment(-5), validate: false })).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/positive grossAmount/) });
    expect(await pay(context, 100, { overrideJustification: 'the model says so' })).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/a person's decision/),
    });
    expect(context.backend.requests).toEqual([]);
  });

  it('can be turned off altogether', async () => {
    const context = setup({ pinned: [PAY], policy: { vendorPayments: { enabled: false, maxAmount: 5000, maxPerRun: 5 } } });
    expect(await pay(context, 10)).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/turned off/) });
    expect(context.backend.requests).toEqual([]);
  });
});
