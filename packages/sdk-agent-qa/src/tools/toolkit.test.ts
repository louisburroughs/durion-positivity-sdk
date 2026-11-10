import { buildCatalog } from '../catalog/buildCatalog';
import { CoverageStore } from '../coverage/CoverageStore';
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
      'finish',
    ]);
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
