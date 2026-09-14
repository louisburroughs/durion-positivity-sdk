import { ItestConfig } from './ItestConfig';
import { TenantPreflight, type BoundTenant, type TenantPort } from './TenantPreflight';

const ALPHA = { slug: 'alpha', id: '01900000-0000-7000-8000-000000000001' };
const PLATFORM = { slug: 'platform', id: '01900000-0000-7000-8000-000000000000' };

const BASE_ENV = {
  ITEST_USERNAME: 'admin.alpha',
  ITEST_PASSWORD: 'admin-pw',
  ALPHA_TENANT_SLUG: ALPHA.slug,
  ALPHA_TENANT_ID: ALPHA.id,
};

const ROLE_ENV = {
  ...BASE_ENV,
  ITEST_TECH_USERNAME: 'kyle.brennan',
  ITEST_TECH_PASSWORD: 'tech-pw',
};

const PLATFORM_ENV = {
  ...BASE_ENV,
  PLATFORM_TENANT_SLUG: PLATFORM.slug,
  PLATFORM_TENANT_ID: PLATFORM.id,
  ITEST_PLATFORM_USERNAME: 'admin.platform',
  ITEST_PLATFORM_PASSWORD: 'platform-pw',
};

const active = (tenant: { slug: string; id: string }): BoundTenant => ({ ...tenant, status: 'ACTIVE' });

/** Answers per username; an account not listed is bound to the slug it asked for, as alpha. */
function fakePort(
  bindings: Record<string, BoundTenant | Error> = {},
): TenantPort & { asked: Array<{ username: string; slug: string }> } {
  const asked: Array<{ username: string; slug: string }> = [];
  return {
    asked,
    tenantOf: ({ username }, slug) => {
      asked.push({ username, slug });
      const binding = bindings[username] ?? active(ALPHA);
      return binding instanceof Error ? Promise.reject(binding) : Promise.resolve(binding);
    },
  };
}

describe('TenantPreflight', () => {
  it('verifies each distinct account once, logging in with the suite tenant slug', async () => {
    const port = fakePort();

    const verified = await new TenantPreflight(ItestConfig.fromEnv({ ...ROLE_ENV }), port).run();

    expect(verified).toEqual(['admin=admin.alpha@alpha', 'tech=kyle.brennan@alpha']);
    expect(port.asked).toEqual([
      { username: 'admin.alpha', slug: 'alpha' },
      { username: 'kyle.brennan', slug: 'alpha' },
    ]);
  });

  it('refuses an account bound to another tenant, and names every problem at once', async () => {
    const port = fakePort({
      'admin.alpha': active(PLATFORM),
      'kyle.brennan': new Error('401 INVALID_CREDENTIALS'),
    });

    const failure = new TenantPreflight(ItestConfig.fromEnv({ ...ROLE_ENV }), port).run();

    await expect(failure).rejects.toThrow(/admin: "admin.alpha" is bound to platform \(01900000-0000-7000-8000-000000000000\)/);
    await expect(failure).rejects.toThrow(/tech: "kyle.brennan" could not establish its tenant \(401 INVALID_CREDENTIALS\)/);
  });

  it('refuses a suite tenant that is not ACTIVE', async () => {
    const port = fakePort({ 'admin.alpha': { ...ALPHA, status: 'SUSPENDED' } });

    await expect(new TenantPreflight(ItestConfig.fromEnv({ ...BASE_ENV }), port).run()).rejects.toThrow(
      /alpha, which is SUSPENDED, not ACTIVE/,
    );
  });

  it('checks the platform login against the platform tenant when one is configured', async () => {
    const port = fakePort({ 'admin.platform': active(PLATFORM) });

    const verified = await new TenantPreflight(ItestConfig.fromEnv({ ...PLATFORM_ENV }), port).run();

    expect(verified).toEqual(['admin=admin.alpha@alpha', 'platform=admin.platform@platform']);
    expect(port.asked).toContainEqual({ username: 'admin.platform', slug: 'platform' });
  });

  it('refuses a platform login that lands in the suite tenant', async () => {
    const port = fakePort();

    await expect(new TenantPreflight(ItestConfig.fromEnv({ ...PLATFORM_ENV }), port).run()).rejects.toThrow(
      /platform: "admin.platform" is bound to alpha/,
    );
  });
});
