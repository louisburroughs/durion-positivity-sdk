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

const PERSONA_ENV_PREFIX: Record<CredentialedPersona, string> = {
  advisor: 'ITEST_ADVISOR',
  tech: 'ITEST_TECH',
  manager: 'ITEST_MANAGER',
  parts: 'ITEST_PARTS',
  acct: 'ITEST_ACCT',
  controller: 'ITEST_CONTROLLER',
};

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
     * receipt there. The default is the default of
     * POS_INVENTORY_RECEIVING_STAGING_LOCATION_ID, which is what alpha and a
     * stock local Compose stack both use; an environment that overrode it must
     * set ITEST_STAGING_LOCATION_ID to match.
     */
    readonly stagingLocationId: string,
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
      env['ITEST_STAGING_LOCATION_ID'] ?? '00000000-0000-0000-0000-000000000002',
    );
  }
}
