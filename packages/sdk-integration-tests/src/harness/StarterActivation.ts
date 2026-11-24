// Imported by path, not by package name, for the reason globalSetup.ts spells
// out: Jest applies moduleNameMapper to the suites but NOT to globalSetup, and
// this module is reached from there.
import { createSecurityClient } from '../../../sdk-security/src';
import { formatError, httpStatusOf, readErrorBody } from './http';
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
 *
 * Before any login, every configured password is checked against the platform
 * password policy (see {@link passwordPolicyViolations}). A password the
 * exchange would refuse with 400 PASSWORD_POLICY_VIOLATION is reported up front,
 * so no failed login is spent on an account (5 in 10 minutes lock it) for a
 * password that could never be set.
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
  tryLogin(credentials: PersonaCredentials, tenantSlug: string): Promise<LoginOutcome>;
  activate(username: string, starterPassword: string, newPassword: string, tenantSlug: string): Promise<void>;
  /** The deployment's password policy, as GET /v1/auth/capabilities publishes it. */
  passwordPolicy(tenantSlug: string): Promise<PasswordPolicy>;
}

/** The published part of the platform password policy (passwordPolicy on getAuthCapabilities). */
export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireMixedClasses: boolean;
}

/** The rule a configured password breaks, named as the backend's PasswordPolicy.Rule names it. */
export type PasswordRule = 'MIN_LENGTH' | 'MAX_LENGTH' | 'MIXED_CLASSES' | 'CONTEXT';

/** BCrypt hashes at most this many bytes, so the backend refuses longer input as too long. */
const MAX_UTF8_BYTES = 72;
/** A context term shorter than this is refused only when the password equals it. */
const MIN_CONTAINED_TERM_LENGTH = 4;
const MIXED_CLASSES_REQUIRED = 3;

/** trim + lower-case, as the backend's PasswordPolicy.normalise (Locale.ROOT). */
const normalise = (value: string): string => value.trim().toLowerCase();
const codePointCount = (value: string): number => Array.from(value).length;

/** Character.isLowerCase / isUpperCase / isDigit, and "none of those", as the backend counts them. */
function characterClasses(value: string): number {
  const chars = Array.from(value);
  const lower = (c: string) => /\p{Lowercase}/u.test(c);
  const upper = (c: string) => /\p{Uppercase}/u.test(c);
  const digit = (c: string) => /\p{Nd}/u.test(c);
  return [
    chars.some(lower),
    chars.some(upper),
    chars.some(digit),
    chars.some((c) => !lower(c) && !upper(c) && !digit(c)),
  ].filter(Boolean).length;
}

/** The email local part (before the last '@'), as PasswordPolicy.emailLocalPart. */
function emailLocalPart(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? email : email.substring(0, at);
}

/**
 * The rules a candidate breaks, mirroring the backend's PasswordPolicy
 * (pos-security-service internal/validation): length in code points within
 * min/max and at most 72 UTF-8 bytes, three of four character classes when
 * required, and the context rule — the password must not equal any term, nor
 * contain one of 4 or more characters, compared trimmed and case-insensitively.
 * The terms here are the username, its e-mail local part when the username is
 * an e-mail, and the tenant slug; the backend may also hold the person's name,
 * which the harness does not know.
 *
 * The common-password denylist stays server-side (it is never published), so a
 * password that passes here can still be refused as too common by the exchange.
 */
