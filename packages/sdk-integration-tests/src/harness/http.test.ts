import { expectApiError, withSiteScope } from './http';

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
