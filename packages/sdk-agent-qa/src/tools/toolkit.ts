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
import type { CoverageStore } from '../sdk-coverage/CoverageStore';
import type { Catalog, Operation, Risk, SchemaIR } from '../catalog/types';
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
  /**
   * Paying a vendor moves money through the payment gateway, so it has limits
   * the harness enforces itself rather than leaving to a prompt. Defaults to
   * {@link DEFAULT_VENDOR_PAYMENTS} when not given.
   */
  vendorPayments?: VendorPaymentLimits;
}

export interface VendorPaymentLimits {
  /** False refuses every vendor payment. */
  enabled: boolean;
  /** Largest gross amount of one payment, in the functional currency. */
  maxAmount: number;
  /** Most payments one scenario run may execute. */
  maxPerRun: number;
}

export const DEFAULT_VENDOR_PAYMENTS: VendorPaymentLimits = { enabled: true, maxAmount: 5000, maxPerRun: 5 };

const VENDOR_PAYMENT = 'accounting.APPaymentsApi.executeApPayment';

/** Operations that can set a pay period's lifecycle status. */
const PAY_PERIOD_STATUS: ReadonlySet<string> = new Set([
  'people.TimePeriodManagementAPIApi.transitionTimePeriod',
  'people.TimePeriodManagementAPIApi.createTimePeriod',
]);

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
  /**
   * Facts carried between the stages of one customer visit (ids, names, what
   * the customer decided). When given, the model gets a `remember` tool.
   */
  memory?: Record<string, string>;
  /** Task-specific helpers that are not SDK operations (the mock bank, request ids). */
  extraTools?: QaTool[];
  /** Called after every answered call, with the full response body. */
  onCall?(operation: Operation, outcome: CallOutcome): void;
  /** Pause used by the `wait` tool. */
  sleep?(ms: number): Promise<void>;
  /** Characters of response body returned to the model per call. */
  resultBudget?: number;
  now?: () => Date;
}

const MAX_TOOL_NAME = 64;

const FACT_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** Characters of each field description kept in a pinned tool's schema. */
const LEAN_FIELD_DESCRIPTION = 100;

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

