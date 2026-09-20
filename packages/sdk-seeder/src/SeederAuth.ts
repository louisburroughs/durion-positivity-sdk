import {
  AuthAPIApi,
  createSecurityClient,
  JWTAPIApi,
  SecurityAuthWorkflow,
  TokenPairResponse,
} from '@durion-sdk/security';
import { DurionSdkConfig } from '@durion-sdk/transport';
import { SeederConfig } from './SeederConfig';

interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** Wall-clock instant the access token stops being accepted. */
  accessExpiresAt: number;
  /** Wall-clock instant the refresh token stops being accepted. */
  refreshExpiresAt: number;
  /** Wall-clock instant at which a renewal should be attempted. */
  renewAt: number;
  /**
   * Wall-clock instant the request that minted this pair was *sent*.
   *
   * The send, not the reply. The backend stamps `iat` while the request is in
   * flight, and at scale 2,920 a round trip that takes a second has consumed the
   * whole 1.2-second lifetime before the response is parsed. Dating the token from
   * the reply would call an already-dead token fresh, and would let `forceRenew`
   * skip it as too young to be the one that just took a 401.
   */
  mintedAt: number;
}

/**
 * Fallback lifetimes, used only when a token carries no `iat`/`exp` to measure.
 * The access value matches the backend's documented hour with headroom; the
 * refresh value its documented week.
 */
const FALLBACK_ACCESS_TTL_MS = 36_000_000;
const FALLBACK_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How much of a token's life to spend before renewing it.
 *
 * A fraction rather than a fixed margin, because the margin that matters depends
 * entirely on the clock. A minute of headroom is generous against a wall-clock
 * hour and impossible against the 1.2 real seconds the same token lasts at scale
 * 2,920 — the renewal would be due before the login that minted it returned.
 */
const RENEW_AFTER_FRACTION = 0.5;

/** Never renew more often than this, so a pathological scale cannot spin. */
const MIN_RENEW_INTERVAL_MS = 250;

interface JwtTimes {
  iat: number;
  exp: number;
}

/**
 * Reads `iat` and `exp` out of a JWT, without verifying it.
 *
 * Not a security decision — the backend verifies. This only needs to know how
 * long the token claims to live, and in whose seconds.
 */
function readJwtTimes(token: string): JwtTimes | null {
  const segments = token.split('.');
  if (segments.length < 2) {
    return null;
  }
  try {
    const padded = segments[1] + '='.repeat((4 - (segments[1].length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>;
    const iat = claims['iat'];
    const exp = claims['exp'];
    if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat) {
      return null;
    }
    return { iat, exp };
  } catch {
    return null;
  }
}

/**
 * How fast the backend's clock runs, in virtual seconds per real second.
 *
 * Probed once per process from `GET /system/time`, which exists only under the
 * backend's `accelerated` profile and needs no token. Anything other than a
 * usable 200 means an ordinary clock, which is scale 1.
 */
const scaleProbes = new Map<string, Promise<number>>();

async function probeClockScale(baseUrl: string): Promise<number> {
  const existing = scaleProbes.get(baseUrl);
  if (existing) {
    return existing;
  }
  const probe = (async (): Promise<number> => {
    try {
      const response = await fetch(`${baseUrl}/system/time`);
      if (!response.ok) {
        return 1;
      }
      const body = (await response.json()) as { scale?: unknown };
      const scale = body.scale;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 1) {
        return 1;
      }
      console.log(`[Auth] backend clock runs at ${scale}x; token lifetimes scaled to match.`);
      return scale;
    } catch {
      // Unreachable, not accelerated, or not JSON. An ordinary clock is the safe
      // reading: it only means renewals happen on the schedule they always did.
      return 1;
    }
  })();
  scaleProbes.set(baseUrl, probe);
  return probe;
}

/**
 * One identity's tokens, shared by every SeederAuth speaking for that identity.
 *
 * The state is keyed by who the token is *for*, not by the object holding it,
 * because the backend has one identity behind them all. A run builds several
 * Personas — the year suite makes fresh ones for its end-of-run audits — and each
 * builds an auth per persona, so the same login ends up behind several objects.
 * Held per object, each would carry its own token and its own renewal schedule:
 * renewing one rotates the pair out from under the others, and a reactive renewal
 * would fire a login per copy. Shared, a renewal by any of them is a renewal for
 * all of them, and the duplicates cost nothing.
 */
interface IdentityState {
  token: TokenState | null;
  /** In-flight renewal, so parallel callers wait on one login rather than racing. */
  renewal: Promise<void> | null;
  /** Virtual seconds per real second; 1 until the probe answers. */
  clockScale: number;
}

const identities = new Map<string, IdentityState>();

/**
 * One SeederAuth per identity, for {@link renewAllAuths} to drive.
 *
 * The first to log in wins and later duplicates are not added: they share the
 * state above, so renewing through any one of them renews for all of them.
 */
const renewers = new Map<string, SeederAuth>();

/** Test seam: forgets probes, tokens and registered identities. */
export function resetAuthStateForTests(): void {
  scaleProbes.clear();
  identities.clear();
  renewers.clear();
}

/**
 * Forces every known identity to mint a fresh token, and says how many actually did.
 *
 * The reactive half of the token strategy. Renewal is normally proactive, but the
 * proactive schedule is built from a clock rate measured once — if the backend is
 * re-dispatched at a different scale mid-run, or a token is revoked, or a request
 * queues behind a slow one, a 401 is the only signal.
 *
 * The count is of tokens that *changed*, not of calls that did not throw. An
 * identity whose token was minted moments ago is skipped, and counting those as
 * renewals would tell a caller its retry is worth making when the retry is about
 * to send the very same token.
 */
export async function renewAllAuths(): Promise<number> {
  const outcomes = await Promise.allSettled([...renewers.values()].map((auth) => auth.forceRenew()));
  return outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value).length;
}

