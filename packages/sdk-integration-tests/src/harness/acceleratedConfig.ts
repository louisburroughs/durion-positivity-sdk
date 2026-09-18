/**
 * The ITEST_ACCEL_* half of the environment contract, plus the arithmetic that
 * decides whether a run is worth starting.
 *
 * Same fail-fast contract as ItestConfig: every problem is collected and raised
 * once, so a misconfigured run is fixed in one pass instead of one variable per
 * attempt.
 */
import {
  holidaysForSpan,
  parseWindow,
  parseTimeOfDay,
  ShopCalendar,
  type CalendarSpec,
  type DayWindow,
} from './shopCalendar';

type EnvShape = Record<string, string | undefined>;

/**
 * Above this the clock outruns the backend's own event latency by so much that no
 * useful work fits in an open window. Not a hard refusal on its own — the
 * feasibility guard decides on measured latency — but a scale past it needs the
 * measurement to justify it.
 */
export const ADVISORY_SCALE_CEILING = 8_760;

/**
 * The minimum number of sequential gateway calls that must fit inside one open
 * window for a job to make progress at all. Below two, a job advances less than
 * one step per virtual day and the run is a very slow way of writing nothing.
 */
export const MIN_STEPS_PER_WINDOW = 2;

export class AcceleratedConfig {
  private constructor(
    readonly days: number,
    readonly runBudgetMs: number,
    readonly sampleEvery: number,
    readonly concurrency: number,
    readonly jobsPerDayMin: number,
    readonly jobsPerDayMax: number,
    readonly weekdayWindow: DayWindow,
    readonly saturdayWindow: DayWindow | null,
    readonly sundayWindow: DayWindow | null,
    /** Explicit closure list; undefined means "US federal set for the covered span". */
    readonly holidayOverride: string[] | undefined,
    readonly publishCalendar: boolean,
    readonly mobileAfterHours: boolean,
    readonly graceMinutes: number,
    readonly unpaidRatio: number,
    /** Explicit volume floor; undefined means derived from the feasibility figures. */
    readonly minWorkordersOverride: number | undefined,
    readonly appointmentLeadDaysMin: number,
    readonly appointmentLeadDaysMax: number,
    readonly pollMs: number,
    readonly maxSkewMs: number,
    readonly journalPath: string,
    /**
     * The lock file that stops a second accelerated run starting here. Defaults to
     * the journal's path plus `.lock`, so the two travel together.
     */
    readonly lockPath: string,
    /**
     * The CI workflow's advisory lock object. Recorded and logged, not enforced in
     * this process: cross-machine exclusion is the workflow's `concurrency` group,
     * and a lock file cannot see another machine. See acceleratedLock.
     */
    readonly lockUri: string | undefined,
  ) {}

  /**
   * The calendar for a run spanning `from` → `to` in virtual time.
   *
   * Built here rather than in the constructor because the default holiday set
   * depends on which calendar years the virtual span touches, and that is only
   * known once the clock has been read.
   */
  calendarFor(from: Date, to: Date): ShopCalendar {
    const holidays = this.holidayOverride ?? holidaysForSpan(from, to);
    const spec: CalendarSpec = {
      weekday: this.weekdayWindow,
      saturday: this.saturdayWindow,
      sunday: this.sundayWindow,
      holidays: new Set(holidays),
      graceMinutes: this.graceMinutes,
      mobileAfterHours: this.mobileAfterHours,
    };
    return new ShopCalendar(spec);
  }

  static fromEnv(env: EnvShape = process.env): AcceleratedConfig {
    const problems: string[] = [];

    const int = (key: string, fallback: number, options: { min?: number; max?: number } = {}): number => {
      const raw = env[key];
      if (raw === undefined || raw === '') {
        return fallback;
      }
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) {
        problems.push(`${key} must be an integer (got "${raw}")`);
        return fallback;
      }
      if (options.min !== undefined && parsed < options.min) {
        problems.push(`${key} must be at least ${options.min} (got ${parsed})`);
        return fallback;
      }
      if (options.max !== undefined && parsed > options.max) {
        problems.push(`${key} must be at most ${options.max} (got ${parsed})`);
        return fallback;
      }
      return parsed;
    };