/** An operation's input as the model is offered it: without the Idempotency-Key, which the runtime supplies. */
function modelInput(operation: Operation): SchemaIR {
  const ir = operation.input;
  if (!operation.takesIdempotencyKey || ir.kind !== 'object') {
    return ir;
  }
  const properties = Object.fromEntries(Object.entries(ir.properties).filter(([name]) => name !== 'idempotencyKey'));
  return { ...ir, properties, required: ir.required.filter((name) => name !== 'idempotencyKey') };
}

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
  private vendorPaymentsMade = 0;
  private finished: FinishReport | undefined;
  private readonly validators = new Map<string, z.ZodType>();
  private readonly leanValidators = new Map<string, z.ZodType>();
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
      validator = zodFromIr(modelInput(operation));
      this.validators.set(operation.id, validator);
    }
    return validator;
  }

  /**
   * The same validator with field descriptions cut to their first sentence: the
   * schema a pinned tool is offered with. It is resent on every model turn, so
   * the full field text stays behind sdk_describe.
   */
  private leanValidatorFor(operation: Operation): z.ZodType {
    let validator = this.leanValidators.get(operation.id);
    if (!validator) {
      validator = zodFromIr(modelInput(operation), { maxDescription: LEAN_FIELD_DESCRIPTION });
      this.leanValidators.set(operation.id, validator);
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
    if (operation.id === VENDOR_PAYMENT) {
      const limits = policy.vendorPayments ?? DEFAULT_VENDOR_PAYMENTS;
      if (!limits.enabled) {
        return 'vendor payments are turned off for this harness (QA_PAY_VENDORS=false)';
      }
      // Money leaves only from the routine whose job it is, never from a sweep or a search-and-call.
      if (!pinned.includes(operation.id)) {
        return 'a vendor payment is executed only by the payment run, not from this task';
      }
    }
    return undefined;
  }

  /** Why this particular vendor payment is refused, or undefined when it is within the limits. */
  private vendorPaymentRefusal(input: Record<string, unknown>): string | undefined {
    const limits = this.options.policy.vendorPayments ?? DEFAULT_VENDOR_PAYMENTS;
    const request = (input['executeAPPaymentRequest'] ?? {}) as Record<string, unknown>;
    const gross = Number(request['grossAmount']);
    if (this.vendorPaymentsMade >= limits.maxPerRun) {
      return `this run has already made ${limits.maxPerRun} vendor payments, which is its limit`;
    }
    if (!Number.isFinite(gross) || gross <= 0) {
      return 'a vendor payment needs a positive grossAmount';
    }
    if (gross > limits.maxAmount) {
      return `a single vendor payment may not exceed ${limits.maxAmount.toFixed(2)}; this one is ${gross.toFixed(2)}. Pay part of the bill, or leave it for a person`;
    }
    if (request['overrideJustification'] !== undefined) {
      return 'overriding a payment control is a person\'s decision; send the payment without overrideJustification';
    }
    return undefined;
  }

  async callOperation(
    operation: Operation,
    rawInput: unknown,
    call: { persona?: string; validate?: boolean; source?: 'agent' | 'backstop' | 'harness' } = {},
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
      // The Idempotency-Key is never the model's to write: it is not in the schema the model sees,
      // any key it sends anyway is dropped, and a fresh UUID goes with every validated call. A model
      // left to it invents keys that are not UUIDs and spends turns on the 400. The error drill that
      // tests the header sends its own with validate=false, which reaches the backend as written.
      delete input['idempotencyKey'];
      const parsed = this.validatorFor(operation).safeParse(input);
      if (!parsed.success) {
        return {
          outcome: 'invalid-input',
          issues: formatIssues(parsed.error).slice(0, 12),
          hint: 'Nothing was sent. Fix the input (see sdk_describe for the schema) and call again.',
        };
      }
      input = parsed.data as Record<string, unknown>;
      if (operation.takesIdempotencyKey) {
        input['idempotencyKey'] = randomUUID();
      }
    }

    // Closing a pay period for payroll cannot be undone, so it is not left to a prompt either.
    if (PAY_PERIOD_STATUS.has(operation.id) && !this.options.policy.allowDestructive) {
      const body = Object.values(input).find((value) => typeof value === 'object' && value !== null) as Record<string, unknown> | undefined;
      if (body?.['status'] === 'PAYROLL_CLOSED') {
        return {
          outcome: 'refused',
          reason: 'marking a pay period PAYROLL_CLOSED cannot be undone and is payroll\'s step; the harness does not do it',
        };
      }
    }

    if (operation.id === VENDOR_PAYMENT) {
      // Checked on the validated input, and whether or not validation was asked for.
      const refused = this.vendorPaymentRefusal(input);
      if (refused) {
        return { outcome: 'refused', reason: refused };
      }
      this.vendorPaymentsMade += 1;
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
    this.options.onCall?.(operation, outcome);

    // "Not yet", not "no": a record created moments ago has not reached the service being asked.
    // The 503s say so outright; the 409 and the PO-reference refusal are the same lag seen from
    // receiving, where a purchase order approved seconds ago is not in inventory's copy yet.
    const transient =
      (outcome.status === 503 && /(_REPLICATION_PENDING|^CUSTOMER_REQUIREMENTS_UNAVAILABLE)$/.test(outcome.errorCode ?? '')) ||
      /^(SOURCE_DOCUMENT_LINES_UNAVAILABLE|INVALID_PO_REFERENCE)$/.test(outcome.errorCode ?? '');

    return {
      outcome: outcome.kind,
      status: outcome.status,
      errorCode: outcome.errorCode,
      message: outcome.message,
      body: shrink(outcome.body, this.options.resultBudget ?? 4000),
      correlationId: outcome.correlationId,
      hint: transient
        ? 'Temporary: a record created moments ago has not replicated yet. Call wait for 10 seconds, then repeat this exact call (up to 6 times).'
        : undefined,
    };
  }

  /**
   * A pinned tool's description: route and summary only. Preconditions, events
   * and error statuses run to kilobytes per operation and would be resent on
   * every turn; sdk_describe returns them when the model needs them.
   */
  private describe(operation: Operation): string {
    return `[${operation.http} ${operation.path}] ${operation.summary}. Full rules and errors: sdk_describe.`;
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
        schema: this.leanValidatorFor(operation),
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
          'The Idempotency-Key is always generated for you; do not send one.',
        // Loose, and `input` may be an object or a JSON string: some models drop an open-ended nested
        // object from a tool call, and then put its fields beside operationId or send it as text.
        schema: z.looseObject({
          operationId: z.string(),
          input: z
            .union([z.record(z.string(), z.any()), z.string()])
            .optional()
            .describe('The operation\'s parameters as one object, per sdk_describe, e.g. {"estimateId": "...", "addEstimateItemRequest": {...}}'),
          persona: z.string().optional().describe(`Who makes the call. One of: ${this.options.personas.join(', ')}`),
          validate: z
            .boolean()
            .optional()
            .describe('false sends the input as-is, skipping client-side validation, to provoke a server-side 400/422'),
        }),
        execute: async (input) => {
          const { operationId, input: given, persona, validate, ...beside } = input as {
            operationId: string;
            input?: Record<string, unknown> | string;
            persona?: string;
            validate?: boolean;
          } & Record<string, unknown>;
          const operation = lookup(operationId);
          if (typeof operation === 'string') {
            return { outcome: 'refused', reason: operation };
          }
          let parameters: unknown = given ?? beside;
          if (typeof parameters === 'string') {
            try {
              parameters = JSON.parse(parameters);
            } catch {
              return { outcome: 'invalid-input', issues: ['input: not a JSON object'], hint: 'Nothing was sent. Pass input as an object.' };
            }
          }
          return this.callOperation(operation, parameters, { persona, validate });
        },
      },
    ];
  }

  private utilityTools(): QaTool[] {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const tools: QaTool[] = [
      {
        name: 'wait',
        description:
          'Pause for a few seconds. Use it when a result says a record has not replicated yet, or when the task says to wait, then retry.',
        schema: z.strictObject({ seconds: z.number().min(1).max(30) }),
        execute: async (input) => {
          const { seconds } = input as { seconds: number };
          await sleep(seconds * 1000);
          return { waited: seconds };
        },
      },
    ];
    const { memory } = this.options;
    if (memory) {
      tools.push({
        name: 'remember',
        description:
          'Save facts about this customer visit for the colleague who handles its next step, later today or the next working day ' +
          '(names, what the customer decided). Save them all in one call, as facts: {"key": "value", ...}. Ids returned by the ' +
          'calls that create records are saved for you. Saving a key again replaces its value.',
        schema: z
          .strictObject({
            facts: z
              .record(z.string().regex(FACT_KEY, 'a short camelCase name, e.g. customerName'), z.string().min(1).max(300))
              .optional()
              .describe('Every fact to save, by key'),
            key: z.string().regex(FACT_KEY, 'a short camelCase name, e.g. customerName').optional().describe('One fact\'s key, when saving one'),
            value: z.string().min(1).max(300).optional(),
          })
          .refine((input) => (input.facts && Object.keys(input.facts).length > 0) || (input.key && input.value), {
            message: 'give facts: {"key": "value", ...}',
          }),
        execute: async (input) => {
          const { facts, key, value } = input as { facts?: Record<string, string>; key?: string; value?: string };
          Object.assign(memory, facts ?? {});
          if (key && value) {
            memory[key] = value;
          }
          return { remembered: Object.keys(memory) };
        },
      });
    }
    return tools;
  }

  tools(): QaTool[] {
    return [
      ...this.pinnedTools(),
      ...this.catalogTools(),
      ...this.utilityTools(),
      ...(this.options.extraTools ?? []),
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
