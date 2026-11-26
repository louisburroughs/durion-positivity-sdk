import { buildCatalog } from '../catalog/buildCatalog';
import { fakeBackend, GATEWAY, invokerFor } from '../testing/fakes';
import { extractErrorCode, isUnavailable, SdkInvoker } from './SdkInvoker';

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

  describe('when the backend cannot take a request (a deploy restarting a service)', () => {
    const retrying = (backend: ReturnType<typeof fakeBackend>, delays = [10, 20]) => {
      const waits: number[] = [];
      const invoker = new SdkInvoker({
        baseUrlFor: (pkg) => `${GATEWAY}/${pkg}`,
        tokenFor: async (persona) => `token-${persona}`,
        fetchImpl: backend.fetchImpl,
        retryDelaysMs: delays,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      return { invoker, waits };
    };
    const answers = (...statuses: Array<{ status: number; body?: unknown }>) => {
      let index = 0;
      return fakeBackend(() => statuses[Math.min(index++, statuses.length - 1)]);
    };
    const getOrder = op('order.SalesOrdersApi.getOrder');
    const closeInput = { sessionId: 's-1', beginCloseRequest: { countedCash: 1 } };
    const movement = { sessionId: 's-1', cashMovementRequest: { amount: 5, currencyCode: 'USD', reason: 'BANK_DROP' } };

    it('sends a code-less 503 again after each wait, and reports how many repeats it took', async () => {
      const backend = answers({ status: 503, body: { status: 503, error: 'Service Unavailable' } }, { status: 503 }, { status: 200, body: {} });
      const { invoker, waits } = retrying(backend);
      const outcome = await invoker.invoke(op('order.RegisterSessionsApi.beginSessionClose'), closeInput, 'manager');
      expect(outcome).toMatchObject({ kind: 'success', status: 200, retries: 2 });
      expect(waits).toEqual([10, 20]);
      expect(backend.requests).toHaveLength(3);
      // The same correlation id goes with every send, so the backend logs tie them together.
      expect(new Set(backend.requests.map((request) => request.headers.get('X-Correlation-Id'))).size).toBe(1);
    });

    it('returns the last answer once the waits run out', async () => {
      const backend = answers({ status: 502 });
      const { invoker } = retrying(backend);
      const outcome = await invoker.invoke(getOrder, { orderId: 'o-1' }, 'manager');
      expect(outcome).toMatchObject({ kind: 'http-error', status: 502, retries: 2 });
      expect(backend.requests).toHaveLength(3);
    });

    it('never repeats a 503 that carries a backend error code: the service answered', async () => {
      const backend = answers({ status: 503, body: { code: 'WORKORDER_REPLICATION_PENDING' } }, { status: 200, body: {} });
      const { invoker } = retrying(backend);
      const outcome = await invoker.invoke(getOrder, { orderId: 'o-1' }, 'manager');
      expect(outcome).toMatchObject({ kind: 'http-error', status: 503, errorCode: 'WORKORDER_REPLICATION_PENDING' });
      expect(outcome.retries).toBeUndefined();
      expect(backend.requests).toHaveLength(1);
    });

    it('repeats a code-less 500 or 504 only when the request is safe to send twice', async () => {
      const unkeyed = answers({ status: 504 }, { status: 200, body: {} });
      expect(await retrying(unkeyed).invoker.invoke(op('order.RegisterSessionsApi.beginSessionClose'), closeInput, 'manager')).toMatchObject({
        status: 504,
      });
      expect(unkeyed.requests).toHaveLength(1);

      const keyed = answers({ status: 500 }, { status: 201, body: {} });
      const outcome = await retrying(keyed).invoker.invoke(op('order.RegisterSessionsApi.recordCashMovement'), { ...movement, idempotencyKey: 'k-1' }, 'advisor');
      expect(outcome).toMatchObject({ kind: 'success', status: 201, retries: 1 });
      expect(keyed.requests.map((request) => request.headers.get('Idempotency-Key'))).toEqual(['k-1', 'k-1']);

      const read = answers({ status: 504 }, { status: 200, body: {} });
      expect(await retrying(read).invoker.invoke(getOrder, { orderId: 'o-1' }, 'manager')).toMatchObject({ status: 200, retries: 1 });
    });

    it('does not repeat a coded 500: that is a defect to report', async () => {
      const backend = answers({ status: 500, body: { code: 'INTERNAL_ERROR' } }, { status: 200, body: {} });
      const outcome = await retrying(backend).invoker.invoke(getOrder, { orderId: 'o-1' }, 'manager');
      expect(outcome).toMatchObject({ status: 500, errorCode: 'INTERNAL_ERROR' });
      expect(backend.requests).toHaveLength(1);
    });

    it('repeats a read whose connection failed, and not an unkeyed write', async () => {
      let calls = 0;
      const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError('fetch failed');
        }
        return fakeBackend(() => ({ status: 200, body: {} })).fetchImpl(input, init);
      }) as typeof fetch;
      const read = new SdkInvoker({ baseUrlFor: (pkg) => `${GATEWAY}/${pkg}`, tokenFor: async () => 't', fetchImpl: flaky, retryDelaysMs: [1], sleep: async () => undefined });
      expect(await read.invoke(getOrder, { orderId: 'o-1' }, 'manager')).toMatchObject({ kind: 'success', retries: 1 });

      calls = 0;
      const write = await read.invoke(op('order.RegisterSessionsApi.beginSessionClose'), closeInput, 'manager');
      expect(write.kind).toBe('transport-error');
      expect(calls).toBe(1);
    });

    it('sends once when no waits are configured', async () => {
      const backend = answers({ status: 503 }, { status: 200, body: {} });
      expect(await invokerFor(backend).invoke(getOrder, { orderId: 'o-1' }, 'manager')).toMatchObject({ status: 503 });
      expect(backend.requests).toHaveLength(1);
    });

    it('classifies statuses by code and repeat-safety', () => {
      expect(isUnavailable(503, undefined, false)).toBe(true);
      expect(isUnavailable(502, 'Bad Gateway', false)).toBe(true);
      expect(isUnavailable(503, { code: 'X_REPLICATION_PENDING' }, true)).toBe(false);
      expect(isUnavailable(500, {}, false)).toBe(false);
      expect(isUnavailable(500, {}, true)).toBe(true);
      expect(isUnavailable(501, {}, true)).toBe(false);
    });
  });
});
