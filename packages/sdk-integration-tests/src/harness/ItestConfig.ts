export type PersonaName =
  | 'admin'
  | 'advisor'
  | 'tech'
  | 'manager'
  | 'parts'
  | 'acct'
  | 'controller';

export type CredentialedPersona = Exclude<PersonaName, 'admin'>;

export type ItestMode = 'single-credential' | 'role';

export interface PersonaCredentials {
  username: string;
  password: string;
}

/** A tenant as login names it (slug) and as tokens and headers carry it (id). */
export interface TenantRef {
  slug: string;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERSONA_ENV_PREFIX: Record<CredentialedPersona, string> = {
  advisor: 'ITEST_ADVISOR',
  tech: 'ITEST_TECH',
  manager: 'ITEST_MANAGER',
  parts: 'ITEST_PARTS',
  acct: 'ITEST_ACCT',
  controller: 'ITEST_CONTROLLER',
};

const ALL_PERSONAS: readonly PersonaName[] = ['admin', 'advisor', 'tech', 'manager', 'parts', 'acct', 'controller'];

type EnvShape = Record<string, string | undefined>;

/**
 * Environment contract for the integration suite (see
 * BACKEND_INTERACTION_TEST_SPEC.md). Collects every configuration problem
 * into a single error so a misconfigured run fails once, with the complete
 * fix, instead of failing variable-by-variable.
 */
export class ItestConfig {
  private constructor(
    readonly baseUrl: string,
    readonly securityServiceUrl: string,
    readonly admin: PersonaCredentials,
    readonly personaCredentials: Partial<Record<CredentialedPersona, PersonaCredentials>>,
    readonly seed: number | undefined,
    readonly waitTimeoutMs: number,
    readonly waitIntervalMs: number,
    /**
     * pos-inventory's staging location. Putaway generation compares a goods
     * receipt's location against it, so suite D needs to know it to book a
     * receipt there. Left undefined unless ITEST_STAGING_LOCATION_ID is set:
     * the suite asks the owning service for the site's declared staging
     * location and falls back the way StagingLocationResolver does, so a
     * constant here would only re-state a backend default this cannot see.
     * Set it to force a specific bin.
     */
    readonly stagingLocationIdOverride: string | undefined,
    /**
     * The shared starter password bulk-provisioned accounts were loaded with
     * (ITEST_SEED_PASSWORD). When set, global setup trades it through
     * activate-starter for every account still awaiting activation, giving each
     * the password configured for it here. See StarterActivation.
     */
    readonly starterPassword: string | undefined,
    /**
     * The tenant every suite runs in (ALPHA_TENANT_SLUG / ALPHA_TENANT_ID). The
     * tunnel host names no tenant, so every login sends the slug, and the
     * direct-to-service bootstrap sends the id as X-Tenant-Id.
     */
    readonly tenant: TenantRef,
    /**
     * The platform tenant (PLATFORM_TENANT_SLUG / PLATFORM_TENANT_ID), which owns
     * the platform tables. Nothing is seeded into it; it is known so the
     * platform login can be checked against it.
     */
    readonly platformTenant: TenantRef | undefined,
    /** Optional platform-tenant login (ITEST_PLATFORM_USERNAME / _PASSWORD). */
    readonly platformCredentials: PersonaCredentials | undefined,
  ) {}

  get mode(): ItestMode {
    return Object.keys(this.personaCredentials).length > 0 ? 'role' : 'single-credential';
  }

  credentialsFor(persona: PersonaName): PersonaCredentials {
    if (persona !== 'admin') {
      const configured = this.personaCredentials[persona];
      if (configured) {
        return configured;
      }
    }
    return this.admin;
  }

  /**
   * Every distinct login the run uses, each with the first persona that names
   * it: unconfigured personas fall back to admin, which is one account.
   */
  distinctAccounts(): Array<{ persona: PersonaName; credentials: PersonaCredentials }> {
    const seen = new Set<string>();
    const accounts: Array<{ persona: PersonaName; credentials: PersonaCredentials }> = [];
    for (const persona of ALL_PERSONAS) {
      const credentials = this.credentialsFor(persona);
      if (!seen.has(credentials.username)) {
        seen.add(credentials.username);
        accounts.push({ persona, credentials });
      }
    }
    return accounts;
  }

