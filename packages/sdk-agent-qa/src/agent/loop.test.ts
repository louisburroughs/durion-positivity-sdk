import { z } from 'zod';
import { call, lastToolOutputs, ScriptedModel, type Script } from '../testing/fakes';
import { runLoop, type LoopEvent, type LoopLimits, type LoopTool } from './loop';

const LIMITS: LoopLimits = { maxSteps: 10, timeoutMs: 60_000, maxTokens: 1_000_000 };

function tools(overrides: Partial<Record<string, LoopTool['execute']>> = {}): { tools: LoopTool[]; echoed: unknown[] } {
  const echoed: unknown[] = [];
  return {
    echoed,
    tools: [
      {
        name: 'echo',
        description: 'echo',
        schema: z.strictObject({ text: z.string() }),
        execute:
          overrides['echo'] ??
          (async (input) => {
            echoed.push(input);
            return { said: (input as { text: string }).text };
          }),
      },
      { name: 'finish', description: 'finish', schema: z.strictObject({ summary: z.string() }), execute: async () => ({ acknowledged: true }) },
    ],
  };
}

const run = (script: Script, options: { limits?: Partial<LoopLimits>; tools?: LoopTool[]; now?: () => number; tokens?: number } = {}) => {
  const model = new ScriptedModel(script, options.tokens);
  const events: LoopEvent[] = [];
  const result = runLoop({
    model,
    system: 'system',
    prompt: 'task',
    tools: options.tools ?? tools().tools,
    finishTool: 'finish',
    limits: { ...LIMITS, ...options.limits },
    onEvent: (event) => events.push(event),
    now: options.now,
  });
  return { model, events, result };
};

describe('runLoop', () => {
  it('runs tools, feeds each result back, and ends when the finish tool is called', async () => {
    const { tools: set, echoed } = tools();
    const { model, result } = run([[call('echo', { text: 'hi' })], [call('finish', { summary: 'done' })]], { tools: set });
    await expect(result).resolves.toMatchObject({ status: 'finished', steps: 2, toolCalls: 2, usage: { inputTokens: 20, outputTokens: 20 } });
    expect(echoed).toEqual([{ text: 'hi' }]);
    expect(lastToolOutputs(model.requests[1].messages)).toEqual([{ said: 'hi' }]);
  });

  it('returns a rejected input to the model as a result, without running the tool', async () => {
    const { tools: set, echoed } = tools();
    const { model, result } = run([[call('echo', { txt: 'typo' })], [call('echo', { text: 'fixed' })], [call('finish', { summary: 'ok' })]], { tools: set });
    await expect(result).resolves.toMatchObject({ status: 'finished', toolCalls: 2 });
    expect(echoed).toEqual([{ text: 'fixed' }]);
    const [rejection] = lastToolOutputs(model.requests[1].messages) as Array<{ outcome: string; issues: string[] }>;
    expect(rejection.outcome).toBe('invalid-input');
    expect(rejection.issues.join(' ')).toMatch(/text/);
  });

  it('answers a call to a tool that does not exist with the tools that do', async () => {
    const { model, result } = run([[call('ecko', {})], [call('finish', { summary: 'ok' })]]);
    await expect(result).resolves.toMatchObject({ status: 'finished' });
    expect(lastToolOutputs(model.requests[1].messages)[0]).toMatchObject({ error: 'no tool named "ecko"', available: ['echo', 'finish'] });
  });

  it('survives a tool that throws', async () => {
    const set = tools({
      echo: async () => {
        throw new Error('socket hang up');
      },
    }).tools;
    const { model, result } = run([[call('echo', { text: 'x' })], [call('finish', { summary: 'ok' })]], { tools: set });
    await expect(result).resolves.toMatchObject({ status: 'finished' });
    expect(lastToolOutputs(model.requests[1].messages)[0]).toEqual({ error: 'tool failed: socket hang up' });
  });

  it('does not finish on a finish call whose input is invalid', async () => {
    const { result } = run([[call('finish', {})], [call('finish', { summary: 'now valid' })]]);
    await expect(result).resolves.toMatchObject({ status: 'finished', steps: 2 });
  });

  it('stops at the step limit', async () => {
    let n = 0;
    const { result } = run([() => [call('echo', { text: `step ${(n += 1)}` })]], { limits: { maxSteps: 4 } });
    await expect(result).resolves.toMatchObject({ status: 'max-steps', steps: 4 });
  });

  it('warns a model that repeats one call, then stops it', async () => {
    const { model, result } = run([[call('echo', { text: 'again' })]]);
    await expect(result).resolves.toMatchObject({ status: 'stalled', steps: 5 });
    expect(lastToolOutputs(model.requests[3].messages)[0]).toMatchObject({ warning: expect.stringMatching(/identical call 3 times/) });
  });

  it('treats argument order as the same call when detecting repeats', async () => {
    const set: LoopTool[] = [
      { name: 'pair', description: '', schema: z.strictObject({ a: z.number(), b: z.number() }), execute: async () => ({}) },
      ...tools().tools,
    ];
    let turn = 0;
    const { result } = run([() => [call('pair', (turn += 1) % 2 === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 })]], { tools: set });
    await expect(result).resolves.toMatchObject({ status: 'stalled' });
  });

  it('reminds a model that answers in prose to use a tool, and gives up after two reminders', async () => {
    const nudged = run(['All done!', [call('finish', { summary: 'ok' })]]);
    await expect(nudged.result).resolves.toMatchObject({ status: 'finished', steps: 2 });
    expect(nudged.model.requests[1].messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringMatching(/call finish/) });

    await expect(run(['done', 'really done', 'I said done']).result).resolves.toMatchObject({ status: 'no-finish', steps: 3 });
  });

  it('reports a model failure instead of throwing', async () => {
    const { result, events } = run([[call('echo', { text: 'x' })], new Error('every configured model failed')]);
    await expect(result).resolves.toMatchObject({ status: 'model-error', detail: 'every configured model failed', toolCalls: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'model-error' });
  });

  it('stops when the token budget is spent', async () => {
    let n = 0;
    const { result } = run([() => [call('echo', { text: `t${(n += 1)}` })]], { limits: { maxTokens: 500 }, tokens: 150 });
    await expect(result).resolves.toMatchObject({ status: 'token-budget', steps: 2 });
  });

  it('stops at the wall-clock deadline', async () => {
    let clock = 0;
    let n = 0;
    const { result } = run([() => [call('echo', { text: `t${(n += 1)}` })]], {
      limits: { timeoutMs: 1000 },
      now: () => (clock += 400),
    });
    await expect(result).resolves.toMatchObject({ status: 'timeout' });
  });
});
