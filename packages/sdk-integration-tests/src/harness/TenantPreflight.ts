// Imported by path, not by package name, for the reason globalSetup.ts spells
// out: Jest applies moduleNameMapper to the suites but NOT to globalSetup, and
// this module is reached from there.
import { createSecurityClient } from '../../../sdk-security/src';
import { formatError } from './http';
import type { ItestConfig, PersonaCredentials, TenantRef } from './ItestConfig';

/** The tenant a token is bound to, as GET /v1/tenants/me reports it. */
export interface BoundTenant {
  id: string;
  slug: string;
  status: string;
}

/** Login plus "which tenant am I", behind a port so the preflight tests without HTTP. */
export interface TenantPort {
  tenantOf(credentials: PersonaCredentials, slug: string): Promise<BoundTenant>;
}

/**
 * Tenant-binding preflight.
 *
 * A login that succeeds is not proof it landed in the right tenant: a login that
 * names no tenant binds the deploy's transitional default, and suites running
 * under such a token would seed and assert against another tenant's rows while
 * every call still answers 200. This runs before anything is written and turns
 * that into one error naming every account bound somewhere unexpected.
 *
 * Every alpha account (admin and each configured persona) must be bound to the
 * suite tenant and that tenant must be ACTIVE. The platform login, when
 * configured, must be bound to the platform tenant.
 */
export class TenantPreflight {
  constructor(
    private readonly config: ItestConfig,
    private readonly port: TenantPort,
  ) {}

  async run(): Promise<string[]> {
    const verified: string[] = [];
    const problems: string[] = [];

    const check = async (label: string, credentials: PersonaCredentials, expected: TenantRef): Promise<void> => {
      const { username } = credentials;
      let bound: BoundTenant;
      try {
        bound = await this.port.tenantOf(credentials, expected.slug);
      } catch (error) {
        problems.push(`${label}: "${username}" could not establish its tenant (${await formatError(error)})`);
        return;
      }
      if (bound.id.toLowerCase() !== expected.id || bound.slug !== expected.slug) {
        problems.push(
          `${label}: "${username}" is bound to ${bound.slug} (${bound.id}), expected ${expected.slug} (${expected.id})`,
        );
        return;
      }
      if (bound.status !== 'ACTIVE') {
        problems.push(`${label}: "${username}" is bound to ${bound.slug}, which is ${bound.status}, not ACTIVE`);
        return;
      }
      verified.push(`${label}=${username}@${bound.slug}`);
    };

    for (const { persona, credentials } of this.config.distinctAccounts()) {
      await check(persona, credentials, this.config.tenant);
    }
    if (this.config.platformCredentials && this.config.platformTenant) {
      await check('platform', this.config.platformCredentials, this.config.platformTenant);
    }

    if (problems.length > 0) {
      throw new Error(`Tenant preflight failed:\n  - ${problems.join('\n  - ')}`);
    }
    return verified;
  }
}

/**
 * Builds the port against the gateway's security-service route. Each check logs
 * in afresh with the slug and reads the bound tenant with that token, so it
 * tests exactly the login path SeederAuth and the suites use.
 */
export function createTenantPort(config: ItestConfig): TenantPort {
  const baseUrl = `${config.baseUrl}/security-service`;
  const { authAPIApi } = createSecurityClient({ baseUrl });

  return {
    async tenantOf({ username, password }: PersonaCredentials, slug: string): Promise<BoundTenant> {
      const { accessToken } = await authAPIApi.loginUser({
        loginRequest: { username, password, tenantSlug: slug },
      });
      if (!accessToken) {
        throw new Error('login returned no access token');
      }
      const { tenantAPIApi } = createSecurityClient({ baseUrl, token: () => accessToken });
      const tenant = await tenantAPIApi.getMyTenant();
      return { id: tenant.id, slug: tenant.slug, status: tenant.status };
    },
  };
}
