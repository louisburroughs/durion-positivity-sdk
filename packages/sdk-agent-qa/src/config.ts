/**
 * The harness's own settings, read from `QA_*` environment variables.
 *
 * Backend credentials, personas and the tenant are not restated here: they are
 * the integration suite's `ITEST_*` contract, read through `ItestConfig`, so
 * one `.env.itest` configures both. As there, every problem is collected and
 * reported once.
 */
import * as path from 'path';
import { z } from 'zod';
import type { DayPlanOptions } from './day/dayPlan';
import type { CoverageLevel } from './sdk-coverage/CoverageStore';
import type { SafetyPolicy } from './tools/toolkit';

type Env = Record<string, string | undefined>;

/** packages/sdk-agent-qa/src → repository root */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Gateway route prefix per SDK package (pos-api-gateway application.yml).
 * `null` marks a service the gateway deliberately does not route: pos-tax
 * (`internal`) is a library service, and `documents` has no public route.
 * They are reachable only with an explicit QA_SERVICE_URL_<PKG>.
 */
const GATEWAY_PREFIX: Record<string, string | null> = {
  security: 'security-service',
  internal: null,
  documents: null,
};

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const schema = z.object({
  QA_MODELS: z.string().default(''),
  QA_TIMEZONE: z.string().default('America/New_York'),
  /** ISO weekdays the shop is open: 1 = Monday … 7 = Sunday. */
  QA_RUN_DAYS: z
    .string()
    .default('1,2,3,4,5,6')
    .transform((value) => value.split(',').map((day) => Number.parseInt(day.trim(), 10)))
    .refine((days) => days.length > 0 && days.every((day) => day >= 1 && day <= 7), 'must be ISO weekdays 1-7, comma-separated'),
  QA_STATE_DIR: z.string().default('.agent-qa'),
  QA_MODE: z.enum(['mutating', 'read-only']).default('mutating'),
  QA_ALLOW_DESTRUCTIVE: bool.default(false),
  QA_DENY: z.string().default(''),
  QA_COVERAGE_LEVEL: z.enum(['package', 'api', 'method']).default('package'),
  QA_SWEEP_MAX: intIn(0, 200).default(20),
  QA_SWEEP_WRITES: bool.default(false),
  QA_BACKSTOP_DAYS: intIn(0, 31).default(5),
  QA_MAX_STEPS: intIn(1, 500).default(30),
  QA_MAX_CALLS: intIn(1, 1000).default(40),
  QA_SCENARIO_TIMEOUT_MS: intIn(10_000, 3_600_000).default(600_000),
  QA_MAX_TOKENS: intIn(1_000, 50_000_000).default(400_000),
  QA_REQUEST_TIMEOUT_MS: intIn(1_000, 600_000).default(30_000),
  QA_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  QA_MAX_OUTPUT_TOKENS: intIn(64, 100_000).optional(),
  QA_POLL_SECONDS: intIn(5, 3_600).default(60),
  QA_JITTER_MINUTES: intIn(0, 120).default(10),
  /** A daily slot this late is skipped rather than run out of its time of day. */
  QA_MAX_LATENESS_MINUTES: intIn(1, 1_440).default(180),
  /** How many due scenarios one pass may run, and how long to leave between scenario starts. */
  QA_MAX_PER_TICK: intIn(1, 500).default(1),
  QA_MIN_GAP_MINUTES: intIn(0, 1_440).default(2),
  /** The day's customers. */
  QA_VISITS_MIN: intIn(0, 200).default(8),
  QA_VISITS_MAX: intIn(0, 200).default(12),
  QA_NEW_CUSTOMER_RATIO: z.coerce.number().min(0).max(1).default(0.3),
  QA_COMMERCIAL_RATIO: z.coerce.number().min(0).max(1).default(0.3),
  QA_NEW_VEHICLE_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  QA_OPEN_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00'),
  QA_CLOSE_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('17:30'),
  QA_SEED: z.coerce.number().int().default(0),
});

