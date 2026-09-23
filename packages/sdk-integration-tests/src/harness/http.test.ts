import { call, expectApiError, formatError, withSiteScope } from './http';

/** The shape the generated clients throw: a ResponseError carrying the Response. */
const rejection = (status: number, body: unknown): Promise<never> =>
  Promise.reject(
    Object.assign(new Error('Response returned an error code'), {
      response: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    }),
  );

describe('expectApiError', () => {
  it('returns the parsed body when status and code both match', async () => {
    const body = await expectApiError(
      rejection(409, { code: 'RESOURCE_OCCUPIED', message: 'BAY b already holds open workorder w1', referenceId: 'w1' }),
      409,
      'RESOURCE_OCCUPIED',
    );

    expect(body).toEqual({
      status: 409,
      code: 'RESOURCE_OCCUPIED',
      message: 'BAY b already holds open workorder w1',
      referenceId: 'w1',
    });
  });

  it('fails on the right status with the wrong code, showing the body', async () => {
    await expect(
      expectApiError(rejection(409, { code: 'WORKORDER_CLOSED' }), 409, 'RESOURCE_OCCUPIED'),
    ).rejects.toThrow(/Expected HTTP 409 RESOURCE_OCCUPIED but got: HTTP 409: \{"code":"WORKORDER_CLOSED"\}/);
  });

  it('fails on the wrong status', async () => {
    await expect(expectApiError(rejection(422, { code: 'RESOURCE_OCCUPIED' }), 409, 'RESOURCE_OCCUPIED')).rejects.toThrow(
      /Expected HTTP 409 RESOURCE_OCCUPIED but got: HTTP 422/,
    );
  });

  it('fails when the call succeeds', async () => {
    await expect(expectApiError(Promise.resolve({ ok: true }), 409, 'RESOURCE_OCCUPIED')).rejects.toThrow(
      /but it succeeded with \{"ok":true\}/,
    );
  });

  it('fails without a readable body rather than passing on status alone', async () => {
    const bare = Promise.reject(Object.assign(new Error('x'), { response: new Response('not json', { status: 409 }) }));

    await expect(expectApiError(bare, 409, 'RESOURCE_OCCUPIED')).rejects.toThrow(/Expected HTTP 409 RESOURCE_OCCUPIED/);
  });
});

describe('withSiteScope', () => {
  it('adds X-Site-Id and keeps the headers the generated client already set', async () => {
    const override = await withSiteScope('site-1')({
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Version': '1' } },
    });

    const headers = new Headers(override.headers);
    expect(headers.get('X-Site-Id')).toBe('site-1');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-API-Version')).toBe('1');
  });

  it('returns only headers, so the spread over the request init leaves method and body alone', async () => {
    const override = await withSiteScope('site-1')({ init: { method: 'POST', body: '{}' } });

    expect(Object.keys(override)).toEqual(['headers']);
  });
});

/**
 * The 401 retry. SeederAuth renews on a schedule built from a clock rate measured
 * once at login, and on an accelerated backend the margin that schedule works with
 * is around a second — so a request that queues behind a slow one, or a stack
 * re-dispatched at a different scale, lands the wrong side of it. These pin that
 * one unlucky request does not end a six-hour run, and that nothing else is
 * retried.
 */
