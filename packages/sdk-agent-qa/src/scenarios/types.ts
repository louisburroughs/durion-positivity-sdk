/**
 * What a scenario is: a goal in plain language, the operations it is expected
 * to need, when it happens in the life of a shop, and what must be true of the
 * calls it made for it to count as passed.
 */
import { z } from 'zod';

export const PERSONAS = ['admin', 'advisor', 'tech', 'manager', 'parts', 'acct', 'controller'] as const;
export type Persona = (typeof PERSONAS)[number];

/**
 * A fact that must be visible in the call ledger. Expectations are about calls,
 * never about what the model says it did.
 */
export const expectationSchema = z.discriminatedUnion('kind', [
  /** The operation was called and the backend answered (`any`), or answered 2xx (`success`). */
  z.strictObject({ kind: z.literal('call'), operation: z.string(), outcome: z.enum(['any', 'success']).default('any') }),
  /** At least `min` calls (to `operations`, when given) were answered with one of `statuses`. */
  z.strictObject({
    kind: z.literal('http'),
    statuses: z.array(z.number().int()).min(1),
    operations: z.array(z.string()).optional(),
    min: z.number().int().min(1).default(1),
  }),
  /** At least `min` calls reached a backend. */
  z.strictObject({ kind: z.literal('calls'), min: z.number().int().min(1) }),
  /** At least `ratio` of `operations` were called. Used by the coverage sweep. */
  z.strictObject({ kind: z.literal('reach'), operations: z.array(z.string()), ratio: z.number().min(0).max(1) }),
]);
export type Expectation = z.infer<typeof expectationSchema>;
export type ExpectationInput = z.input<typeof expectationSchema>;

const slot = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h, shop-local time)');

export const scenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  /** Time of day the activity happens, in the shop's time zone. */
  at: slot,
  /** Weekly scenarios: ISO weekday, 1 = Monday. */
  weekday: z.number().int().min(1).max(7).optional(),
  /** Monthly scenarios: day of the month (1-28). Runs on the first open day on or after it. */
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  persona: z.enum(PERSONAS),
  /** `operations` replays normal work; `error` deliberately provokes failures. */
  kind: z.enum(['operations', 'error']),
  /**
   * A routine every shop does for itself (opening, receiving, closing): run
   * once per site, each instance told which location it is at.
   */
  perSite: z.boolean().default(false),
  /**
   * Helpers beyond the SDK that the task needs: `bank_statement` is the mock
   * bank (tools/mockBank.ts); `request_id` mints the time-ordered ids some
   * accounting requests require.
   */
  tools: z.array(z.enum(['bank_statement', 'request_id'])).default([]),
  /** Skipped (not failed) when every persona shares the admin login, where a 403 can never happen. */
  requiresRoleMode: z.boolean().default(false),
  goal: z.string(),
  /** Operation ids exposed to the model as direct tools. */
  operations: z.array(z.string()),
  expect: z.array(expectationSchema),
  limits: z
    .strictObject({
      maxSteps: z.number().int().positive().optional(),
      maxCalls: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .default({}),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;

export function defineScenarios(inputs: ScenarioInput[]): Scenario[] {
  const scenarios = inputs.map((input) => {
    const scenario = scenarioSchema.parse(input);
    if (scenario.cadence === 'weekly' && scenario.weekday === undefined) {
      throw new Error(`weekly scenario ${scenario.id} needs a weekday`);
    }
    if (scenario.cadence === 'monthly' && scenario.dayOfMonth === undefined) {
      throw new Error(`monthly scenario ${scenario.id} needs a dayOfMonth`);
    }
    return scenario;
  });
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) {
      throw new Error(`duplicate scenario id ${scenario.id}`);
    }
    seen.add(scenario.id);
  }
  return scenarios;
}
