import { SeederAuth, renewAllAuths, resetClockScaleProbes } from './SeederAuth';
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

/** An access/refresh pair minted at `iat` in the backend's own seconds. */
const tokens = (iat: number, accessTtlSec: number, refreshTtlSec: number) => ({
  accessToken: jwt({ iat, exp: iat + accessTtlSec }),
  refreshToken: jwt({ iat, exp: iat + refreshTtlSec }),
});

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
  resetClockScaleProbes();
  global.fetch = jest.fn(async () =>
    scale === null
      ? ({ ok: false, status: 404 } as unknown as Response)
      : ({ ok: true, json: async () => ({ scale, accelerated: true }) } as unknown as Response),
  ) as unknown as typeof fetch;
};

const freshAuth = async (scale: number | null, minted = tokens(1_000_000, HOUR_SEC, WEEK_SEC)) => {
  backendAt(scale);
  const auth = new SeederAuth(config());
  const workflow = stub(auth, {
    login: jest.fn(async () => minted),
    refresh: jest.fn(async () => minted),
  });
  await auth.login();
  return { auth, workflow };
};

describe('SeederAuth — token lifetime against the backend clock', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetClockScaleProbes();
    jest.useRealTimers();
  });

  it('measures an hour token as an hour on an ordinary clock', async () => {
    const { auth, workflow } = await freshAuth(null);
    const state = (auth as unknown as { tokenState: { renewAt: number } }).tokenState;

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
    const state = (auth as unknown as { tokenState: { accessExpiresAt: number; renewAt: number } }).tokenState;

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
    const state = (auth as unknown as { tokenState: { accessExpiresAt: number } }).tokenState;

    // Still divided by the scale — an unreadable token is not a reason to believe
    // the backend's clock runs at this process's rate.
    const lifetimeMs = state.accessExpiresAt - Date.now();
    expect(lifetimeMs).toBeGreaterThan(0);
    expect(lifetimeMs).toBeLessThan(36_000_000);
  });

  it('reads an unaccelerated backend as scale 1', async () => {
    const { auth } = await freshAuth(null);
    expect((auth as unknown as { clockScale: number }).clockScale).toBe(1);
  });

  it('reads an unreachable clock endpoint as scale 1 rather than failing the login', async () => {
    resetClockScaleProbes();
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const auth = new SeederAuth(config());
    stub(auth, {
      login: jest.fn(async () => tokens(1_000_000, HOUR_SEC, WEEK_SEC)),
      refresh: jest.fn(),
    });

    await expect(auth.login()).resolves.toBeUndefined();
    expect((auth as unknown as { clockScale: number }).clockScale).toBe(1);
  });
});

describe('renewAllAuths', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    resetClockScaleProbes();
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