export class SeederAuth {
  private readonly workflow: SecurityAuthWorkflow;
  /** Which identity's tokens this speaks for. */
  private readonly identityKey: string;

  constructor(private readonly config: SeederConfig) {
    const sdkConfig: DurionSdkConfig = { baseUrl: this.gatewayBaseUrl('security-service') };
    const securityClient = createSecurityClient(sdkConfig);

    this.workflow = new SecurityAuthWorkflow(
      securityClient.authAPIApi as AuthAPIApi,
      securityClient.jwtAPIApi as JWTAPIApi,
    );
    this.identityKey = `${this.config.baseUrl}|${this.config.tenantSlug ?? ''}|${this.config.username}`;
  }

  private gatewayBaseUrl(servicePrefix: string): string {
    return `${this.config.baseUrl}/${servicePrefix}`;
  }

  private get state(): IdentityState {
    let state = identities.get(this.identityKey);
    if (!state) {
      state = { token: null, renewal: null, clockScale: 1 };
      identities.set(this.identityKey, state);
    }
    return state;
  }

  async login(): Promise<void> {
    const state = this.state;
    // Before the tokens, so the first token's deadline is already measured in the
    // right clock. Probed once per base url and cached, so this costs one call for
    // the whole process however many personas log in.
    state.clockScale = await probeClockScale(this.config.baseUrl);

    // Taken before the request goes out — see TokenState.mintedAt.
    const sentAt = Date.now();
    const result = await this.workflow.login({
      loginRequest: {
        username: this.config.username,
        password: this.config.password,
        tenantSlug: this.config.tenantSlug,
      },
    });

    state.token = this.toTokenState(result, sentAt, 'Login response missing tokens');
    if (!renewers.has(this.identityKey)) {
      renewers.set(this.identityKey, this);
    }
    console.log('[Auth] Login successful.');
  }

  getToken(): string {
    const token = this.state.token;
    if (!token) {
      throw new Error('SeederAuth: not logged in - call login() first');
    }
    return token.accessToken;
  }

  /**
   * Renews the token if it is far enough through its life, and does nothing if not.
   *
   * Kept under its original name because the suites call it between phases, but it
   * is no longer only a refresh: when the refresh token is itself spent it logs in
   * again. On an accelerated clock that is the common case, not the rare one — a
   * week of refresh validity is under four real minutes at scale 2,920.
   */
  async refreshIfNeeded(): Promise<void> {
    const token = this.state.token;
    if (!token) {
      throw new Error('SeederAuth: not logged in');
    }
    if (Date.now() < token.renewAt) {
      return;
    }
    await this.renew();
  }

