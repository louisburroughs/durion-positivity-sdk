/**
 * The accelerated backend's clock, as the suites are allowed to see it.
 *
 * `GET /system/time` exists only under the backend's `accelerated` profile and
 * is the single source of virtual time: virtual dates are never derived from
 * `Date.now()`, because the backend is moving through a year while the laptop
 * moves through an afternoon.
 *
 * This is the mirror image of {@link ./acceleratedClock.ts}, which guards the
 * *non*-accelerated suites by aborting when the endpoint answers 200. Here a
 * 200 is the precondition and a 404 is the failure, and the two guards are
 * deliberately kept as separate functions so neither can be flipped by
 * accident.
 *
 * Validation is stricter than the seeder's VirtualClock needs to be. The seeder
 * logs and survives; a test run that mis-reads the clock writes a year of
 * records carrying dates nobody can trust, and there is no undo on a shared
 * alpha database.
 */

/** The endpoint's body, before validation. */
interface RawServerTime {
  virtualTime?: unknown;
  scale?: unknown;
  zone?: unknown;
  accelerated?: unknown;
  converged?: unknown;
  realStart?: unknown;
  virtualStart?: unknown;
}

/** One validated reading. */
export interface ServerTime {
  /** Authoritative virtual instant. */
  virtualTime: Date;
  /** Virtual seconds per real second. Always > 1 while accelerating. */
  scale: number;
  zone: string;
  accelerated: boolean;
  /**
   * True once `virtual(t)` has caught up with wall time. The clock then ticks at
   * scale 1 forever, so the timeline is spent and a run must stop writing.
   */
  converged: boolean;
  realStart: Date;
  virtualStart: Date;
  /** Local wall clock at the moment this reading was taken — for skew checks. */
  readAt: Date;
  /** Virtual days still drivable before convergence, from this reading. */
  remainingDays: number;
}

export interface VirtualClockOptions {
  /**
   * The least virtual time that must still be drivable for a run to be worth
   * starting, in virtual days.
   *
   * Deliberately not the anchor gap. That is the timeline's *total* length, fixed
   * at deploy, and it stops being the interesting number the moment the containers
   * start: the clock begins closing it immediately, so by the time a suite is
   * dispatched some of it is already spent. A run configured for the same length
   * as the deployment could therefore never satisfy a gap-shaped guard — the
   * complaint that produced this.
   *
   * What a run needs is headroom, and the caller adapts to whatever is left rather
   * than demanding a number. One day is the floor for "worth starting at all".
   */
  minRemainingDays?: number;
  /**
   * How far `virtualTime` may exceed the local wall clock before the reading is
   * refused. The clock converges *to* wall time and never past it, so a virtual
   * time meaningfully ahead of the laptop means the JVMs and the laptop disagree
   * about now — and every date this run writes would inherit that disagreement.
   */
  maxSkewMs?: number;
  /** Injected for unit tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much virtual time is still drivable before the clock catches wall time.
 *
 * The anchors say how long the timeline was; this says how much of it is left,
 * which is the only figure a run can plan against. The containers start closing
 * the gap the moment they boot, so a suite dispatched minutes later already has
 * less than was deployed — and one dispatched an hour later may have almost none.
 *
 * `virtual(t) = min(virtualStart + scale × (t − realStart), t)`, so the gap still
 * to close is `now − virtualTime` and it closes at `scale − 1` per unit of real
 * time. The virtual span that buys is `scale` times the real time it takes:
 *
 *   remainingVirtual = scale × (now − virtualTime) / (scale − 1)
 *
 * Only the reading is needed — no anchors — so this stays right across a
 * re-dispatch that moves them.
 */
export function remainingVirtualDays(virtualTime: Date, now: Date, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 1) {
    return 0;
  }
  const gapMs = now.getTime() - virtualTime.getTime();
  if (gapMs <= 0) {
    return 0;
  }
  return (scale * gapMs) / ((scale - 1) * DAY_MS);
}

