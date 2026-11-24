import { ItestConfig } from './ItestConfig';
import {
  StarterActivation,
  type LoginOutcome,
  type PasswordPolicy,
  type StarterActivationPort,
} from './StarterActivation';

const BASE_ENV = {
  ITEST_USERNAME: 'admin.alpha',
  ITEST_PASSWORD: 'Admin-Passphrase-1',
  ALPHA_TENANT_SLUG: 'alpha',
  ALPHA_TENANT_ID: '01900000-0000-7000-8000-000000000001',
};

const ROLE_ENV = {
  ...BASE_ENV,
  ITEST_SEED_PASSWORD: 'starter-pw',
  ITEST_TECH_USERNAME: 'kyle.brennan',
  ITEST_TECH_PASSWORD: 'Tech-Passphrase-2',
  ITEST_PARTS_USERNAME: 'gloria.mendez',
  ITEST_PARTS_PASSWORD: 'Parts-Passphrase-3',
};

/**
 * A fake auth service: accounts listed in `awaiting` refuse login with
 * INVALID_CREDENTIALS until activated with the right starter password.
 */
function fakePort(options: {
  awaiting?: string[];
  starterPassword?: string;
  failLogin?: Record<string, Error>;
  /** Accounts whose activation "succeeds" without clearing the expiry. */
  stuck?: string[];
  /** Accounts already claimed with a different password: login is refused and so is the exchange. */
  claimed?: string[];
  /** The published policy; defaults to the backend's 12..64, no mixed classes. */
  policy?: PasswordPolicy;
  /** When set, the capabilities read fails with it. */
  policyFailure?: Error;
  /** When set, the exchange refuses every new password with it. */
  activationFailure?: unknown;
}): StarterActivationPort & {
  logins: string[];
  activations: Array<{ username: string; starterPassword: string; newPassword: string }>;
  activationSlugs: string[];
} {
  const awaiting = new Set(options.awaiting ?? []);
  const logins: string[] = [];
  const activations: Array<{ username: string; starterPassword: string; newPassword: string }> = [];
  const activationSlugs: string[] = [];
  return {
    logins,
    activations,
    activationSlugs,
    tryLogin: ({ username }) => {
      logins.push(username);
      const failure = options.failLogin?.[username];
      if (failure) {
        return Promise.reject(failure);
      }
      const refused = awaiting.has(username) || options.claimed?.includes(username);
      return Promise.resolve<LoginOutcome>(refused ? 'refused' : 'ok');
    },
    passwordPolicy: () =>
      options.policyFailure
        ? Promise.reject(options.policyFailure)
        : Promise.resolve(options.policy ?? { minLength: 12, maxLength: 64, requireMixedClasses: false }),
    activate: (username, starterPassword, newPassword, tenantSlug) => {
      activations.push({ username, starterPassword, newPassword });
      activationSlugs.push(tenantSlug);
      if (options.activationFailure !== undefined) {
        return Promise.reject(options.activationFailure);
      }
      if (options.claimed?.includes(username) || starterPassword !== (options.starterPassword ?? 'starter-pw')) {
        return Promise.reject(new Error('401 ACTIVATION_TOKEN_INVALID'));
      }
      if (!options.stuck?.includes(username)) {
        awaiting.delete(username);
      }
      return Promise.resolve();
    },
  };
}