  /**
   * Renews now whatever the schedule says, and reports whether the token changed.
   *
   * A token minted moments ago is left alone: it cannot be the one that just took a
   * 401, and renewing it would spend a login to hand back an equivalent token. The
   * return value is what lets {@link renewAllAuths} tell a caller whether retrying
   * is worth anything.
   */
  async forceRenew(): Promise<boolean> {
    const state = this.state;
    const before = state.token;
    if (!before) {
      return false;
    }
    if (Date.now() - before.mintedAt < MIN_RENEW_INTERVAL_MS) {
      return false;
    }
    state.token = { ...before, renewAt: 0 };
    await this.renew();
    return state.token?.accessToken !== before.accessToken;
  }

  /**
   * One renewal at a time, per identity.
   *
   * Every request asks whether the token is still good, and under parallel work
   * dozens ask at once. Without this they would each mint a token, and each new
   * token would invalidate the one the others had just taken.
   */
  private async renew(): Promise<void> {
    const state = this.state;
    if (state.renewal) {
      return state.renewal;
    }
    state.renewal = this.doRenew().finally(() => {
      state.renewal = null;
    });
    return state.renewal;
  }

  private async doRenew(): Promise<void> {
    const state = this.state;
    const token = state.token;
    // Refresh only while the refresh token can still be believed, then fall back to
    // the credentials. A refresh attempted with a spent token costs a round trip to
    // learn what the clock already said.
    if (token && Date.now() < token.refreshExpiresAt) {
      try {
        const sentAt = Date.now();
        const result = await this.workflow.refresh({
          refreshTokenRequest: { refreshToken: token.refreshToken },
        });
        state.token = this.toTokenState(result, sentAt, 'Refresh response missing tokens');
        console.log('[Auth] Token refreshed.');
        return;
      } catch {
        // Falls through to a full login. The refresh token can be spent for reasons
        // the wall clock cannot predict — a re-dispatched backend, a revocation — and
        // the credentials are still here.
      }
    }
    await this.login();
  }

  buildSdkConfig(servicePrefix: string): DurionSdkConfig {
    return {
      baseUrl: this.gatewayBaseUrl(servicePrefix),
      token: () => this.supplyToken(),
    };
  }

  /**
   * The token to send, renewed first if it is due.
   *
   * Async on purpose: this runs immediately before a request, which is the only
   * place that can know the token is still good at the moment it is used. At scale
   * 2,920 a token minted between two statements is already expired by the time the
   * second one runs. Every client must reach the token through here rather than
   * through {@link getToken}, or it opts out of renewal entirely.
   */
  async supplyToken(): Promise<string> {
    if (this.state.token) {
      await this.refreshIfNeeded();
    }
    return this.getToken();
  }

  private toTokenState(result: TokenPairResponse, sentAt: number, errorMessage: string): TokenState {
    if (!result.accessToken || !result.refreshToken) {
      throw new Error(errorMessage);
    }

    const accessExpiresAt = sentAt + this.wallLifetimeMs(result.accessToken, FALLBACK_ACCESS_TTL_MS);
    const refreshExpiresAt = sentAt + this.wallLifetimeMs(result.refreshToken, FALLBACK_REFRESH_TTL_MS);

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      mintedAt: sentAt,
      // Floored a little ahead of the mint so a scale high enough to expire a token
      // inside its own round trip cannot put the renewal permanently in the past.
      renewAt: Math.max(
        sentAt + MIN_RENEW_INTERVAL_MS,
        sentAt + (accessExpiresAt - sentAt) * RENEW_AFTER_FRACTION,
      ),
    };
  }

  /**
   * How long a token lasts *here*, given how fast the backend's clock runs.
   *
   * `exp - iat` is the lifetime in the backend's own seconds. Under the accelerated
   * profile those run `scale` times faster than this process's, so an hour of them
   * is `3600 / scale` seconds of wall time — 1.2 of them at scale 2,920. Computing
   * the deadline from `Date.now()` plus a constant, as this used to, produced a
   * token the SDK believed in for ten hours and the gateway rejected after one
   * second.
   */
  private wallLifetimeMs(token: string, fallbackMs: number): number {
    const times = readJwtTimes(token);
    const backendLifetimeMs = times ? (times.exp - times.iat) * 1000 : fallbackMs;
    return backendLifetimeMs / this.state.clockScale;
  }
}