/** Thrown when the clock has caught up with wall time: the timeline is spent. */
export class ClockConvergedError extends Error {
  constructor(readonly observed: ServerTime, detail: string) {
    super(`[accel] the accelerated clock has converged on wall time at ${observed.virtualTime.toISOString()}: ${detail}`);
    this.name = 'ClockConvergedError';
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseInstant = (value: unknown, field: string, problems: string[]): Date | undefined => {
  if (typeof value !== 'string' || value.length === 0) {
    problems.push(`${field} must be an ISO instant string (got ${JSON.stringify(value)})`);
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    problems.push(`${field} is not a parseable instant (got ${JSON.stringify(value)})`);
    return undefined;
  }
  return parsed;
};

const isValidZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export class VirtualClock {
  private readonly timeUrl: string;
  private readonly minRemainingDays: number;
  private readonly maxSkewMs: number;
  private readonly fetchImpl: typeof fetch;
  private last: ServerTime | undefined;

  constructor(baseUrl: string, options: VirtualClockOptions = {}) {
    this.timeUrl = `${baseUrl.replace(/\/+$/, '')}/system/time`;
    this.minRemainingDays = options.minRemainingDays ?? 1;
    this.maxSkewMs = options.maxSkewMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** The most recent validated reading, for logging without another round trip. */
  get lastRead(): ServerTime | undefined {
    return this.last;
  }

  /**
   * One validated reading. Every failure is fatal: there is no "not yet" answer
   * from this endpoint, and a run that cannot read the clock cannot date
   * anything it writes.
   */
  async read(): Promise<ServerTime> {
    let response: Response;
    const readAt = new Date();
    try {
      response = await this.fetchImpl(this.timeUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[accel] cannot reach ${this.timeUrl} (${message}). Is the tunnel up / the local stack running?`,
      );
    }

    if (response.status === 404) {
      throw new Error(
        `[accel] ${this.timeUrl} answered 404 — this backend is on the normal clock, not the ` +
          'accelerated profile. Run `npm run test:integration` against it, or deploy with ' +
          'spring.profiles.include=accelerated and the POS_TIME_ACCELERATED_* anchors ' +
          '(see README, "Accelerated year run").',
      );
    }
    if (!response.ok) {
      throw new Error(`[accel] ${this.timeUrl} answered HTTP ${response.status} ${response.statusText}`);
    }

    let raw: RawServerTime;
    try {
      raw = (await response.json()) as RawServerTime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[accel] ${this.timeUrl} returned a body that is not JSON: ${message}`);
    }

    const reading = this.validate(raw, readAt);
    this.last = reading;
    return reading;
  }

  /** The current virtual instant. */
  async now(): Promise<Date> {
    return (await this.read()).virtualTime;
  }

  /**
   * Collects every problem before throwing, so a misconfigured deployment is
   * reported once with the whole story rather than one field at a time — the
   * same contract ItestConfig keeps.
   */
  private validate(raw: RawServerTime, readAt: Date): ServerTime {
    const problems: string[] = [];

    const virtualTime = parseInstant(raw.virtualTime, 'virtualTime', problems);
    const realStart = parseInstant(raw.realStart, 'realStart', problems);
    const virtualStart = parseInstant(raw.virtualStart, 'virtualStart', problems);

    if (raw.accelerated !== true) {
      problems.push(
        `accelerated must be true (got ${JSON.stringify(raw.accelerated)}) — the endpoint is ` +
          'present but the clock is not accelerating, so this run would write today\'s dates',
      );
    }
    if (!isFiniteNumber(raw.scale) || raw.scale <= 1) {
      problems.push(`scale must be a finite number greater than 1 (got ${JSON.stringify(raw.scale)})`);
    }
    if (typeof raw.zone !== 'string' || !isValidZone(raw.zone)) {
      problems.push(`zone must be an IANA zone id (got ${JSON.stringify(raw.zone)})`);
    }
    if (raw.converged !== undefined && typeof raw.converged !== 'boolean') {
      problems.push(`converged must be a boolean when present (got ${JSON.stringify(raw.converged)})`);
    }

    if (realStart && virtualStart && realStart.getTime() <= virtualStart.getTime()) {
      problems.push(
        `virtualStart ${virtualStart.toISOString()} does not precede realStart ${realStart.toISOString()}, ` +
          'so the deployment has no timeline in it to drive',
      );
    }
    if (virtualTime && isFiniteNumber(raw.scale) && raw.scale > 1) {
      const remaining = remainingVirtualDays(virtualTime, readAt, raw.scale);
      if (remaining < this.minRemainingDays) {
        problems.push(
          `only ${remaining.toFixed(2)} virtual day(s) remain before the clock converges, below the ` +
            `${this.minRemainingDays} this run needs. The timeline is nearly spent — re-dispatch the ` +
            'accelerated stack and start a fresh journal.',
        );
      }
    }
    if (virtualTime && virtualStart && virtualTime.getTime() < virtualStart.getTime()) {
      problems.push(
        `virtualTime ${virtualTime.toISOString()} is before virtualStart ${virtualStart.toISOString()}`,
      );
    }
    if (virtualTime) {
      const skewMs = virtualTime.getTime() - readAt.getTime();
      if (skewMs > this.maxSkewMs) {
        problems.push(
          `virtualTime ${virtualTime.toISOString()} is ${Math.round(skewMs / 1000)}s ahead of the local ` +
            `wall clock, beyond the ${this.maxSkewMs}ms allowance — the backend clock and this machine disagree ` +
            'about now, so no date this run writes could be trusted (ITEST_ACCEL_MAX_SKEW_MS)',
        );
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `[accel] ${this.timeUrl} is not a usable accelerated clock:\n  - ${problems.join('\n  - ')}`,
      );
    }

    return {
      virtualTime: virtualTime as Date,
      scale: raw.scale as number,
      zone: raw.zone as string,
      accelerated: true,
      converged: raw.converged === true,
      realStart: realStart as Date,
      virtualStart: virtualStart as Date,
      readAt,
      remainingDays: remainingVirtualDays(virtualTime as Date, readAt, raw.scale as number),
    };
  }
}

/**
 * The accelerated entry point's precondition, and the inverse of
 * `assertNonAcceleratedBackend`: the backend must be on the accelerated profile,
 * anchored a year back, and still accelerating.
 *
 * Returns the reading so global setup can log and store the anchors — they are
 * the run's identity, and two runs against the same `realStart` are the same
 * timeline (see acceleratedJournal).
 */
export async function assertAcceleratedBackend(
  baseUrl: string,
  options: VirtualClockOptions = {},
): Promise<ServerTime> {
  const reading = await new VirtualClock(baseUrl, options).read();
  if (reading.converged) {
    throw new ClockConvergedError(
      reading,
      'the year is already spent. Redeploy with fresh POS_TIME_ACCELERATED_* anchors before running.',
    );
  }
  return reading;
}