  static fromEnv(env: EnvShape = process.env): ItestConfig {
    const problems: string[] = [];

    const username = env['ITEST_USERNAME'];
    const password = env['ITEST_PASSWORD'];
    if (!username) {
      problems.push('ITEST_USERNAME is required');
    }
    if (!password) {
      problems.push('ITEST_PASSWORD is required');
    }

    const optInt = (key: string, options: { positive?: boolean } = {}): number | undefined => {
      const raw = env[key];
      if (raw === undefined) {
        return undefined;
      }
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        problems.push(`${key} must be an integer (got "${raw}")`);
        return undefined;
      }
      if (options.positive && parsed <= 0) {
        problems.push(`${key} must be greater than 0 (got ${parsed})`);
        return undefined;
      }
      return parsed;
    };

    const seed = optInt('ITEST_SEED');
    const waitTimeoutMs = optInt('ITEST_WAIT_TIMEOUT_MS', { positive: true });
    const waitIntervalMs = optInt('ITEST_WAIT_INTERVAL_MS', { positive: true });

    const personaCredentials: Partial<Record<CredentialedPersona, PersonaCredentials>> = {};
    for (const [persona, prefix] of Object.entries(PERSONA_ENV_PREFIX) as Array<
      [CredentialedPersona, string]
    >) {
      const personaUser = env[`${prefix}_USERNAME`];
      const personaPass = env[`${prefix}_PASSWORD`];
      if (personaUser === undefined && personaPass === undefined) {
        continue;
      }
      if (personaUser === undefined) {
        problems.push(`${prefix}_USERNAME is required when ${prefix}_PASSWORD is set`);
        continue;
      }
      if (personaPass === undefined) {
        problems.push(`${prefix}_PASSWORD is required when ${prefix}_USERNAME is set`);
        continue;
      }
      personaCredentials[persona] = { username: personaUser, password: personaPass };
    }

    const tenantPair = (prefix: string, required: boolean): TenantRef | undefined => {
      const slug = env[`${prefix}_TENANT_SLUG`] || undefined;
      const id = env[`${prefix}_TENANT_ID`] || undefined;
      if (slug === undefined && id === undefined) {
        if (required) {
          problems.push(`${prefix}_TENANT_SLUG and ${prefix}_TENANT_ID are required`);
        }
        return undefined;
      }
      if (slug === undefined) {
        problems.push(`${prefix}_TENANT_SLUG is required when ${prefix}_TENANT_ID is set`);
        return undefined;
      }
      if (id === undefined) {
        problems.push(`${prefix}_TENANT_ID is required when ${prefix}_TENANT_SLUG is set`);
        return undefined;
      }
      if (!UUID_PATTERN.test(id)) {
        problems.push(`${prefix}_TENANT_ID must be a UUID (got "${id}")`);
        return undefined;
      }
      return { slug, id: id.toLowerCase() };
    };

    const tenant = tenantPair('ALPHA', true);
    const platformTenant = tenantPair('PLATFORM', false);
    if (tenant && platformTenant && (tenant.id === platformTenant.id || tenant.slug === platformTenant.slug)) {
      problems.push('ALPHA_TENANT_* and PLATFORM_TENANT_* must name different tenants: suites never run in the platform tenant');
    }

    const platformUser = env['ITEST_PLATFORM_USERNAME'] || undefined;
    const platformPass = env['ITEST_PLATFORM_PASSWORD'] || undefined;
    let platformCredentials: PersonaCredentials | undefined;
    if (platformUser !== undefined || platformPass !== undefined) {
      if (platformUser === undefined || platformPass === undefined) {
        problems.push('ITEST_PLATFORM_USERNAME and ITEST_PLATFORM_PASSWORD must be set together');
      } else if (!platformTenant) {
        problems.push('PLATFORM_TENANT_SLUG and PLATFORM_TENANT_ID are required when a platform login is set');
      } else {
        platformCredentials = { username: platformUser, password: platformPass };
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `Integration test configuration is invalid:\n  - ${problems.join('\n  - ')}\n` +
          'See packages/sdk-integration-tests/BACKEND_INTERACTION_TEST_SPEC.md for the environment contract.',
      );
    }

    return new ItestConfig(
      env['ITEST_BASE_URL'] ?? 'http://localhost:8080',
      env['ITEST_SECURITY_SERVICE_URL'] ?? 'http://localhost:8086',
      { username: username as string, password: password as string },
      personaCredentials,
      seed,
      waitTimeoutMs ?? 30000,
      waitIntervalMs ?? 500,
      env['ITEST_STAGING_LOCATION_ID'] || undefined,
      env['ITEST_SEED_PASSWORD'] || undefined,
      tenant as TenantRef,
      platformTenant,
      platformCredentials,
    );
  }
}