    const ratio = (key: string, fallback: number): number => {
      const raw = env[key];
      if (raw === undefined || raw === '') {
        return fallback;
      }
      const parsed = Number.parseFloat(raw);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
        problems.push(`${key} must be a number between 0 and 1 (got "${raw}")`);
        return fallback;
      }
      return parsed;
    };

    const flag = (key: string, fallback: boolean): boolean => {
      const raw = env[key];
      if (raw === undefined || raw === '') {
        return fallback;
      }
      if (/^(true|1|yes)$/i.test(raw)) return true;
      if (/^(false|0|no)$/i.test(raw)) return false;
      problems.push(`${key} must be true or false (got "${raw}")`);
      return fallback;
    };

    const window = (key: string, fallback: string): DayWindow | null => {
      const raw = env[key] ?? fallback;
      try {
        return parseWindow(raw, key);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        return null;
      }
    };

    const days = int('ITEST_ACCEL_DAYS', 365, { min: 1, max: 400 });
    const runBudgetMs = int('ITEST_ACCEL_RUN_BUDGET_MS', 23_400_000, { min: 60_000 });
    const sampleEvery = int('ITEST_ACCEL_SAMPLE_EVERY', 1, { min: 1, max: 30 });
    const concurrency = int('ITEST_ACCEL_CONCURRENCY', 8, { min: 1, max: 64 });
    const jobsPerDayMin = int('ITEST_ACCEL_JOBS_PER_DAY_MIN', 4, { min: 0 });
    const jobsPerDayMax = int('ITEST_ACCEL_JOBS_PER_DAY_MAX', 12, { min: 1 });
    if (jobsPerDayMax < jobsPerDayMin) {
      problems.push(
        `ITEST_ACCEL_JOBS_PER_DAY_MAX (${jobsPerDayMax}) must be at least ITEST_ACCEL_JOBS_PER_DAY_MIN (${jobsPerDayMin})`,
      );
    }

    // The weekday window is two variables rather than one range string, because
    // that is how the README documents it and how a location's operatingHours
    // entry is shaped.
    let weekdayWindow: DayWindow = { openMinutes: 8 * 60, closeMinutes: 18 * 60 };
    try {
      const openMinutes = parseTimeOfDay(env['ITEST_ACCEL_OPEN_TIME'] ?? '08:00', 'ITEST_ACCEL_OPEN_TIME');
      const closeMinutes = parseTimeOfDay(env['ITEST_ACCEL_CLOSE_TIME'] ?? '18:00', 'ITEST_ACCEL_CLOSE_TIME');
      if (closeMinutes <= openMinutes) {
        problems.push('ITEST_ACCEL_OPEN_TIME must be earlier than ITEST_ACCEL_CLOSE_TIME');
      } else {
        weekdayWindow = { openMinutes, closeMinutes };
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }

    const saturdayWindow = window('ITEST_ACCEL_SATURDAY', '09:00-13:00');
    const sundayWindow = window('ITEST_ACCEL_SUNDAY', 'closed');

    let holidayOverride: string[] | undefined;
    const holidaysRaw = env['ITEST_ACCEL_HOLIDAYS'];
    if (holidaysRaw !== undefined && holidaysRaw !== '') {
      const entries = holidaysRaw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const bad = entries.filter((entry) => !/^\d{4}-\d{2}-\d{2}$/.test(entry) || Number.isNaN(Date.parse(`${entry}T00:00:00Z`)));
      if (bad.length > 0) {
        problems.push(`ITEST_ACCEL_HOLIDAYS must be comma-separated YYYY-MM-DD dates (bad: ${bad.join(', ')})`);
      } else {
        holidayOverride = entries;
      }
    }

    const graceMinutes = int('ITEST_ACCEL_OVERRUN_GRACE_MINUTES', 90, { min: 0, max: 24 * 60 });
    const unpaidRatio = ratio('ITEST_ACCEL_UNPAID_RATIO', 0);
    const minWorkordersRaw = env['ITEST_ACCEL_MIN_WORKORDERS'];
    const minWorkordersOverride =
      minWorkordersRaw === undefined || minWorkordersRaw === ''
        ? undefined
        : int('ITEST_ACCEL_MIN_WORKORDERS', 0, { min: 0 });

    const appointmentLeadDaysMin = int('ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MIN', 1, { min: 0, max: 60 });
    const appointmentLeadDaysMax = int('ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MAX', 5, { min: 1, max: 90 });
    if (appointmentLeadDaysMax < appointmentLeadDaysMin) {
      problems.push(
        `ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MAX (${appointmentLeadDaysMax}) must be at least ` +
          `ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MIN (${appointmentLeadDaysMin})`,
      );
    }

    // Every remaining value is read *before* the throw below. Reading any of them
    // inside the constructor call would put their problems after the check, so a
    // bad boolean or a bad interval would be silently ignored rather than
    // reported — which is what this file exists to prevent.
    const publishCalendar = flag('ITEST_ACCEL_PUBLISH_CALENDAR', true);
    const mobileAfterHours = flag('ITEST_ACCEL_MOBILE_AFTER_HOURS', true);
    const pollMs = int('ITEST_ACCEL_POLL_MS', 500, { min: 50 });
    const journalPath = env['ITEST_ACCEL_JOURNAL'] || '.itest-accel-journal.json';
    const maxSkewMs = int('ITEST_ACCEL_MAX_SKEW_MS', 60_000, { min: 0 });

    if (problems.length > 0) {
      throw new Error(
        `Accelerated test configuration is invalid:\n  - ${problems.join('\n  - ')}\n` +
          'See packages/sdk-integration-tests/README.md, "Accelerated year run", for the contract.',
      );
    }

    return new AcceleratedConfig(
      days,
      runBudgetMs,
      sampleEvery,
      concurrency,
      jobsPerDayMin,
      jobsPerDayMax,
      weekdayWindow,
      saturdayWindow,
      sundayWindow,
      holidayOverride,
      publishCalendar,
      mobileAfterHours,
      graceMinutes,
      unpaidRatio,
      minWorkordersOverride,
      appointmentLeadDaysMin,
      appointmentLeadDaysMax,
      pollMs,
      maxSkewMs,
      journalPath,
      env['ITEST_ACCEL_LOCK_FILE'] || `${journalPath}.lock`,
      env['ITEST_ACCEL_LOCK_URI'] || undefined,
    );
  }
}