jest.mock('@durion-sdk/seeder', () => ({ renewAllAuths: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renewAllAuths } = require('@durion-sdk/seeder') as { renewAllAuths: jest.Mock };

describe('call — renewing on a 401', () => {
  beforeEach(() => {
    renewAllAuths.mockReset();
    renewAllAuths.mockResolvedValue(1);
  });

  it('renews and retries once, then returns the retry result', async () => {
    const attempt = jest
      .fn<Promise<string>, []>()
      .mockImplementationOnce(() => rejection(401, { message: 'expired' }))
      .mockResolvedValueOnce('second time lucky');

    await expect(call('listUsers', attempt)).resolves.toBe('second time lucky');

    expect(renewAllAuths).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('reports a second 401 rather than retrying into a loop', async () => {
    // Two 401s around a fresh token is not a timing problem — it is the identity
    // genuinely not being allowed, and looping on it would hide that behind a hang.
    const attempt = jest.fn<Promise<string>, []>(() => rejection(401, { message: 'nope' }));

    await expect(call('listUsers', attempt)).rejects.toThrow(/after renewing 1 token\(s\)/);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 403', async () => {
    // Several suites assert a 403 deliberately: it is an authorization answer, not a
    // stale token, and retrying it would turn a role-negative test into a slow pass.
    const attempt = jest.fn<Promise<string>, []>(() => rejection(403, { message: 'forbidden' }));

    await expect(call('deleteUser', attempt)).rejects.toThrow(/HTTP 403/);
    expect(renewAllAuths).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 409 or any other failure', async () => {
    const attempt = jest.fn<Promise<string>, []>(() => rejection(409, { message: 'conflict' }));

    await expect(call('assignBay', attempt)).rejects.toThrow(/HTTP 409/);
    expect(renewAllAuths).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('says so when a 401 arrives with nothing logged in to renew', async () => {
    // Otherwise the retry silently repeats the same unauthenticated call and reports
    // the second failure, which reads as a flake rather than "nobody was logged in".
    renewAllAuths.mockResolvedValue(0);
    const attempt = jest.fn<Promise<string>, []>(() => rejection(401, { message: 'expired' }));

    await expect(call('listUsers', attempt)).rejects.toThrow(/no logged-in identity to renew/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('formatError — a body that is read twice', () => {
  const BODY = '{"code":"SERVICE_POSITION_INVALID","message":"at another site"}';

  /**
   * A real Response, not a hand-rolled fake.
   *
   * `Response.clone` is brand-checked, so a detached call throws where a plain
   * object's would not — which is precisely the bug a fake let through: every real
   * response fell to the direct read, consumed its stream, and the next format said
   * `(could not read body)` exactly as before the fix.
   */
  const failure = (status: number, body: string) => ({
    response: new Response(body, {
      status,
      headers: { 'x-correlation-id': 'abc-123' },
    }),
  });

  it('leaves the original readable, and still has the body on a second format', async () => {
    const error = failure(422, BODY);

    const first = await formatError(error);
    // The contract, asserted rather than assumed: whoever reads the response after
    // the formatter must still find a body. An implementation that read the
    // original directly would throw here.
    const direct = await error.response.text();
    const second = await formatError(error);

    expect(first).toContain('SERVICE_POSITION_INVALID');
    expect(direct).toBe(BODY);
    expect(second).toContain('SERVICE_POSITION_INVALID');
    expect(second).toContain('correlationId=abc-123');
    expect(second).not.toContain('could not read body');
  });

  it('still reports the body when the response was already consumed elsewhere', async () => {
    const error = failure(500, '{"code":"INTERNAL_ERROR"}');
    await error.response.text();

    // The stream is spent and `clone()` now throws, so this is the fallback path:
    // nothing can be recovered, and it says so rather than inventing a body.
    expect(await formatError(error)).toContain('could not read body');
  });

  it('reads a response that has no clone at all', async () => {
    const error = {
      response: {
        status: 500,
        headers: new Headers(),
        async text() {
          return '{"code":"INTERNAL_ERROR"}';
        },
      },
    };

    expect(await formatError(error)).toContain('INTERNAL_ERROR');
    // Cached, so the second format does not re-read a stream that is now spent.
    expect(await formatError(error)).toContain('INTERNAL_ERROR');
  });

  it('says so when the body genuinely cannot be read', async () => {
    const error = {
      response: {
        status: 502,
        headers: new Headers(),
        async text(): Promise<string> {
          throw new TypeError('network error');
        },
      },
    };

    expect(await formatError(error)).toContain('(could not read body)');
  });
});
