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
  /** Wall-clock instant this pair was minted, so a forced renewal can skip a new one. */
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
 *
 * Shared across every SeederAuth in the process: seven personas logging in should
 * ask once, and the answer cannot differ between them.
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
      const body = (await response.json()) as { scale?: unknown; accelerated?: unknown };
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

/** Test seam: forgets the cached probes so a suite can drive a different clock. */
export function resetClockScaleProbes(): void {
  scaleProbes.clear();
}

/**
 * Every live SeederAuth, so a 401 anywhere can force a renewal everywhere.
 *
 * The register is the mechanism behind {@link renewAllAuths}: a caller that has
 * taken a 401 has no handle on whichever identity minted the token it used, and
 * threading one through every call site would be a wide change for a narrow need.
 */
const liveAuths = new Set<SeederAuth>();

/**
 * Forces every logged-in identity to mint a fresh token, and says how many did.
 *
 * The reactive half of the token strategy. Renewal is normally proactive, but the
 * proactive schedule is built from a clock rate measured once — if the backend is
 * re-dispatched at a different scale mid-run, or a token is revoked, or the very
 * first token expires before its own login returns, a 401 is the only signal. One
 * forced renewal turns that into a retryable blip rather than a failed run.
 */
export async function renewAllAuths(): Promise<number> {
  const outcomes = await Promise.allSettled([...liveAuths].map((auth) => auth.forceRenew()));
  return outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
}

export class SeederAuth {
  private tokenState: TokenState | null = null;
  private readonly workflow: SecurityAuthWorkflow;
  /** Virtual seconds per real second; 1 until the probe answers. */
  private clockScale = 1;
  /** In-flight renewal, so parallel callers wait on one login rather than racing. */
  private renewal: Promise<void> | null = null;

  constructor(private readonly config: SeederConfig) {
    const sdkConfig: DurionSdkConfig = { baseUrl: this.gatewayBaseUrl('security-service') };
    const securityClient = createSecurityClient(sdkConfig);

    this.workflow = new SecurityAuthWorkflow(
      securityClient.authAPIApi as AuthAPIApi,
      securityClient.jwtAPIApi as JWTAPIApi,
    );
  }

  private gatewayBaseUrl(servicePrefix: string): string {
    return `${this.config.baseUrl}/${servicePrefix}`;
  }

  async login(): Promise<void> {
    // Before the tokens, so the first token's deadline is already measured in the
    // right clock. Probed once per base url and cached, so this costs one call for
    // the whole process however many personas log in.
    this.clockScale = await probeClockScale(this.config.baseUrl);

    const result = await this.workflow.login({
      loginRequest: {
        username: this.config.username,
        password: this.config.password,
        tenantSlug: this.config.tenantSlug,
      },
    });

    this.tokenState = this.toTokenState(result, 'Login response missing tokens');
    liveAuths.add(this);
    console.log('[Auth] Login successful.');
  }

  getToken(): string {
    if (!this.tokenState) {
      throw new Error('SeederAuth: not logged in - call login() first');
    }
    return this.tokenState.accessToken;
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
    if (!this.tokenState) {
      throw new Error('SeederAuth: not logged in');
    }
    if (Date.now() < this.tokenState.renewAt) {
      return;
    }
    await this.renew();
  }

  /**
   * Renews now, whatever the schedule says. See {@link renewAllAuths}.
   *
   * Except for a token minted moments ago, which cannot be the one that just took a
   * 401 — a suite builds several Personas and each builds seven identities, so a
   * blanket renewal would send a dozen logins to answer one stale token.
   */
  async forceRenew(): Promise<void> {
    if (!this.tokenState) {
      return;
    }
    if (Date.now() - this.tokenState.mintedAt < MIN_RENEW_INTERVAL_MS) {
      return;
    }
    this.tokenState = { ...this.tokenState, renewAt: 0 };
    await this.renew();
  }

  /**
   * One renewal at a time.
   *
   * Every request asks whether the token is still good, and under parallel work
   * dozens ask at once. Without this they would each mint a token, and each new
   * token would invalidate the one the others had just taken.
   */
  private async renew(): Promise<void> {
    if (this.renewal) {
      return this.renewal;
    }
    this.renewal = this.doRenew().finally(() => {
      this.renewal = null;
    });
    return this.renewal;
  }

  private async doRenew(): Promise<void> {
    const state = this.tokenState;
    // Refresh only while the refresh token can still be believed, then fall back to
    // the credentials. A refresh attempted with a spent token costs a round trip to
    // learn what the clock already said.
    if (state && Date.now() < state.refreshExpiresAt) {
      try {
        const result = await this.workflow.refresh({
          refreshTokenRequest: { refreshToken: state.refreshToken },
        });
        this.tokenState = this.toTokenState(result, 'Refresh response missing tokens');
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
      // Async on purpose: this runs immediately before every request, which is the
      // only place that can know the token is still good at the moment it is used.
      // At scale 2,920 a token minted between two statements is already expired by
      // the time the second one runs.
      token: async () => {
        if (this.tokenState) {
          await this.refreshIfNeeded();
        }
        return this.getToken();
      },
    };
  }

  private toTokenState(result: TokenPairResponse, errorMessage: string): TokenState {
    if (!result.accessToken || !result.refreshToken) {
      throw new Error(errorMessage);
    }

    const mintedAt = Date.now();
    const accessExpiresAt = mintedAt + this.wallLifetimeMs(result.accessToken, FALLBACK_ACCESS_TTL_MS);
    const refreshExpiresAt = mintedAt + this.wallLifetimeMs(result.refreshToken, FALLBACK_REFRESH_TTL_MS);

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      mintedAt,
      renewAt: Math.max(
        mintedAt + MIN_RENEW_INTERVAL_MS,
        mintedAt + (accessExpiresAt - mintedAt) * RENEW_AFTER_FRACTION,
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
    return backendLifetimeMs / this.clockScale;
  }
}
