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
}

export interface VirtualClockOptions {
  /**
   * How far `virtualStart` must precede `realStart` for the deployment to hold the
   * run this suite intends to drive.
   *
   * Not a year any more. The deploy workflow anchors the pair from its own `days`
   * input (durion-positivity-backend#2136), so a 92-day timeline is a legitimate
   * deployment; callers pass `AcceleratedConfig.minAnchorGapDays`, which is the
   * configured run length less a day of slack. The 360 default is what a caller
   * that says nothing gets, and matches the old year-shaped assumption.
   */
  minAnchorGapDays?: number;
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
  private readonly minAnchorGapDays: number;
  private readonly maxSkewMs: number;
  private readonly fetchImpl: typeof fetch;
  private last: ServerTime | undefined;

  constructor(baseUrl: string, options: VirtualClockOptions = {}) {
    this.timeUrl = `${baseUrl.replace(/\/+$/, '')}/system/time`;
    this.minAnchorGapDays = options.minAnchorGapDays ?? 360;
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

    if (realStart && virtualStart) {
      const gapDays = (realStart.getTime() - virtualStart.getTime()) / DAY_MS;
      if (gapDays < this.minAnchorGapDays) {
        problems.push(
          `virtualStart must precede realStart by at least ${this.minAnchorGapDays} days to cover the ` +
            `run (gap is ${gapDays.toFixed(1)} days: ${virtualStart.toISOString()} → ${realStart.toISOString()}). ` +
            'Deploy with a matching `days` input, or lower ITEST_ACCEL_DAYS to fit the timeline.',
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
