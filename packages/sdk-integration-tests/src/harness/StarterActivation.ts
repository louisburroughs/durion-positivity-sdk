// Imported by path, not by package name, for the reason globalSetup.ts spells
// out: Jest applies moduleNameMapper to the suites but NOT to globalSetup, and
// this module is reached from there.
import { createSecurityClient } from '../../../sdk-security/src';
import { formatError } from './http';
import type { ItestConfig, PersonaCredentials } from './ItestConfig';

/**
 * Starter-credential activation (README: "Starter credentials must be
 * activated before login").
 *
 * A bulk-provisioned account is loaded with one shared starter password and
 * login refuses it (401 CREDENTIALS_EXPIRED) until that password is traded
 * through POST /v1/auth/activate-starter. This runs first in global setup and
 * gives every account the password .env.itest records for it.
 *
 * Login is attempted before activation, never the other way round: activation
 * answers one uninformative 401 for an unknown account, a wrong starter
 * password and an account already claimed, so on a re-run against an activated
 * environment it could not tell success from misconfiguration. The login that
 * succeeds says so plainly.
 */

export type LoginOutcome = 'ok' | 'credentials-expired';

/** The two auth calls activation needs, behind a port so it tests without HTTP. */
export interface StarterActivationPort {
  /**
   * Resolves 'credentials-expired' only for 401 CREDENTIALS_EXPIRED - the state
   * activation clears. Every other refusal rejects: a wrong password or a
   * locked account is not something activation should paper over.
   */
  tryLogin(credentials: PersonaCredentials): Promise<LoginOutcome>;
  activate(username: string, starterPassword: string, newPassword: string): Promise<void>;
}

export interface StarterActivationResult {
  activated: string[];
  alreadyActive: string[];
}

export class StarterActivation {
  constructor(
    private readonly config: ItestConfig,
    private readonly port: StarterActivationPort,
  ) {}

  /** Only when a starter password is configured is there anything to exchange. */
  get applies(): boolean {
    return this.config.starterPassword !== undefined;
  }

  async run(): Promise<StarterActivationResult> {
    const activated: string[] = [];
    const alreadyActive: string[] = [];
    const starterPassword = this.config.starterPassword;
    if (starterPassword === undefined) {
      return { activated, alreadyActive };
    }

    const problems: string[] = [];
    // In single-credential mode, and for any persona left unconfigured, every
    // persona resolves to the admin login. It is one account, so one exchange.
    for (const { persona, credentials } of this.config.distinctAccounts()) {
      const { username } = credentials;

      let outcome: LoginOutcome;
      try {
        outcome = await this.port.tryLogin(credentials);
      } catch (error) {
        problems.push(`${persona}: "${username}" cannot log in (${await formatError(error)})`);
        continue;
      }
      if (outcome === 'ok') {
        alreadyActive.push(`${persona}=${username}`);
        continue;
      }

      try {
        await this.port.activate(username, starterPassword, credentials.password);
      } catch (error) {
        problems.push(
          `${persona}: "${username}" awaits activation but the starter exchange was refused ` +
            `(${await formatError(error)}) - check ITEST_SEED_PASSWORD and ALPHA_TENANT_SLUG`,
        );
        continue;
      }

      // Activation issues no token, so only a login proves the new password took.
      try {
        outcome = await this.port.tryLogin(credentials);
      } catch (error) {
        problems.push(`${persona}: "${username}" was activated but cannot log in (${await formatError(error)})`);
        continue;
      }
      if (outcome !== 'ok') {
        problems.push(`${persona}: "${username}" was activated but login still reports CREDENTIALS_EXPIRED`);
        continue;
      }
      activated.push(`${persona}=${username}`);
    }

    if (problems.length > 0) {
      throw new Error(`Starter activation failed:\n  - ${problems.join('\n  - ')}`);
    }
    return { activated, alreadyActive };
  }
}

/**
 * Builds the port against the gateway's security-service route, the same path
 * SeederAuth logs in through. Both calls are unauthenticated.
 */
export function createStarterActivationPort(config: ItestConfig): StarterActivationPort {
  const { authAPIApi } = createSecurityClient({ baseUrl: `${config.baseUrl}/security-service` });
  const tenantSlug = config.tenant.slug;

  return {
    async tryLogin({ username, password }: PersonaCredentials): Promise<LoginOutcome> {
      try {
        await authAPIApi.loginUser({ loginRequest: { username, password, tenantSlug } });
        return 'ok';
      } catch (error) {
        if (await isCredentialsExpired(error)) {
          return 'credentials-expired';
        }
        throw error;
      }
    },
    async activate(username: string, starterPassword: string, newPassword: string): Promise<void> {
      // The payload nests under activateWithStarterRequest; passing it flat
      // throws RequiredError before any request is sent.
      await authAPIApi.activateAccountWithStarterPassword({
        activateWithStarterRequest: { username, starterPassword, newPassword, tenantSlug },
        xTenantSlug: tenantSlug,
      });
    },
  };
}

async function isCredentialsExpired(error: unknown): Promise<boolean> {
  const response = (error as { response?: Response } | undefined)?.response;
  if (response?.status !== 401) {
    return false;
  }
  try {
    // Cloned so a rethrown error still carries an unread body for formatError.
    return (await response.clone().text()).includes('CREDENTIALS_EXPIRED');
  } catch {
    return false;
  }
}
