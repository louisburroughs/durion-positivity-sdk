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
 * cannot log in until that password is traded through
 * POST /v1/auth/activate-starter. This runs first in global setup and gives
 * every account the password .env.itest records for it.
 *
 * Such an account answers login with 401 INVALID_CREDENTIALS, not
 * CREDENTIALS_EXPIRED: Spring checks credential expiry only after a password
 * matches, and nothing matches an unclaimed account's password. A refused login
 * therefore cannot tell "awaiting activation" from "wrong password"; the
 * exchange is what tells them apart. It changes nothing unless the account is
 * still awaiting activation and the starter password matches, so attempting it
 * on a refused login is safe.
 *
 * Login is still attempted first: an account that already logs in is left
 * alone, which is what makes a re-run against an activated environment safe.
 */

export type LoginOutcome = 'ok' | 'refused';

/** The two auth calls activation needs, behind a port so it tests without HTTP. */
export interface StarterActivationPort {
  /**
   * Resolves 'refused' for 401 INVALID_CREDENTIALS or CREDENTIALS_EXPIRED, the
   * answers an account awaiting activation can give. Every other refusal
   * rejects: a locked or disabled account is not something activation should
   * paper over.
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
          `${persona}: "${username}" refused login, and the starter exchange was refused too ` +
            `(${await formatError(error)}). Either the account was already claimed with a password other than ` +
            `the configured one, or ITEST_SEED_PASSWORD / ALPHA_TENANT_SLUG is wrong. Each run adds a failed ` +
            `login, and 5 within 10 minutes locks the account`,
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
        problems.push(`${persona}: "${username}" was activated but its configured password is still refused`);
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
        if (await isRefusedLogin(error)) {
          return 'refused';
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

async function isRefusedLogin(error: unknown): Promise<boolean> {
  const response = (error as { response?: Response } | undefined)?.response;
  if (response?.status !== 401) {
    return false;
  }
  try {
    // Cloned so a rethrown error still carries an unread body for formatError.
    return /"code"\s*:\s*"(INVALID_CREDENTIALS|CREDENTIALS_EXPIRED)"/.test(await response.clone().text());
  } catch {
    return false;
  }
}
