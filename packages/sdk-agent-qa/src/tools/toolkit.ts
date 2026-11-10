/**
 * The tools a model is given for one scenario.
 *
 * With ~1,400 operations the catalog cannot be handed to a model as 1,400
 * tools: no context window or tool-selection accuracy survives that. Two
 * layers instead:
 *
 * - **Pinned tools** — the handful of operations a scenario names are exposed
 *   as first-class tools, one per operation, each with that operation's own
 *   Zod input schema. This is the fast, accurate path for known workflows.
 * - **Catalog tools** — `sdk_search`, `sdk_describe` and `sdk_call` reach every
 *   other operation on demand. This is how the coverage sweep and exploratory
 *   scenarios get to methods nobody wrote a scenario for.
 *
 * Every call, by either route, goes through {@link ToolRuntime.callOperation}:
 * one place that applies the safety policy, validates with Zod, invokes the
 * SDK and writes the ledger.
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { CoverageStore } from '../coverage/CoverageStore';
import type { Catalog, Operation, Risk } from '../catalog/types';
import { formatIssues, zodFromIr } from '../catalog/zodFromIr';
import type { CallLedger } from '../ledger/CallLedger';
import type { CallOutcome, SdkInvoker } from '../sdk/SdkInvoker';
import { shrink } from './shrink';

export interface QaTool {
  name: string;
  description: string;
  schema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

export interface SafetyPolicy {
  /** `read-only` refuses every write; `mutating` allows ordinary writes. */
  mode: 'read-only' | 'mutating';
  /** Destructive operations run only when this is set AND the scenario pins them. */
  allowDestructive: boolean;
  /** Operation ids matching any of these are never called. */
  deny: RegExp[];
}

export interface FinishReport {
  verdict: 'completed' | 'blocked' | 'failed';
  summary: string;
  findings: Array<{ severity: 'info' | 'warning' | 'defect'; operationId?: string; description: string }>;
}

export interface ToolRuntimeOptions {
  catalog: Catalog;
  invoker: SdkInvoker;
  ledger: CallLedger;
  coverage: CoverageStore;
  policy: SafetyPolicy;
  runId: string;
  scenarioId: string;
  /** Persona used unless a call names another. */
  persona: string;
  /** Personas a call may name. */
  personas: readonly string[];
  /** Operation ids this scenario pins. */
  pinned: readonly string[];
  /** Whether calls may skip client-side validation to provoke server-side errors. */
  allowUnvalidated: boolean;
  /** Hard ceiling on SDK calls for the scenario. */
  maxCalls: number;
  /** Characters of response body returned to the model per call. */
  resultBudget?: number;
  now?: () => Date;
}

const MAX_TOOL_NAME = 64;

export const finishSchema = z.strictObject({
  verdict: z
    .enum(['completed', 'blocked', 'failed'])
    .describe('completed: the goal was achieved. blocked: a precondition could not be met. failed: the backend misbehaved.'),
  summary: z.string().describe('Two or three sentences on what was done and what was observed.'),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(['info', 'warning', 'defect']),
        operationId: z.string().optional(),
        description: z.string(),
      }),
    )
    .default([])
    .describe('Anything a QA engineer should look at: unexpected statuses, wrong data, confusing errors.'),
});

/** `order.RegisterSessionsApi.openRegisterSession` → `order__RegisterSessionsApi__openRegisterSession` */
export function toolNameFor(operation: Operation): string {
  const name = operation.id.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\./g, '__');
  if (name.length <= MAX_TOOL_NAME) {
    return name;
  }
  // Keep the method (the informative end) whole and trim the class name.
  const tail = `__${operation.method}`;
  return `${name.slice(0, Math.max(1, MAX_TOOL_NAME - tail.length))}${tail}`.slice(-MAX_TOOL_NAME);
}

export class ToolRuntime {
  private calls = 0;
  private finished: FinishReport | undefined;
  private readonly validators = new Map<string, z.ZodType>();
  private readonly now: () => Date;