export interface QaConfig {
  modelChain: string;
  timezone: string;
  runDays: number[];
  stateDir: string;
  policy: SafetyPolicy;
  coverageLevel: CoverageLevel;
  sweepMax: number;
  /** Whether the coverage sweep may propose write operations (needed for method-level coverage). */
  sweepWrites: boolean;
  backstopDays: number;
  limits: { maxSteps: number; maxCalls: number; timeoutMs: number; maxTokens: number };
  requestTimeoutMs: number;
  temperature: number | undefined;
  maxOutputTokens: number | undefined;
  pollSeconds: number;
  jitterMinutes: number;
  maxLatenessMinutes: number;
  /** Due scenarios run per pass; the rest stay due. Keeps a backlog from turning into a burst. */
  maxPerTick: number;
  /** Minimum minutes between the end of one scenario and the start of the next pass. */
  minGapMinutes: number;
  /** How the day's customer visits are generated; `visitsMax` 0 turns them off. */
  day: DayPlanOptions;
  /** Base URL for a package's requests, or undefined when it cannot be reached. */
  baseUrlFor(pkg: string): string | undefined;
}

export function loadQaConfig(env: Env, gatewayBaseUrl: string): QaConfig {
  const picked = Object.fromEntries(
    Object.keys(schema.shape)
      .map((key) => [key, env[key]] as const)
      .filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = schema.safeParse(picked);
  const problems: string[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  const deny: RegExp[] = [];
  for (const pattern of (env['QA_DENY'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      deny.push(new RegExp(pattern));
    } catch {
      problems.push(`QA_DENY: "${pattern}" is not a valid regular expression`);
    }
  }
  if (parsed.success) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.QA_TIMEZONE });
    } catch {
      problems.push(`QA_TIMEZONE: "${parsed.data.QA_TIMEZONE}" is not an IANA time zone`);
    }
  }
  if (!parsed.success || problems.length > 0) {
    throw new Error(`Agent QA configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  const data = parsed.data;
  const gateway = gatewayBaseUrl.replace(/\/+$/, '');
  return {
    modelChain: data.QA_MODELS,
    timezone: data.QA_TIMEZONE,
    runDays: data.QA_RUN_DAYS,
    stateDir: path.isAbsolute(data.QA_STATE_DIR) ? data.QA_STATE_DIR : path.resolve(REPO_ROOT, data.QA_STATE_DIR),
    policy: { mode: data.QA_MODE, allowDestructive: data.QA_ALLOW_DESTRUCTIVE, deny },
    coverageLevel: data.QA_COVERAGE_LEVEL,
    sweepMax: data.QA_SWEEP_MAX,
    sweepWrites: data.QA_SWEEP_WRITES,
    backstopDays: data.QA_BACKSTOP_DAYS,
    limits: {
      maxSteps: data.QA_MAX_STEPS,
      maxCalls: data.QA_MAX_CALLS,
      timeoutMs: data.QA_SCENARIO_TIMEOUT_MS,
      maxTokens: data.QA_MAX_TOKENS,
    },
    requestTimeoutMs: data.QA_REQUEST_TIMEOUT_MS,
    temperature: data.QA_TEMPERATURE,
    maxOutputTokens: data.QA_MAX_OUTPUT_TOKENS,
    pollSeconds: data.QA_POLL_SECONDS,
    jitterMinutes: data.QA_JITTER_MINUTES,
    maxLatenessMinutes: data.QA_MAX_LATENESS_MINUTES,
    maxPerTick: data.QA_MAX_PER_TICK,
    minGapMinutes: data.QA_MIN_GAP_MINUTES,
    day: {
      visitsMin: Math.min(data.QA_VISITS_MIN, data.QA_VISITS_MAX),
      visitsMax: data.QA_VISITS_MAX,
      newCustomerRatio: data.QA_NEW_CUSTOMER_RATIO,
      commercialRatio: data.QA_COMMERCIAL_RATIO,
      newVehicleRatio: data.QA_NEW_VEHICLE_RATIO,
      openTime: data.QA_OPEN_TIME,
      closeTime: data.QA_CLOSE_TIME,
      seed: data.QA_SEED,
    },
    baseUrlFor(pkg: string): string | undefined {
      const direct = env[`QA_SERVICE_URL_${pkg.toUpperCase().replace(/-/g, '_')}`];
      if (direct) {
        return direct.replace(/\/+$/, '');
      }
      const prefix = pkg in GATEWAY_PREFIX ? GATEWAY_PREFIX[pkg] : pkg;
      return prefix === null ? undefined : `${gateway}/${prefix}`;
    },
  };
}
