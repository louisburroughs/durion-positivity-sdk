import { ItestConfig } from './ItestConfig';
import { StarterActivation, type LoginOutcome, type StarterActivationPort } from './StarterActivation';

const BASE_ENV = {
  ITEST_USERNAME: 'admin.alpha',
  ITEST_PASSWORD: 'admin-pw',
  ALPHA_TENANT_SLUG: 'alpha',
  ALPHA_TENANT_ID: '01900000-0000-7000-8000-000000000001',
};

const ROLE_ENV = {
  ...BASE_ENV,
  ITEST_SEED_PASSWORD: 'starter-pw',
  ITEST_TECH_USERNAME: 'kyle.brennan',
  ITEST_TECH_PASSWORD: 'tech-pw',
  ITEST_PARTS_USERNAME: 'gloria.mendez',
  ITEST_PARTS_PASSWORD: 'parts-pw',
};

/**
 * A fake auth service: accounts listed in `awaiting` refuse login with
 * CREDENTIALS_EXPIRED until activated with the right starter password.
 */
function fakePort(options: {
  awaiting?: string[];
  starterPassword?: string;
  failLogin?: Record<string, Error>;
  /** Accounts whose activation "succeeds" without clearing the expiry. */
  stuck?: string[];
}): StarterActivationPort & {
  logins: string[];
  activations: Array<{ username: string; starterPassword: string; newPassword: string }>;
} {
  const awaiting = new Set(options.awaiting ?? []);
  const logins: string[] = [];
  const activations: Array<{ username: string; starterPassword: string; newPassword: string }> = [];
  return {
    logins,
    activations,
    tryLogin: ({ username }) => {
      logins.push(username);
      const failure = options.failLogin?.[username];
      if (failure) {
        return Promise.reject(failure);
      }
      return Promise.resolve<LoginOutcome>(awaiting.has(username) ? 'credentials-expired' : 'ok');
    },
    activate: (username, starterPassword, newPassword) => {
      activations.push({ username, starterPassword, newPassword });
      if (starterPassword !== (options.starterPassword ?? 'starter-pw')) {
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
      { username: 'kyle.brennan', starterPassword: 'starter-pw', newPassword: 'tech-pw' },
      { username: 'gloria.mendez', starterPassword: 'starter-pw', newPassword: 'parts-pw' },
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
      failLogin: { 'kyle.brennan': new Error('401 INVALID_CREDENTIALS') },
    });
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port);

    const failure = activation.run();

    await expect(failure).rejects.toThrow(/tech: "kyle.brennan" cannot log in \(401 INVALID_CREDENTIALS\)/);
    await expect(failure).rejects.toThrow(/parts: "gloria.mendez" awaits activation but the starter exchange was refused/);
    expect(port.activations.map((a) => a.username)).toEqual(['gloria.mendez']);
  });

  it('fails when login still reports CREDENTIALS_EXPIRED after activation', async () => {
    const port = fakePort({ awaiting: ['kyle.brennan'], stuck: ['kyle.brennan'] });
    const activation = new StarterActivation(ItestConfig.fromEnv({ ...ROLE_ENV }), port);

    await expect(activation.run()).rejects.toThrow(/"kyle.brennan" was activated but login still reports CREDENTIALS_EXPIRED/);
  });
});