  constructor(private readonly options: ToolRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get finishReport(): FinishReport | undefined {
    return this.finished;
  }

  get callCount(): number {
    return this.calls;
  }

  private validatorFor(operation: Operation): z.ZodType {
    let validator = this.validators.get(operation.id);
    if (!validator) {
      validator = zodFromIr(operation.input);
      this.validators.set(operation.id, validator);
    }
    return validator;
  }

  /** Why the policy refuses this operation, or undefined when it may run. */
  refusal(operation: Operation): string | undefined {
    const { policy, pinned, invoker } = this.options;
    if (policy.deny.some((pattern) => pattern.test(operation.id))) {
      return `${operation.id} is on the deny list for this harness`;
    }
    if (!invoker.isReachable(operation.pkg)) {
      return `package "${operation.pkg}" is not reachable on this backend`;
    }
    if (operation.risk === 'read') {
      return undefined;
    }
    if (policy.mode === 'read-only') {
      return `${operation.id} is a ${operation.risk} operation and this run is read-only`;
    }
    if (operation.risk === 'destructive' && !(policy.allowDestructive && pinned.includes(operation.id))) {
      return `${operation.id} is destructive; it runs only when a scenario pins it and the run allows destructive calls`;
    }
    return undefined;
  }

  async callOperation(
    operation: Operation,
    rawInput: unknown,
    call: { persona?: string; validate?: boolean; source?: 'agent' | 'backstop' } = {},
  ): Promise<Record<string, unknown>> {
    const refusal = this.refusal(operation);
    if (refusal) {
      return { outcome: 'refused', reason: refusal };
    }
    if (this.calls >= this.options.maxCalls) {
      return { outcome: 'refused', reason: `call budget of ${this.options.maxCalls} for this scenario is spent; call finish` };
    }
    const persona = call.persona ?? this.options.persona;
    if (!this.options.personas.includes(persona)) {
      return { outcome: 'refused', reason: `unknown persona "${persona}"; available: ${this.options.personas.join(', ')}` };
    }

    const validate = call.validate !== false;
    if (!validate && !this.options.allowUnvalidated) {
      return { outcome: 'refused', reason: 'this scenario does not allow unvalidated calls' };
    }

    let input: Record<string, unknown> =
      typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
        ? { ...(rawInput as Record<string, unknown>) }
        : {};
    if (validate) {
      // The backend requires the header on these operations; supplying one by
      // default keeps a model from failing on a UUID it has no reason to care
      // about. A scenario that tests the contract passes its own (or a blank).
      if (operation.takesIdempotencyKey && input['idempotencyKey'] === undefined) {
        input['idempotencyKey'] = randomUUID();
      }
      const parsed = this.validatorFor(operation).safeParse(input);
      if (!parsed.success) {
        return {
          outcome: 'invalid-input',
          issues: formatIssues(parsed.error).slice(0, 12),
          hint: 'Nothing was sent. Fix the input (see sdk_describe for the schema) and call again.',
        };
      }
      input = parsed.data as Record<string, unknown>;
    }

    this.calls += 1;
    const outcome: CallOutcome = await this.options.invoker.invoke(operation, input, persona);
    const record = {
      at: this.now().toISOString(),
      runId: this.options.runId,
      scenarioId: this.options.scenarioId,
      operationId: operation.id,
      pkg: operation.pkg,
      persona,
      kind: outcome.kind,
      status: outcome.status,
      errorCode: outcome.errorCode,
      httpMethod: outcome.httpMethod,
      requestPath: outcome.requestPath,
      correlationId: outcome.correlationId,
      durationMs: outcome.durationMs,
      unvalidated: validate ? undefined : true,
      source: call.source ?? ('agent' as const),
    };
    this.options.ledger.record(record);
    this.options.coverage.record(record);

    return {
      outcome: outcome.kind,
      status: outcome.status,
      errorCode: outcome.errorCode,
      message: outcome.message,
      body: shrink(outcome.body, this.options.resultBudget ?? 4000),
      correlationId: outcome.correlationId,
    };
  }

  private describe(operation: Operation): string {
    const prefix = `[${operation.http} ${operation.path}] ${operation.summary}.`;
    const text = `${prefix} ${operation.description}`;
    return text.length > 1800 ? `${text.slice(0, 1799)}…` : text;
  }

  private pinnedTools(): QaTool[] {
    const tools: QaTool[] = [];
    const names = new Set<string>();
    for (const id of this.options.pinned) {
      const operation = this.options.catalog.byId.get(id);
      if (!operation) {
        continue; // A scenario naming a method the client no longer has is reported by the scenario check, not here.
      }
      let name = toolNameFor(operation);
      for (let suffix = 2; names.has(name); suffix += 1) {
        name = `${toolNameFor(operation).slice(0, MAX_TOOL_NAME - 2)}_${suffix}`;
      }
      names.add(name);
      tools.push({
        name,
        description: this.describe(operation),
        schema: this.validatorFor(operation),
        execute: (input) => this.callOperation(operation, input),
      });
    }
    return tools;
  }

  private search(query: string, pkg: string | undefined, risk: Risk | undefined, limit: number): unknown {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 1);
    const scored = this.options.catalog.operations
      .filter((operation) => (!pkg || operation.pkg === pkg) && (!risk || operation.risk === risk))
      .map((operation) => {
        const id = operation.id.toLowerCase();
        const summary = operation.summary.toLowerCase();
        const body = `${operation.path} ${operation.description}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          score += (id.includes(term) ? 5 : 0) + (summary.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0);
        }
        return { operation, score };
      })
      .filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.operation.id.localeCompare(b.operation.id))
      .slice(0, limit);
    return {
      matches: scored.map(({ operation }) => ({
        operationId: operation.id,
        http: `${operation.http} ${operation.path}`,
        summary: operation.summary,
        risk: operation.risk,
        calledThisMonth: this.options.coverage.isCalled(operation.id),
      })),
      packages: pkg ? undefined : this.options.catalog.packages,
    };
  }

  private catalogTools(): QaTool[] {
    const { catalog } = this.options;
    const lookup = (operationId: string): Operation | string =>
      catalog.byId.get(operationId) ?? `no operation "${operationId}"; use sdk_search to find the exact operationId`;

    return [
      {
        name: 'sdk_search',
        description:
          'Find SDK operations by keyword. Returns operation ids with their HTTP route, summary and risk. ' +
          'Use it to discover operations beyond the ones offered as direct tools.',
        schema: z.strictObject({
          query: z.string().describe('Keywords, e.g. "purchase order receive" or "cycle count". Empty lists everything in the package.'),
          pkg: z.string().optional().describe('Restrict to one SDK package, e.g. "inventory"'),
          risk: z.enum(['read', 'write', 'destructive']).optional(),
          limit: z.number().int().min(1).max(40).optional(),
        }),
        execute: async (input) => {
          const { query, pkg, risk, limit } = input as { query: string; pkg?: string; risk?: Risk; limit?: number };
          return this.search(query, pkg, risk, limit ?? 15);
        },
      },
      {
        name: 'sdk_describe',
        description:
          "Get one operation's full description, preconditions, documented error statuses and input JSON Schema. " +
          'Call this before sdk_call for an operation you have not used.',
        schema: z.strictObject({ operationId: z.string() }),
        execute: async (input) => {
          const operation = lookup((input as { operationId: string }).operationId);
          if (typeof operation === 'string') {
            return { error: operation };
          }
          return {
            operationId: operation.id,
            http: `${operation.http} ${operation.path}`,
            risk: operation.risk,
            refusedBecause: this.refusal(operation),
            summary: operation.summary,
            description: operation.description,
            inputSchema: z.toJSONSchema(this.validatorFor(operation), { unrepresentable: 'any' }),
          };
        },
      },
      {
        name: 'sdk_call',
        description:
          'Call any SDK operation by id. The input is validated against the operation schema before anything is sent; ' +
          'an "invalid-input" result means nothing was sent. HTTP errors are returned as results, not thrown. ' +
          'An Idempotency-Key is generated when the operation needs one and none is given.',
        schema: z.strictObject({
          operationId: z.string(),
          input: z.record(z.string(), z.any()).default({}).describe('Request parameters, per sdk_describe'),
          persona: z.string().optional().describe(`Who makes the call. One of: ${this.options.personas.join(', ')}`),
          validate: z
            .boolean()
            .optional()
            .describe('false sends the input as-is, skipping client-side validation, to provoke a server-side 400/422'),
        }),
        execute: async (input) => {
          const args = input as { operationId: string; input: Record<string, unknown>; persona?: string; validate?: boolean };
          const operation = lookup(args.operationId);
          if (typeof operation === 'string') {
            return { outcome: 'refused', reason: operation };
          }
          return this.callOperation(operation, args.input, { persona: args.persona, validate: args.validate });
        },
      },
    ];
  }

  tools(): QaTool[] {
    return [
      ...this.pinnedTools(),
      ...this.catalogTools(),
      {
        name: 'finish',
        description: 'End the scenario and report what happened. Call exactly once, when the goal is met or cannot be.',
        schema: finishSchema,
        execute: async (input) => {
          this.finished = input as FinishReport;
          return { acknowledged: true };
        },
      },
    ];
  }
}