export interface LatencyMeasurement {
  /** Real ms for the slowest single gateway call in the warm-up job. */
  stepLatencyMs: number;
  /** Real ms for the whole warm-up lifecycle, first call to payment. */
  jobLatencyMs: number;
  /** How many calls the warm-up job made. */
  steps: number;
}

export interface FeasibilityInput {
  /** Virtual seconds per real second, as the backend reports it. */
  scale: number;
  /** The tightest open window the calendar has, in virtual minutes. */
  shortestOpenMinutes: number;
  /**
   * The overrun grace, in virtual minutes. A single step must fit inside it: the day
   * runner guarantees the in-hours loop one tick with nothing to predict from, and a
   * tick larger than the grace pushes the shift out of the window the payroll audit
   * accepts, however the rest of the day is bounded.
   */
  graceMinutes: number;
  latency: LatencyMeasurement;
  concurrency: number;
  /** Open virtual days the run will actually work. */
  sampledOpenDays: number;
}

export interface Feasibility {
  ok: boolean;
  /** Real seconds available inside the tightest open window. */
  openRealSeconds: number;
  /** How many open windows one job needs end to end. */
  openWindowsPerJob: number;
  /** Jobs the run can complete per worked open day. */
  jobsPerDay: number;
  expectedWorkorders: number;
  /** The volume floor the run must clear. */
  minWorkorders: number;
  /** The highest scale that would satisfy the guard, for the failure message. */
  suggestedScaleCeiling: number;
  reason?: string;
}

/**
 * Can this run produce anything?
 *
 * Throughput is bounded by real event latency, not by the virtual clock: one
 * lifecycle is 20-25 gateway calls plus cross-service replication waits, and at
 * scale 8,760 a ten-hour open window is four real seconds. The run therefore
 * does *not* try to fit a whole job inside one window — jobs are advanced a step
 * at a time and span as many open windows as they need, which is both what a
 * multi-day repair looks like and what keeps every labor call inside working
 * hours.
 *
 * What must fit in one window is a handful of steps. Below that a job advances
 * less than once per virtual day and the run writes nothing worth asserting, so
 * the guard refuses rather than spending six hours proving it.
 */
