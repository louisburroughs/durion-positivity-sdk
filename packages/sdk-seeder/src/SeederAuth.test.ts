import { SeederAuth, renewAllAuths, resetAuthStateForTests } from './SeederAuth';
import { SeederConfig } from './SeederConfig';

/**
 * The defect these cover, in one sentence: token lifetimes are minted in the
 * backend's seconds, and under the accelerated profile those run thousands of
 * times faster than this process's, so a deadline computed from `Date.now()` plus
 * a constant is wrong by that factor.
 *
 * Only a unit test can hold this. A live accelerated run is six hours long, needs
 * a booked window on a shared alpha, and fails with a bare 401 that says nothing
 * about which clock was consulted.
 */

/** A JWT with the claims this code reads and nothing else. Never verified. */
const jwt = (claims: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

/**
 * An access/refresh pair minted at `iat` in the backend's own seconds.
 *
 * Every pair is distinct, because a real mint is: the backend rotates the pair on
 * refresh, and code that asks "did the token actually change" cannot be tested by
 * a stub that hands back the same string forever.
 */
let mintCounter = 0;
const tokens = (iat: number, accessTtlSec: number, refreshTtlSec: number) => {
  mintCounter += 1;
  return {
    accessToken: jwt({ iat, exp: iat + accessTtlSec, jti: `access-${mintCounter}` }),
    refreshToken: jwt({ iat, exp: iat + refreshTtlSec, jti: `refresh-${mintCounter}` }),
  };
};

const HOUR_SEC = 3600;
const WEEK_SEC = 7 * 24 * HOUR_SEC;

const config = (): SeederConfig =>
  SeederConfig.fromValues({
    baseUrl: 'http://localhost:18080',
    username: 'admin.alpha',
    password: 'secret',
    tenantSlug: 'alpha',
  });

interface FakeWorkflow {
  login: jest.Mock;
  refresh: jest.Mock;
}

/** Replaces the network-backed workflow and returns the spies. */
const stub = (auth: SeederAuth, workflow: FakeWorkflow): FakeWorkflow => {
  (auth as unknown as { workflow: FakeWorkflow }).workflow = workflow;
  return workflow;
};

/** Makes the scale probe answer as an accelerated backend at `scale`. */
const backendAt = (scale: number | null): void => {
  resetAuthStateForTests();
  global.fetch = jest.fn(async () =>
    scale === null
      ? ({ ok: false, status: 404 } as unknown as Response)
      : ({ ok: true, json: async () => ({ scale, accelerated: true }) } as unknown as Response),
  ) as unknown as typeof fetch;
};

const freshAuth = async (scale: number | null, minted?: ReturnType<typeof tokens>) => {
  backendAt(scale);
  const auth = new SeederAuth(config());
  const mint = () => minted ?? tokens(1_000_000, HOUR_SEC, WEEK_SEC);
  const workflow = stub(auth, {
    login: jest.fn(async () => mint()),
    refresh: jest.fn(async () => mint()),
  });
  await auth.login();
  return { auth, workflow };
};

describe('SeederAuth — token lifetime against the backend clock', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetAuthStateForTests();
    jest.useRealTimers();
  });

  it('measures an hour token as an hour on an ordinary clock', async () => {
    const { auth, workflow } = await freshAuth(null);
    const state = (auth as unknown as { state: { token: { renewAt: number } } }).state.token;

    // Renewal at half of one real hour, give or take the time the test took.
    expect(state.renewAt - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(state.renewAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);

    await auth.refreshIfNeeded();
    expect(workflow.refresh).not.toHaveBeenCalled();
  });

  it('measures the same hour token as 1.2 seconds at scale 2920', async () => {
    // The live failure: an hour of the backend's seconds is 3600/2920 of ours, so
    // the token is dead about a second after the login that minted it returned.
    const { auth } = await freshAuth(2920);
    const state = (auth as unknown as { state: { token: { accessExpiresAt: number; renewAt: number } } }).state.token;

    const lifetimeMs = state.accessExpiresAt - Date.now();
    expect(lifetimeMs).toBeGreaterThan(1_100);
    expect(lifetimeMs).toBeLessThan(1_300);
    // Renewal is due at half of that, not a minute before a ten-hour deadline.
    expect(state.renewAt - Date.now()).toBeLessThan(700);
  });

  it('renews once the token is half spent, and not before', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const { auth, workflow } = await freshAuth(2920);

    await auth.refreshIfNeeded();
    expect(workflow.refresh).not.toHaveBeenCalled();

    jest.advanceTimersByTime(800);
    await auth.refreshIfNeeded();
    expect(workflow.refresh).toHaveBeenCalledTimes(1);
  });

  it('logs in again once the refresh token is itself spent', async () => {
    // A week of refresh validity is under four real minutes at this scale, so the
    // run spends most of its life past it. Refreshing anyway costs a round trip to
    // be told what the clock already knew.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const { auth, workflow } = await freshAuth(2920);

    jest.advanceTimersByTime(WEEK_SEC * 1000 / 2920 + 1_000);
    await auth.refreshIfNeeded();

    expect(workflow.refresh).not.toHaveBeenCalled();
    expect(workflow.login).toHaveBeenCalledTimes(2);
  });

  it('falls back to a full login when the refresh is refused', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const { auth, workflow } = await freshAuth(2920);
    workflow.refresh.mockRejectedValueOnce(new Error('refresh token revoked'));

    jest.advanceTimersByTime(800);
    await auth.refreshIfNeeded();

    expect(workflow.refresh).toHaveBeenCalledTimes(1);
    expect(workflow.login).toHaveBeenCalledTimes(2);
  });

  it('renews once however many callers ask at the same moment', async () => {
    // Every request asks before it goes out, and the run works several bays at once.
    // Without the single-flight guard each caller mints a token that invalidates the
    // one the caller beside it just took.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const { auth, workflow } = await freshAuth(2920);

    jest.advanceTimersByTime(800);
    await Promise.all(Array.from({ length: 8 }, () => auth.refreshIfNeeded()));

    expect(workflow.refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes from inside the token callback, immediately before a request', async () => {
    // The only place that can know a token is still good is the moment it is used.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    const { auth, workflow } = await freshAuth(2920);
    const supply = auth.buildSdkConfig('security-service').token;
    expect(supply).toBeDefined();

    jest.advanceTimersByTime(800);
    await supply?.();

    expect(workflow.refresh).toHaveBeenCalledTimes(1);
  });

  it('treats a token with no iat/exp as its documented lifetime', async () => {
    const { auth } = await freshAuth(2920, {
      accessToken: 'not.a.jwt',
      refreshToken: 'not.a.jwt',
    } as ReturnType<typeof tokens>);
    const state = (auth as unknown as { state: { token: { accessExpiresAt: number } } }).state.token;

    // Still divided by the scale — an unreadable token is not a reason to believe
    // the backend's clock runs at this process's rate.
    const lifetimeMs = state.accessExpiresAt - Date.now();
    expect(lifetimeMs).toBeGreaterThan(0);
    expect(lifetimeMs).toBeLessThan(36_000_000);
  });

  it('reads an unaccelerated backend as scale 1', async () => {
    const { auth } = await freshAuth(null);
    expect((auth as unknown as { state: { clockScale: number } }).state.clockScale).toBe(1);
  });

  it('reads an unreachable clock endpoint as scale 1 rather than failing the login', async () => {
    resetAuthStateForTests();
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const auth = new SeederAuth(config());
    stub(auth, {
      login: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
      refresh: jest.fn(),
    });

    await expect(auth.login()).resolves.toBeUndefined();
    expect((auth as unknown as { state: { clockScale: number } }).state.clockScale).toBe(1);
  });
});

