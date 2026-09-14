import { SeederConfig } from '../SeederConfig';
import { SecurityBootstrap } from './SecurityBootstrap';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const TENANT_ID = '01900000-0000-7000-8000-000000000001';

const json = (body: unknown, status = 200): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

function stubFetch(options: { roleStatus?: number } = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    if (url.includes('/v1/permissions')) {
      return json({
        content: [{ name: 'security:role:view' }, { name: 'platform:tenant:provision' }],
        totalPages: 1,
        number: 0,
      });
    }
    if (url.includes('/v1/roles/by-name/')) {
      return options.roleStatus ? json({ code: 'ROLE_NOT_FOUND' }, options.roleStatus) : json({ id: 'role-in-tenant' });
    }
    if (url.endsWith('/v1/users')) {
      return json([{ id: 'user-1', username: 'admin.alpha' }]);
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  return calls;
}

const config = (tenantId?: string): SeederConfig =>
  SeederConfig.fromValues({
    securityServiceUrl: 'http://security',
    username: 'admin.alpha',
    password: 'pw',
    tenantId,
  });

describe('SecurityBootstrap', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('binds every call to the configured tenant', async () => {
    const calls = stubFetch();

    await new SecurityBootstrap(config(TENANT_ID)).run();

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.headers['X-Tenant-Id']).toBe(TENANT_ID);
    }
  });

  it('grants every non-platform permission to, and assigns, the role resolved by name in that tenant', async () => {
    const calls = stubFetch();

    await new SecurityBootstrap(config(TENANT_ID)).run();

    expect(calls.map((call) => call.url)).toContain('http://security/v1/roles/by-name/SYSTEM_ADMINISTRATOR');
    const grant = calls.find((call) => call.url.endsWith('/v1/roles/permissions'));
    expect(JSON.parse(grant?.body ?? '{}')).toEqual({ roleId: 'role-in-tenant', permissionNames: ['security:role:view'] });
    expect(calls.at(-1)?.url).toBe('http://security/v1/users/user-1/roles/role-in-tenant');
  });

  it('sends no tenant header when none is configured', async () => {
    const calls = stubFetch();

    await new SecurityBootstrap(config()).run();

    for (const call of calls) {
      expect(call.headers).not.toHaveProperty('X-Tenant-Id');
    }
  });

  it('fails naming the role when it cannot be resolved in the tenant', async () => {
    stubFetch({ roleStatus: 404 });

    await expect(new SecurityBootstrap(config(TENANT_ID)).run()).rejects.toThrow(
      /Failed to resolve SYSTEM_ADMINISTRATOR: 404/,
    );
  });
});