export function assessFeasibility(input: FeasibilityInput): Feasibility {
  const openRealSeconds = (input.shortestOpenMinutes * 60) / input.scale;
  const stepSeconds = input.latency.stepLatencyMs / 1000;
  const jobSeconds = input.latency.jobLatencyMs / 1000;

  // One step, in virtual minutes, at this scale.
  const stepVirtualMinutes = (input.latency.stepLatencyMs * input.scale) / 60_000;

  const suggestedScaleCeiling = Math.floor(
    Math.min(
      (input.shortestOpenMinutes * 60) / Math.max(stepSeconds * MIN_STEPS_PER_WINDOW, 0.001),
      // ...and the scale at which one step still fits inside the grace.
      input.graceMinutes > 0 ? (input.graceMinutes * 60_000) / Math.max(input.latency.stepLatencyMs, 1) : Infinity,
    ),
  );

  const openWindowsPerJob = Math.max(1, Math.ceil(jobSeconds / Math.max(openRealSeconds, 0.001)));
  const jobsPerDay = Math.floor(input.concurrency / openWindowsPerJob);
  const expectedWorkorders = jobsPerDay * input.sampledOpenDays;
  const minWorkorders = Math.floor(0.6 * expectedWorkorders);

  const base: Feasibility = {
    ok: true,
    openRealSeconds,
    openWindowsPerJob,
    jobsPerDay,
    expectedWorkorders,
    minWorkorders,
    suggestedScaleCeiling,
  };

  if (input.graceMinutes > 0 && stepVirtualMinutes >= input.graceMinutes) {
    return {
      ...base,
      ok: false,
      reason:
        `one gateway call is ${stepVirtualMinutes.toFixed(0)} virtual minutes at scale ${input.scale}, which does not ` +
        `fit inside the ${input.graceMinutes}-minute overrun grace. The day's first step runs with nothing to ` +
        'predict from, and a step larger than the grace pushes every shift end outside the window the payroll ' +
        `audit accepts. Deploy with pos.time.accelerated.scale=${suggestedScaleCeiling} or lower, or raise ` +
        'ITEST_ACCEL_OVERRUN_GRACE_MINUTES.',
    };
  }
  if (openRealSeconds < stepSeconds * MIN_STEPS_PER_WINDOW) {
    return {
      ...base,
      ok: false,
      reason:
        `an open window is ${openRealSeconds.toFixed(1)} real seconds at scale ${input.scale}, but one gateway ` +
        `call takes up to ${stepSeconds.toFixed(1)}s — fewer than the ${MIN_STEPS_PER_WINDOW} steps a job needs ` +
        `to make progress in a virtual day. Deploy with pos.time.accelerated.scale=${suggestedScaleCeiling} or ` +
        'lower, or widen ITEST_ACCEL_OPEN_TIME / _CLOSE_TIME.',
    };
  }
  if (jobsPerDay < 1) {
    return {
      ...base,
      ok: false,
      reason:
        `one job needs ${openWindowsPerJob} open windows at scale ${input.scale} (lifecycle ${jobSeconds.toFixed(1)}s ` +
        `against a ${openRealSeconds.toFixed(1)}s window), but only ${input.concurrency} can run at once — so fewer ` +
        `than one job completes per worked day. Raise ITEST_ACCEL_CONCURRENCY to at least ${openWindowsPerJob}, or ` +
        `lower the scale to ${suggestedScaleCeiling} or below.`,
    };
  }
  if (expectedWorkorders < 1) {
    return {
      ...base,
      ok: false,
      reason:
        `the run would work ${input.sampledOpenDays} open day(s) at ${jobsPerDay} job(s) each — nothing to assert. ` +
        'Lower ITEST_ACCEL_SAMPLE_EVERY or raise ITEST_ACCEL_DAYS.',
    };
  }
  return base;
}
