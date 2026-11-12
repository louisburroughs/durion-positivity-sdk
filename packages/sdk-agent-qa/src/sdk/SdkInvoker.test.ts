import { buildCatalog } from '../catalog/buildCatalog';
import { fakeBackend, GATEWAY, invokerFor } from '../testing/fakes';
import { extractErrorCode, SdkInvoker } from './SdkInvoker';

const catalog = buildCatalog();
const op = (id: string) => {
  const operation = catalog.byId.get(id);
  if (!operation) {
    throw new Error(`no operation ${id}`);
  }
  return operation;
};

describe('SdkInvoker', () => {
  it('calls the generated client, which builds the path and sends the transport headers', async () => {
    const backend = fakeBackend((request) =>
      request.path === '/order/v1/orders/sessions/s-1/begin-close' ? { status: 200, body: { id: 's-1', status: 'CLOSING' } } : undefined,
    );
    const outcome = await invokerFor(backend).invoke(
      op('order.RegisterSessionsApi.beginSessionClose'),
      { sessionId: 's-1', beginCloseRequest: { countedCash: 150.25 } },
      'manager',
    );
    expect(outcome).toMatchObject({ kind: 'success', status: 200, body: { status: 'CLOSING' }, requestPath: '/v1/orders/sessions/s-1/begin-close' });
    const [request] = backend.requests;
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body ?? '{}')).toEqual({ countedCash: 150.25 });
    expect(request.headers.get('Authorization')).toBe('Bearer token-manager');
    expect(request.headers.get('X-API-Version')).toBe('1');
    expect(request.headers.get('X-Correlation-Id')).toBe(outcome.correlationId);
  });

  it('passes an explicit Idempotency-Key through, blank included', async () => {
    const backend = fakeBackend(() => ({ status: 201, body: {} }));
    const invoker = invokerFor(backend);
    const input = { sessionId: 's-1', cashMovementRequest: { amount: 5, currencyCode: 'USD', reason: 'BANK_DROP' } };
    await invoker.invoke(op('order.RegisterSessionsApi.recordCashMovement'), { ...input, idempotencyKey: 'key-1' }, 'advisor');
    await invoker.invoke(op('order.RegisterSessionsApi.recordCashMovement'), { ...input, idempotencyKey: '' }, 'advisor');
    expect(backend.requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual(['key-1', '']);
  });

  it('serializes Date parameters given as ISO strings', async () => {
    const backend = fakeBackend(() => ({ status: 200, body: {} }));
    const operation = catalog.operations.find(
      (candidate) => candidate.http === 'GET' && Object.values(candidate.input.properties).some((property) => property.kind === 'date'),
    );
    expect(operation).toBeDefined();
    if (operation) {
      const input: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(operation.input.properties)) {
        if (property.kind === 'date') {
          input[name] = '2026-03-04T05:06:07.000Z';
        } else if (operation.input.required.includes(name)) {
          input[name] = property.kind === 'number' ? 1 : property.kind === 'enum' ? property.values[0] : 'x';
        }
      }
      const outcome = await invokerFor(backend).invoke(operation, input, 'admin');
      expect(outcome.kind).toBe('success');
      expect(decodeURIComponent(backend.requests[0].path)).toMatch(/2026-03-04/);
    }
  });

  it('returns an HTTP error as an outcome with its status and error code', async () => {
    const backend = fakeBackend(() => ({ status: 409, body: { code: 'SESSION_ALREADY_CLOSED', message: 'closed' } }));
    const outcome = await invokerFor(backend).invoke(op('order.RegisterSessionsApi.confirmSessionClose'), { sessionId: 's-1' }, 'manager');
    expect(outcome).toMatchObject({ kind: 'http-error', status: 409, errorCode: 'SESSION_ALREADY_CLOSED', body: { message: 'closed' } });
  });

  it('reports a network failure as a transport error, not an exception', async () => {
    const invoker = new SdkInvoker({
      baseUrlFor: () => GATEWAY,
      tokenFor: async () => 't',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const outcome = await invoker.invoke(op('location.LocationAPIApi.listLocations'), {}, 'admin');
    expect(outcome.kind).toBe('transport-error');
    expect(outcome.status).toBeUndefined();
  });

  it('reports a 2xx body the generated model cannot read as a decode error, with the status it arrived with', async () => {
    // browseParties declares a page object; an array is not one.
    const backend = fakeBackend(() => ({ status: 200, body: [] }));
    const outcome = await invokerFor(backend).invoke(op('customer.CRMAccountsApi.browseParties'), {}, 'advisor');
    expect(outcome).toMatchObject({ kind: 'decode-error', status: 200, message: expect.stringMatching(/could not decode the 200 response/) });
  });

  it('reports the generated client refusing a null required parameter as a client error', async () => {
    const backend = fakeBackend();
    const outcome = await invokerFor(backend).invoke(op('order.RegisterSessionsApi.confirmSessionClose'), {}, 'manager');
    expect(outcome).toMatchObject({ kind: 'client-error', message: expect.stringMatching(/sessionId/) });
    expect(backend.requests).toEqual([]);
  });

  it('does not send anything for a package with no route', async () => {
    const backend = fakeBackend();
    const invoker = invokerFor(backend);
    expect(invoker.isReachable('internal')).toBe(false);
    const outcome = await invoker.invoke(op('internal.TaxApi.getTaxTypes'), {}, 'admin');
    expect(outcome).toMatchObject({ kind: 'client-error', message: expect.stringMatching(/QA_SERVICE_URL_INTERNAL/) });
    expect(backend.requests).toEqual([]);
  });

  it('can instantiate every API class the catalog names', () => {
    const invoker = invokerFor(fakeBackend(), []);
    const load = (invoker as unknown as { moduleFor(pkg: string): Record<string, unknown> }).moduleFor.bind(invoker);
    for (const operation of catalog.operations) {
      const ApiClass = load(operation.pkg)[operation.api] as { prototype: Record<string, unknown> } | undefined;
      expect([operation.id, typeof ApiClass?.prototype[operation.method]]).toEqual([operation.id, 'function']);
    }
  });
});

describe('extractErrorCode', () => {
  it('reads a machine code from the usual fields and ignores prose', () => {
    expect(extractErrorCode({ code: 'ORDER_NOT_FOUND' })).toBe('ORDER_NOT_FOUND');
    expect(extractErrorCode({ errorCode: 'LOCATION_SCOPE_DENIED' })).toBe('LOCATION_SCOPE_DENIED');
    expect(extractErrorCode({ error: 'Not Found' })).toBeUndefined();
    expect(extractErrorCode('nope')).toBeUndefined();
  });
});