describe('StarterActivation', () => {
  it('does not apply without ITEST_SEED_PASSWORD', async () => {
    const port = fakePort({});
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...BASE_ENV }), port);

    expect(activation.applies).toBe(false);
    await expect(activation.run()).resolves.toEqual({ activated: [], alreadyActive: [] });
    expect(port.logins).toEqual([]);
  });

  it('activates only the accounts awaiting activation, each to its own configured password', async () => {
    const port = fakePort({ awaiting: ['kyle.brennan', 'gloria.mendez'] });
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port);

    const result = await activation.run();

    expect(result.alreadyActive).toEqual(['admin=admin.alpha']);
    expect(result.activated).toEqual(['tech=kyle.brennan', 'parts=gloria.mendez']);
    expect(port.activations).toEqual([
      { username: 'kyle.brennan', starterPassword: 'starter-pw', newPassword: 'Tech-Passphrase-2' },
      { username: 'gloria.mendez', starterPassword: 'starter-pw', newPassword: 'Parts-Passphrase-3' },
    ]);
  });

  it('logs each distinct account in once, however many personas fall back to it', async () => {
    const port = fakePort({});
    await new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port).run();

    // advisor, manager, acct and controller are unconfigured and resolve to admin.
    expect(port.logins).toEqual(['admin.alpha', 'kyle.brennan', 'gloria.mendez']);
    expect(port.activations).toEqual([]);
  });

  it('never activates an account whose login fails for another reason, and names every problem at once', async () => {
    const port = fakePort({
      awaiting: ['gloria.mendez'],
      starterPassword: 'a-different-starter',
      failLogin: { 'kyle.brennan': new Error('401 ACCOUNT_LOCKED') },
    });
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port);

    const failure = activation.run();

    await expect(failure).rejects.toThrow(/tech: "kyle.brennan" cannot log in \(401 ACCOUNT_LOCKED\)/);
    await expect(failure).rejects.toThrow(/parts: "gloria.mendez" refused login, and the starter exchange was refused too/);
    expect(port.activations.map((a) => a.username)).toEqual(['gloria.mendez']);
  });

  it('fails when the configured password is still refused after activation', async () => {
    const port = fakePort({ awaiting: ['kyle.brennan'], stuck: ['kyle.brennan'] });
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port);

    await expect(activation.run()).rejects.toThrow(/"kyle.brennan" was activated but its configured password is still refused/);
  });

  it('reports an account already claimed with another password, without changing it', async () => {
    const port = fakePort({ claimed: ['gloria.mendez'] });
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port);

    await expect(activation.run()).rejects.toThrow(/already claimed with a password other than the configured one/);
    expect(port.activations.map((a) => a.username)).toEqual(['gloria.mendez']);
    expect(port.logins.filter((username) => username === 'gloria.mendez')).toHaveLength(1);
  });

  it('activates the platform login in the platform tenant when one is configured', async () => {
    const port = fakePort({ awaiting: ['kyle.brennan', 'admin.platform'] });
    const config = ItestConfig.fromEnv({
      ...ROLE_ENV,
      PLATFORM_TENANT_SLUG: 'platform',
      PLATFORM_TENANT_ID: '01900000-0000-7000-8000-000000000000',
      ITEST_PLATFORM_USERNAME: 'admin.platform',
      ITEST_PLATFORM_PASSWORD: 'Operator-Passphrase-4',
    });

    const result = await new StarterActivation(config, port).run();

    expect(result.activated).toEqual(['tech=kyle.brennan', 'platform=admin.platform']);
    expect(port.activationSlugs).toEqual(['alpha', 'platform']);
    expect(port.activations.at(-1)).toEqual({
      username: 'admin.platform',
      starterPassword: 'starter-pw',
      newPassword: 'Operator-Passphrase-4',
    });
  });
  describe('password policy preflight', () => {
    afterEach(() => jest.restoreAllMocks());

    const run = (env: Record<string, string>, options: Parameters<typeof fakePort>[0] = {}) => {
      const port = fakePort(options);
      return { port, result: new StarterActivation(ItestConfig.fromEnv(env), port).run() };
    };

    it('lets compliant passwords through to login', async () => {
      const { port, result } = run({ ...ROLE_ENV }, { policy: { minLength: 12, maxLength: 64, requireMixedClasses: true } });

      await expect(result).resolves.toEqual({
        activated: [],
        alreadyActive: ['admin=admin.alpha', 'tech=kyle.brennan', 'parts=gloria.mendez'],
      });
      expect(port.logins).toHaveLength(3);
    });

    it('refuses a password shorter than minLength, naming persona, username and rule but not the password', async () => {
      const { port, result } = run({ ...ROLE_ENV, ITEST_TECH_PASSWORD: 'short-pw' });

      await expect(result).rejects.toThrow(/tech: "kyle.brennan" breaks MIN_LENGTH \(use at least 12 characters\)/);
      await expect(result).rejects.not.toThrow(/short-pw/);
      expect(port.logins).toEqual([]);
      expect(port.activations).toEqual([]);
    });

    it('counts length in code points', async () => {
      // 11 astral characters are 22 UTF-16 units but 11 code points: still too short.
      const { result } = run({ ...ROLE_ENV, ITEST_TECH_PASSWORD: '\u{1F600}'.repeat(11) });

      await expect(result).rejects.toThrow(/tech: "kyle.brennan" breaks MIN_LENGTH/);
    });

    it('refuses a password longer than maxLength', async () => {
      const { port, result } = run({ ...ROLE_ENV, ITEST_PARTS_PASSWORD: 'x'.repeat(20) }, {
        policy: { minLength: 12, maxLength: 16, requireMixedClasses: false },
      });

      await expect(result).rejects.toThrow(/parts: "gloria.mendez" breaks MAX_LENGTH \(use at most 16 characters/);
      expect(port.logins).toEqual([]);
    });

    it('refuses a password containing the username, case-insensitively', async () => {
      const { result } = run({ ...ROLE_ENV, ITEST_TECH_PASSWORD: 'My-KYLE.BRENNAN-pass' });

      await expect(result).rejects.toThrow(/tech: "kyle.brennan" breaks CONTEXT/);
    });

    it('refuses a password containing the e-mail local part of an e-mail username', async () => {
      const { result } = run({
        ...ROLE_ENV,
        ITEST_TECH_USERNAME: 'kyle@example.com',
        ITEST_TECH_PASSWORD: 'hello-kyle-2026',
      });

      await expect(result).rejects.toThrow(/tech: "kyle@example.com" breaks CONTEXT/);
    });

    it('refuses a password containing the tenant slug', async () => {
      const { result } = run({ ...ROLE_ENV, ALPHA_TENANT_SLUG: 'acme-motors', ITEST_PARTS_PASSWORD: 'Acme-Motors-Rocks' });

      await expect(result).rejects.toThrow(/parts: "gloria.mendez" breaks CONTEXT/);
    });

    it('only refuses a short term when the password equals it', async () => {
      // The slug "alpha" is 5 characters; "abc" is under the 4-character floor and does not count.
      const { result } = run({
        ...ROLE_ENV,
        ALPHA_TENANT_SLUG: 'abc',
        ITEST_PARTS_PASSWORD: 'abc-is-in-here-but-short',
      });

      await expect(result).resolves.toBeDefined();
    });

    it('requires three character classes when the policy does', async () => {
      const { port, result } = run({ ...ROLE_ENV, ITEST_TECH_PASSWORD: 'lowercaseonlyletters' }, {
        policy: { minLength: 12, maxLength: 64, requireMixedClasses: true },
      });

      await expect(result).rejects.toThrow(/tech: "kyle.brennan" breaks MIXED_CLASSES/);
      expect(port.logins).toEqual([]);
    });

    it('names every violation at once', async () => {
      const { result } = run({ ...ROLE_ENV, ITEST_TECH_PASSWORD: 'tiny', ITEST_PARTS_PASSWORD: 'gloria.mendez!!' });

      await expect(result).rejects.toThrow(/tech: "kyle.brennan" breaks MIN_LENGTH[\s\S]*parts: "gloria.mendez" breaks CONTEXT/);
    });

    it('falls back to the login-first flow with a warning when the capabilities read fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { port, result } = run({ ...ROLE_ENV, ITEST_TECH_PASSWORD: 'short-pw' }, {
        policyFailure: new Error('503 unavailable'),
      });

      await expect(result).resolves.toBeDefined();
      expect(port.logins).toEqual(['admin.alpha', 'kyle.brennan', 'gloria.mendez']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipping the password preflight/));
    });
  });

  describe('exchange refusals', () => {
    const httpError = (status: number, body: object) => ({
      response: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    });

    it('reports a 400 PASSWORD_POLICY_VIOLATION as a policy refusal with the server message', async () => {
      const port = fakePort({
        awaiting: ['kyle.brennan'],
        activationFailure: httpError(400, {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          status: 400,
          fieldErrors: [{ field: 'newPassword', message: 'PASSWORD_POLICY_VIOLATION: this password is too common; choose a less predictable one' }],
        }),
      });
      const failure = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port).run();

      await expect(failure).rejects.toThrow(
        /tech: "kyle.brennan" refused login, and the starter exchange refused its configured password under the password policy \(PASSWORD_POLICY_VIOLATION: this password is too common/,
      );
      await expect(failure).rejects.not.toThrow(/already claimed/);
    });

    it('recognises the code at the top level of the envelope', async () => {
      const port = fakePort({
        awaiting: ['kyle.brennan'],
        activationFailure: httpError(400, {
          code: 'PASSWORD_POLICY_VIOLATION',
          message: 'PASSWORD_POLICY_VIOLATION: must not contain your username, email, name or organization',
          status: 400,
        }),
      });

      await expect(new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port).run()).rejects.toThrow(
        /under the password policy \(PASSWORD_POLICY_VIOLATION: must not contain your username/,
      );
    });

    it('keeps reporting a 401 as a wrong starter password or a claimed account', async () => {
      const port = fakePort({
        awaiting: ['kyle.brennan'],
        activationFailure: httpError(401, { code: 'ACTIVATION_TOKEN_INVALID', status: 401 }),
      });
      const failure = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port).run();

      await expect(failure).rejects.toThrow(/already claimed with a password other than the configured one/);
      await expect(failure).rejects.toThrow(/HTTP 401: .*ACTIVATION_TOKEN_INVALID/);
      await expect(failure).rejects.not.toThrow(/password policy/);
    });
  });
});