describe('renewAllAuths', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetAuthStateForTests();
  });

  it('forces a renewal on an identity whose schedule said it was still fine', async () => {
    // The reactive half. A 401 means the proactive schedule was wrong — a
    // re-dispatched backend, a revoked token — and the caller taking it has no handle
    // on whichever identity minted the token it used.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const { auth, workflow } = await freshAuth(1);
      // Well inside a wall-clock hour, so `refreshIfNeeded` would do nothing here.
      jest.advanceTimersByTime(1_000);
      await auth.refreshIfNeeded();
      expect(workflow.refresh).not.toHaveBeenCalled();

      const renewed = await renewAllAuths();

      expect(renewed).toBeGreaterThanOrEqual(1);
      expect(workflow.refresh).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('dates a token from when the request was sent, not when it came back', async () => {
    // At 2,920x a login that takes a second has already spent the token's whole
    // life. Dating it from the reply calls a dead token fresh — and then lets
    // forceRenew skip it as too young to be the one that just took a 401.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      backendAt(2920);
      const auth = new SeederAuth(config());
      stub(auth, {
        // A slow reply: the clock moves two whole token lifetimes while it is away.
        login: jest.fn(async () => {
          jest.advanceTimersByTime(2_500);
          return tokens(1_000_000, HOUR_SEC, WEEK_SEC);
        }),
        refresh: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
      });
      await auth.login();

      const token = (auth as unknown as { state: { token: { accessExpiresAt: number; mintedAt: number } } }).state
        .token;
      // Expired on arrival, which is the truth and the thing the old code hid.
      expect(token.accessExpiresAt).toBeLessThan(Date.now());
      expect(Date.now() - token.mintedAt).toBeGreaterThanOrEqual(2_500);
      // And old enough that a reactive renewal will not dismiss it as too fresh.
      await expect(auth.forceRenew()).resolves.toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares one token across every auth object for the same identity', async () => {
    // A run builds several Personas, each with an auth per persona, so one login
    // ends up behind several objects. Held per object they would rotate the pair out
    // from under each other and a reactive renewal would fire a login per copy.
    const { auth: first } = await freshAuth(1);
    const second = new SeederAuth(config());
    const secondWorkflow = stub(second, {
      login: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
      refresh: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
    });

    // Never logged in itself, yet already authenticated: it speaks for an identity
    // that is.
    expect(second.getToken()).toBe(first.getToken());
    expect(secondWorkflow.login).not.toHaveBeenCalled();
  });

  it('renews a duplicated identity once, not once per auth object', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const { auth, workflow } = await freshAuth(1);
      const duplicate = new SeederAuth(config());
      const duplicateWorkflow = stub(duplicate, {
        login: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
        refresh: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
      });
      jest.advanceTimersByTime(1_000);

      const renewed = await renewAllAuths();

      expect(renewed).toBe(1);
      expect(workflow.refresh).toHaveBeenCalledTimes(1);
      expect(duplicateWorkflow.refresh).not.toHaveBeenCalled();
      // And the duplicate sees the new token, because there is only one.
      expect(duplicate.getToken()).toBe(auth.getToken());
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts only the identities whose token actually changed', async () => {
    // A 401 straight after a login must not report a renewal that did not happen:
    // the caller would retry with the very same token and call the second failure a
    // different one.
    const { workflow } = await freshAuth(1);
    const before = workflow.login.mock.calls.length + workflow.refresh.mock.calls.length;

    await expect(renewAllAuths()).resolves.toBe(0);

    expect(workflow.login.mock.calls.length + workflow.refresh.mock.calls.length).toBe(before);
  });

  it('leaves a token minted moments ago alone', async () => {
    // A suite builds several Personas and each builds seven identities. Renewing all
    // of them to answer one stale token would send a dozen logins, and none of the
    // fresh ones can have been the token that took the 401.
    const { workflow } = await freshAuth(1);

    await renewAllAuths();

    expect(workflow.refresh).not.toHaveBeenCalled();
    expect(workflow.login).toHaveBeenCalledTimes(1);
  });
});