export function passwordPolicyViolations(
  password: string,
  policy: PasswordPolicy,
  contextTerms: readonly string[],
): Array<{ rule: PasswordRule; fix: string }> {
  const violations: Array<{ rule: PasswordRule; fix: string }> = [];
  const length = codePointCount(password);
  if (length < policy.minLength) {
    violations.push({ rule: 'MIN_LENGTH', fix: `use at least ${policy.minLength} characters` });
  } else if (length > policy.maxLength || Buffer.byteLength(password, 'utf8') > MAX_UTF8_BYTES) {
    violations.push({
      rule: 'MAX_LENGTH',
      fix: `use at most ${policy.maxLength} characters (and ${MAX_UTF8_BYTES} bytes in UTF-8)`,
    });
  }
  if (policy.requireMixedClasses && characterClasses(password) < MIXED_CLASSES_REQUIRED) {
    violations.push({
      rule: 'MIXED_CLASSES',
      fix: 'use at least three of lower-case letters, upper-case letters, digits and other characters',
    });
  }
  const value = normalise(password);
  for (const term of contextTerms) {
    const normalisedTerm = normalise(term);
    if (normalisedTerm === '') {
      continue;
    }
    const contained = codePointCount(normalisedTerm) >= MIN_CONTAINED_TERM_LENGTH && value.includes(normalisedTerm);
    if (contained || value === normalisedTerm) {
      violations.push({ rule: 'CONTEXT', fix: 'must not contain the username, e-mail local part or tenant slug' });
      break;
    }
  }
  return violations;
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
    const accounts = this.config.distinctAccounts().map(({ persona, credentials }) => ({
      persona: persona as string,
      credentials,
      tenantSlug: this.config.tenant.slug,
    }));
    // The platform login lives in the platform tenant, so it is activated there.
    if (this.config.platformCredentials && this.config.platformTenant) {
      accounts.push({
        persona: 'platform',
        credentials: this.config.platformCredentials,
        tenantSlug: this.config.platformTenant.slug,
      });
    }

    // Preflight: no login is attempted while any configured password would be
    // refused by the exchange.
    let policy: PasswordPolicy | undefined;
    try {
      policy = await this.port.passwordPolicy(this.config.tenant.slug);
    } catch (error) {
      console.warn(
        `[starter-activation] could not read the password policy (${await formatError(error)}); ` +
          'skipping the password preflight',
      );
    }
    if (policy !== undefined) {
      const refusals: string[] = [];
      for (const { persona, credentials, tenantSlug } of accounts) {
        const { username, password } = credentials;
        const terms = [username, tenantSlug];
        if (username.includes('@')) {
          terms.push(emailLocalPart(username));
        }
        for (const { rule, fix } of passwordPolicyViolations(password, policy, terms)) {
          refusals.push(`${persona}: "${username}" breaks ${rule} (${fix})`);
        }
      }
      if (refusals.length > 0) {
        throw new Error(
          `Starter activation preflight failed: a configured ITEST_*_PASSWORD does not meet the password policy ` +
            `(${policy.minLength} to ${policy.maxLength} characters` +
            `${policy.requireMixedClasses ? ', three of four character classes' : ''}, ` +
            `not containing the username or tenant slug). No login was attempted.\n  - ${refusals.join('\n  - ')}`,
        );
      }
    }

    for (const { persona, credentials, tenantSlug } of accounts) {
      const { username } = credentials;

      let outcome: LoginOutcome;
      try {
        outcome = await this.port.tryLogin(credentials, tenantSlug);
      } catch (error) {
        problems.push(`${persona}: "${username}" cannot log in (${await formatError(error)})`);
        continue;
      }
      if (outcome === 'ok') {
        alreadyActive.push(`${persona}=${username}`);
        continue;
      }

      try {
        await this.port.activate(username, starterPassword, credentials.password, tenantSlug);
      } catch (error) {
        const policyRefusal = await passwordPolicyRefusal(error);
        if (policyRefusal !== undefined) {
          problems.push(
            `${persona}: "${username}" refused login, and the starter exchange refused its configured password ` +
              `under the password policy (${policyRefusal}). Choose another ITEST_*_PASSWORD for it; the starter ` +
              `password was not checked`,
          );
          continue;
        }
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
        outcome = await this.port.tryLogin(credentials, tenantSlug);
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

  return {
    async tryLogin({ username, password }: PersonaCredentials, tenantSlug: string): Promise<LoginOutcome> {
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
    async activate(username: string, starterPassword: string, newPassword: string, tenantSlug: string): Promise<void> {
      // The payload nests under activateWithStarterRequest; passing it flat
      // throws RequiredError before any request is sent.
      await authAPIApi.activateAccountWithStarterPassword({
        activateWithStarterRequest: { username, starterPassword, newPassword, tenantSlug },
        xTenantSlug: tenantSlug,
      });
    },
    async passwordPolicy(tenantSlug: string): Promise<PasswordPolicy> {
      // The read is deployment-wide and tenant-blind; the slug only names the
      // tenant host the way the other two calls do.
      const { passwordPolicy } = await authAPIApi.getAuthCapabilities({ headers: { 'X-Tenant-Slug': tenantSlug } });
      return {
        minLength: passwordPolicy.minLength,
        maxLength: passwordPolicy.maxLength,
        requireMixedClasses: passwordPolicy.requireMixedClasses,
      };
    },
  };
}

const POLICY_CODE = 'PASSWORD_POLICY_VIOLATION';

/**
 * The server's message when the exchange refused the new password under the
 * policy: 400 with code PASSWORD_POLICY_VIOLATION, or 400 VALIDATION_ERROR with
 * a fieldErrors message (or the top-level message) starting with it. Undefined
 * for every other refusal. The body is read as formatError reads it, so a later
 * formatError still sees it.
 */
export async function passwordPolicyRefusal(error: unknown): Promise<string | undefined> {
  if (httpStatusOf(error) !== 400) {
    return undefined;
  }
  const text = await readErrorBody(error);
  if (text === undefined) {
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text.includes(POLICY_CODE) ? text : undefined;
  }
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const { code, message, fieldErrors } = body as { code?: unknown; message?: unknown; fieldErrors?: unknown };
  const fieldMessage = Array.isArray(fieldErrors)
    ? fieldErrors
        .map((entry) => (entry as { message?: unknown } | null)?.message)
        .find((m): m is string => typeof m === 'string' && m.startsWith(POLICY_CODE))
    : undefined;
  if (fieldMessage !== undefined) {
    return fieldMessage;
  }
  if (typeof message === 'string' && message.startsWith(POLICY_CODE)) {
    return message;
  }
  if (code === POLICY_CODE) {
    return typeof message === 'string' && message !== '' ? message : POLICY_CODE;
  }
  return undefined;
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
