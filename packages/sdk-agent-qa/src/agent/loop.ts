/**
 * The execution loop: model turn → validate tool calls → execute → feed results
 * back, until the scenario finishes or a limit stops it.
 *
 * The loop is owned here rather than delegated to a framework's multi-step
 * mode, because the properties this harness needs are properties of the loop:
 *
 * - every tool input is validated with Zod here, and a rejected input goes back
 *   to the model as a readable result it can correct, never as an exception;
 * - a tool that throws is a result too — one bad call cannot end a run;
 * - step, wall-clock and token ceilings are enforced between turns, so a run
 *   always ends and always says why;
 * - a model that repeats itself is told so, then stopped;
 * - the model is reached only through {@link ModelPort}, so a provider can fail
 *   over mid-conversation (see aiSdkModel.ts) and the loop is unit-testable
 *   with a scripted model.
 *
 * The loop knows nothing about SDKs, scenarios or HTTP. It runs tools.
 */
import type { z } from 'zod';
import { formatIssues } from '../catalog/zodFromIr';

export interface LoopTool {
  name: string;
  description: string;
  schema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type LoopMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[] }
  | { role: 'tool'; results: Array<{ id: string; name: string; output: unknown }> };

export interface ModelTurn {
  text: string;
  toolCalls: ModelToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /** Which model actually answered (the adapter may have failed over). */
  model: string;
}

export interface ModelRequest {
  system: string;
  messages: LoopMessage[];
  tools: LoopTool[];
  abortSignal?: AbortSignal;
}

export interface ModelPort {
  generate(request: ModelRequest): Promise<ModelTurn>;
}

export type LoopStatus =
  /** The finish tool was called. */
  | 'finished'
  | 'max-steps'
  | 'timeout'
  | 'token-budget'
  /** The model kept making the same call. */
  | 'stalled'
  /** The model stopped calling tools without finishing, even after being reminded. */
  | 'no-finish'
  /** Every configured model failed. */
  | 'model-error';

export interface LoopLimits {
  maxSteps: number;
  timeoutMs: number;
  maxTokens: number;
}

export interface LoopOptions {
  model: ModelPort;
  system: string;
  prompt: string;
  tools: LoopTool[];
  /** Name of the tool whose successful call ends the loop. */
  finishTool: string;
  limits: LoopLimits;
  /** Called after each event, for transcripts and live logging. */
  onEvent?(event: LoopEvent): void;
  now?: () => number;
}

export type LoopEvent =
  | { type: 'model'; step: number; model: string; text: string; toolCalls: ModelToolCall[] }
  | { type: 'tool'; step: number; name: string; input: unknown; output: unknown }
  | { type: 'end'; status: LoopStatus; detail?: string };

export interface LoopResult {
  status: LoopStatus;
  detail?: string;
  steps: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  /** Models that answered at least one turn. */
  models: string[];
}

const REPEAT_WARN = 3;
const REPEAT_STOP = 5;
const MAX_NUDGES = 2;

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as object).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  } catch {
    return String(value);
  }
}

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.limits.timeoutMs;
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const messages: LoopMessage[] = [{ role: 'user', content: options.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const models = new Set<string>();
  const repeats = new Map<string, number>();
  let toolCalls = 0;
  let nudges = 0;
  let steps = 0;

  const end = (status: LoopStatus, detail?: string): LoopResult => {
    options.onEvent?.({ type: 'end', status, detail });
    return { status, detail, steps, toolCalls, usage, models: [...models] };
  };

  while (steps < options.limits.maxSteps) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      return end('timeout', `exceeded ${options.limits.timeoutMs} ms`);
    }
    if (usage.inputTokens + usage.outputTokens >= options.limits.maxTokens) {
      return end('token-budget', `spent ${usage.inputTokens + usage.outputTokens} tokens`);
    }

    steps += 1;
    let turn: ModelTurn;
    try {
      turn = await options.model.generate({
        system: options.system,
        messages,
        tools: options.tools,
        abortSignal: AbortSignal.timeout(remaining),
      });
    } catch (error) {
      if (now() >= deadline) {
        return end('timeout', `exceeded ${options.limits.timeoutMs} ms`);
      }
      return end('model-error', error instanceof Error ? error.message : String(error));
    }
    usage.inputTokens += turn.usage.inputTokens;
    usage.outputTokens += turn.usage.outputTokens;
    models.add(turn.model);
    options.onEvent?.({ type: 'model', step: steps, model: turn.model, text: turn.text, toolCalls: turn.toolCalls });
    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

    if (turn.toolCalls.length === 0) {
      if (nudges >= MAX_NUDGES) {
        return end('no-finish', 'the model stopped calling tools without calling the finish tool');
      }
      nudges += 1;
      messages.push({
        role: 'user',
        content: `You replied without calling a tool. Continue with the next tool call, or call ${options.finishTool} to report the result.`,
      });
      continue;
    }

    const results: Array<{ id: string; name: string; output: unknown }> = [];
    let finished = false;
    let stalled: string | undefined;
    for (const call of turn.toolCalls) {
      let output: unknown;
      const tool = toolsByName.get(call.name);
      if (!tool) {
        output = { error: `no tool named "${call.name}"`, available: [...toolsByName.keys()].slice(0, 40) };
      } else {
        const key = `${call.name}:${stableKey(call.input)}`;
        const seen = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, seen);
        const parsed = tool.schema.safeParse(call.input ?? {});
        if (seen >= REPEAT_STOP) {
          stalled = call.name;
          output = { error: 'this exact call has been made repeatedly; the scenario is being stopped' };
        } else if (!parsed.success) {
          output = { outcome: 'invalid-input', issues: formatIssues(parsed.error).slice(0, 12), hint: 'Nothing ran. Correct the input and call again.' };
        } else {
          try {
            toolCalls += 1;
            output = await tool.execute(parsed.data);
            if (call.name === options.finishTool) {
              finished = true;
            }
          } catch (error) {
            output = { error: `tool failed: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (seen >= REPEAT_WARN && typeof output === 'object' && output !== null) {
            output = { ...output, warning: `you have made this identical call ${seen} times; change approach or finish` };
          }
        }
      }
      options.onEvent?.({ type: 'tool', step: steps, name: call.name, input: call.input, output });
      results.push({ id: call.id, name: call.name, output });
    }
    messages.push({ role: 'tool', results });

    if (finished) {
      return end('finished');
    }
    if (stalled) {
      return end('stalled', `repeated identical call to ${stalled}`);
    }
  }
  return end('max-steps', `reached ${options.limits.maxSteps} steps`);
}
