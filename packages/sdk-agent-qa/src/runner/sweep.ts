/**
 * The two mechanisms behind "every SDK is called at least once a month".
 *
 * **The sweep** is a daily scenario with no fixed script: each day it is handed
 * the operations the month has not reached yet (a quota sized so the month
 * finishes covered) and the agent works out how to call each one — finding a
 * real id for a read that needs one, for instance.
 *
 * **The backstop** needs no model at all. In the last days of the month, any
 * unit still uncalled gets one deterministic probe: a GET, with required
 * parameters filled from their types. It may well answer 404 — that is still
 * the SDK method building, sending and decoding a real request, which is what
 * the promise is about. So the monthly guarantee holds even through a month in
 * which every model provider was down.
 */
import { randomUUID } from 'crypto';
import type { CoverageLevel, CoverageStore } from '../sdk-coverage/CoverageStore';
import type { Catalog, Operation, Risk, SchemaIR } from '../catalog/types';
import { SWEEP_SCENARIO_ID, SWEEP_SLOT } from '../scenarios/library';
import { scenarioSchema, type Scenario } from '../scenarios/types';
import type { SdkInvoker } from '../sdk/SdkInvoker';
import type { SafetyPolicy, ToolRuntime } from '../tools/toolkit';

export interface SweepPlanOptions {
  catalog: Catalog;
  coverage: CoverageStore;
  invoker: Pick<SdkInvoker, 'isReachable'>;
  policy: SafetyPolicy;
  level: CoverageLevel;
  quota: number;
  /** Whether write operations may be proposed. */
  writes: boolean;
}

export function sweepTargets(options: SweepPlanOptions): Operation[] {
  const allowed = new Set<Risk>(['read']);
  if (options.writes && options.policy.mode === 'mutating') {
    allowed.add('write');
  }
  return options.coverage.sweepTargets(options.catalog, {
    level: options.level,
    quota: options.quota,
    allowed,
    isReachable: (pkg) => options.invoker.isReachable(pkg),
    isDenied: (operation) => options.policy.deny.some((pattern) => pattern.test(operation.id)),
  });
}

/** The sweep as a scenario, or undefined when there is nothing left to reach. */
export function sweepScenario(targets: readonly Operation[]): Scenario | undefined {
  if (targets.length === 0) {
    return undefined;
  }
  const ids = targets.map((operation) => operation.id);
  return scenarioSchema.parse({
    id: SWEEP_SCENARIO_ID,
    title: 'Coverage sweep: operations not yet called this month',
    cadence: 'daily',
    at: SWEEP_SLOT,
    persona: 'admin',
    kind: 'operations',
    goal:
      `Call each of the ${ids.length} operations offered as direct tools at least once. They are unrelated to each other; ` +
      'work through them in order. For an operation that needs an id, first find a real one with a list or search call ' +
      '(sdk_search will find the matching list operation); if no record exists, use a random UUID and accept the 404. ' +
      'For a write, send a small, plausible, clearly test-tagged payload. One answered call per operation is enough — ' +
      'any HTTP status counts — so do not retry an operation that has answered. Report as findings any 5xx or any error ' +
      'without a code.',
    operations: ids,
    expect: [{ kind: 'reach', operations: ids, ratio: 0.6 }],
    limits: { maxSteps: Math.max(30, ids.length * 3), maxCalls: Math.max(40, ids.length * 3) },
  });
}

/** A value of the right type for a required parameter, or undefined when none can be made up safely. */
function synthesize(name: string, ir: SchemaIR): unknown {
  switch (ir.kind) {
    case 'string':
      return /id$/i.test(name) ? randomUUID() : 'qa-probe';
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'date':
      return new Date().toISOString();
    case 'enum':
      return ir.values[0];
    case 'array':
      return [];
    case 'nullable':
      return null;
    case 'object': {
      const value: Record<string, unknown> = {};
      for (const key of ir.required) {
        const made = synthesize(key, ir.properties[key]);
        if (made === undefined) {
          return undefined;
        }
        value[key] = made;
      }
      return value;
    }
    default:
      return undefined;
  }
}

export interface BackstopResult {
  probed: string[];
  /** Units for which no safe probe exists. */
  unreachable: string[];
}

/**
 * Probes every still-uncalled unit with one deterministic read.
 * Only `read` operations are ever used: a backstop must not create data.
 */
export async function runBackstop(
  runtime: ToolRuntime,
  options: Omit<SweepPlanOptions, 'quota' | 'writes'>,
): Promise<BackstopResult> {
  const targets = sweepTargets({ ...options, quota: Number.MAX_SAFE_INTEGER, writes: false });
  const probed: string[] = [];
  const unreachable: string[] = [];
  for (const operation of targets) {
    const input = synthesize('input', operation.input);
    if (input === undefined) {
      unreachable.push(operation.id);
      continue;
    }
    const result = await runtime.callOperation(operation, input, { persona: 'admin', source: 'backstop' });
    if (result['outcome'] === 'success' || result['outcome'] === 'http-error' || result['outcome'] === 'decode-error') {
      probed.push(operation.id);
    } else {
      unreachable.push(operation.id);
    }
  }
  return { probed, unreachable };
}
