/**
 * The AI SDK packages are ESM-only, which this Jest setup cannot load, so `ai` and the
 * provider are mocked: these tests pin what the adapter sends and what it reads back.
 */
const generateText = jest.fn();
jest.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateText(...args),
  createGateway: jest.fn(),
  jsonSchema: (schema: unknown) => schema,
  tool: (definition: unknown) => definition,
}));
jest.mock('@ai-sdk/openai-compatible', () => ({ createOpenAICompatible: jest.fn() }));

import type { LanguageModel } from 'ai';
import { AiSdkModel, type ModelRef } from './aiSdkModel';

const OPENROUTER: ModelRef = { provider: 'openrouter', model: 'z-ai/glm-5.3' };
const OLLAMA: ModelRef = { provider: 'ollama', model: 'qwen3:14b' };
const REQUEST = { system: 'sys', messages: [{ role: 'user' as const, content: 'go' }], tools: [] };

function answer(body: unknown): void {
  generateText.mockResolvedValueOnce({
    text: 'done',
    toolCalls: [],
    usage: { inputTokens: 5000, outputTokens: 120, inputTokenDetails: { cacheReadTokens: 4000 } },
    response: { body },
  });
}

const model = (ref: ModelRef): AiSdkModel =>
  new AiSdkModel({ chain: [ref], openrouterProvider: { ignore: ['Wafer'] }, resolve: () => ({}) as LanguageModel });

describe('AiSdkModel', () => {
  beforeEach(() => generateText.mockReset());

  it('routes OpenRouter requests and records the host that served the turn', async () => {
    answer({ id: 'gen-1', provider: 'DeepInfra' });

    const turn = await model(OPENROUTER).generate(REQUEST);

    const options = generateText.mock.calls[0]?.[0] as { providerOptions?: unknown; include?: unknown };
    expect(options.providerOptions).toEqual({ openrouter: { provider: { ignore: ['Wafer'] } } });
    expect(options.include).toEqual({ responseBody: true });
    expect(turn.provider).toBe('DeepInfra');
    expect(turn.usage).toEqual({ inputTokens: 5000, outputTokens: 120, cachedInputTokens: 4000 });
  });

  it('sends no routing to other providers, and leaves the host unset when the body does not name one', async () => {
    answer({ id: 'chat-1' });

    const turn = await model(OLLAMA).generate(REQUEST);

    expect((generateText.mock.calls[0]?.[0] as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(turn.provider).toBeUndefined();
  });
});
