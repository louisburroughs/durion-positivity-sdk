/**
 * {@link ModelPort} over Vercel's AI SDK, with a fallback chain across providers.
 *
 * This is the only file that imports `ai`. Each turn is a single
 * `generateText` call with tools declared but not executable: the SDK does the
 * provider work (request shaping, tool-call parsing, transport retries) and
 * hands the tool calls back to the loop, which validates and runs them.
 *
 * Every provider the harness is configured for speaks the OpenAI chat
 * completions dialect, so one adapter package (`@ai-sdk/openai-compatible`)
 * covers OpenRouter, Ollama (local or cloud), OpenCode Zen and any other
 * compatible endpoint; Vercel's AI Gateway comes with `ai` itself.
 *
 * `ai` v7 is ESM-only. This package is CommonJS like the rest of the
 * workspace, and loads it through Node's `require(esm)` (Node >= 22.12).
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGateway, generateText, jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { LoopMessage, LoopTool, ModelPort, ModelRequest, ModelTurn } from './loop';

export interface ModelRef {
  /** `openrouter`, `ollama`, `opencode`, `gateway` or `custom`. */
  provider: string;
  /** Model id as the provider names it, e.g. `qwen3:14b` or `anthropic/claude-sonnet-4.5`. */
  model: string;
}

type Env = Record<string, string | undefined>;

interface ProviderSpec {
  baseUrl(env: Env): string | undefined;
  apiKey(env: Env): string | undefined;
  /** False for a local server that takes no key. */
  keyRequired: boolean;
  keyName: string;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  openrouter: {
    baseUrl: (env) => env['OPENROUTER_BASE_URL'] || 'https://openrouter.ai/api/v1',
    apiKey: (env) => env['OPENROUTER_API_KEY'],
    keyRequired: true,
    keyName: 'OPENROUTER_API_KEY',
  },
  ollama: {
    // Local by default. For Ollama's hosted models set OLLAMA_BASE_URL=https://ollama.com/v1 and OLLAMA_API_KEY.
    baseUrl: (env) => env['OLLAMA_BASE_URL'] || 'http://localhost:11434/v1',
    apiKey: (env) => env['OLLAMA_API_KEY'],
    keyRequired: false,
    keyName: 'OLLAMA_API_KEY',
  },
  opencode: {
    // OpenCode Zen's chat-completions endpoint. Zen serves its GPT and Claude
    // models on other paths (/responses, /messages); reach those through
    // OpenRouter or the gateway instead.
    baseUrl: (env) => env['OPENCODE_BASE_URL'] || 'https://opencode.ai/zen/v1',
    apiKey: (env) => env['OPENCODE_API_KEY'],
    keyRequired: true,
    keyName: 'OPENCODE_API_KEY',
  },
  custom: {
    baseUrl: (env) => env['QA_CUSTOM_BASE_URL'],
    apiKey: (env) => env['QA_CUSTOM_API_KEY'],
    keyRequired: false,
    keyName: 'QA_CUSTOM_API_KEY',
  },
};

export const KNOWN_PROVIDERS: readonly string[] = [...Object.keys(PROVIDERS), 'gateway'];

/** `"openrouter:anthropic/claude-sonnet-4.5, ollama:qwen3:14b"` → refs, in fallback order. */
export function parseModelChain(spec: string): ModelRef[] {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf(':');
      const provider = separator > 0 ? entry.slice(0, separator) : '';
      const model = entry.slice(separator + 1);
      if (!KNOWN_PROVIDERS.includes(provider) || model.length === 0) {
        throw new Error(
          `QA_MODELS entry "${entry}" must be <provider>:<model> with provider one of ${KNOWN_PROVIDERS.join(', ')}`,
        );
      }
      return { provider, model };
    });
}

/** Configuration problems for a chain, without contacting any provider. */
export function modelChainProblems(chain: ModelRef[], env: Env): string[] {
  const problems: string[] = [];
  if (chain.length === 0) {
    problems.push('QA_MODELS is required, e.g. QA_MODELS=ollama:qwen3:14b or openrouter:anthropic/claude-sonnet-4.5');
  }
  for (const ref of chain) {
    if (ref.provider === 'gateway') {
      if (!env['AI_GATEWAY_API_KEY']) {
        problems.push('AI_GATEWAY_API_KEY is required for gateway: models');
      }
      continue;
    }
    const spec = PROVIDERS[ref.provider];
    if (!spec.baseUrl(env)) {
      problems.push('QA_CUSTOM_BASE_URL is required for custom: models');
    }
    if (spec.keyRequired && !spec.apiKey(env)) {
      problems.push(`${spec.keyName} is required for ${ref.provider}: models`);
    }
  }
  return [...new Set(problems)];
}

function resolveModel(ref: ModelRef, env: Env): LanguageModel {
  if (ref.provider === 'gateway') {
    return createGateway({ apiKey: env['AI_GATEWAY_API_KEY'] })(ref.model);
  }
  const spec = PROVIDERS[ref.provider];
  const provider = createOpenAICompatible({
    name: ref.provider,
    baseURL: spec.baseUrl(env) as string,
    apiKey: spec.apiKey(env),
    includeUsage: true,
  });
  return provider(ref.model);
}

function toJsonValue(value: unknown): never {
  // Tool outputs hold Dates and undefineds; a provider request is plain JSON.
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as never;
}

export function toModelMessages(messages: LoopMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content };
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(message.text ? [{ type: 'text' as const, text: message.text }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.id,
            toolName: call.name,
            input: call.input ?? {},
          })),
        ],
      };
    }
    return {
      role: 'tool',
      content: message.results.map((result) => ({
        type: 'tool-result' as const,
        toolCallId: result.id,
        toolName: result.name,
        output: { type: 'json' as const, value: toJsonValue(result.output) },
      })),
    };
  });
}

export interface AiSdkModelOptions {
  chain: ModelRef[];
  env?: Env;
  /** Transport retries per model before failing over (the AI SDK's own backoff). */
  maxRetries?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Test seam: supplies the model for a ref instead of building a provider. */
  resolve?(ref: ModelRef): LanguageModel;
  log?(message: string): void;
}

export class AiSdkModel implements ModelPort {
  private readonly models: Array<{ ref: ModelRef; model: LanguageModel }>;
  private readonly toolSets = new WeakMap<LoopTool[], ToolSet>();
  /** Index of the model that last answered; a run stays on a fallback once it has moved to one. */
  private preferred = 0;

  constructor(private readonly options: AiSdkModelOptions) {
    const env = options.env ?? process.env;
    this.models = options.chain.map((ref) => ({ ref, model: options.resolve?.(ref) ?? resolveModel(ref, env) }));
    if (this.models.length === 0) {
      throw new Error('AiSdkModel needs at least one model');
    }
  }

  private toolSet(tools: LoopTool[]): ToolSet {
    let set = this.toolSets.get(tools);
    if (!set) {
      set = {};
      for (const definition of tools) {
        // Declared with a plain JSON Schema and no validator: the loop is the
        // one place inputs are validated, so a bad input reaches it as a tool
        // call to correct rather than being dropped inside the SDK.
        const schema = z.toJSONSchema(definition.schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' });
        set[definition.name] = tool({
          description: definition.description,
          inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
        });
      }
      this.toolSets.set(tools, set);
    }
    return set;
  }

  async generate(request: ModelRequest): Promise<ModelTurn> {
    const failures: string[] = [];
    for (let offset = 0; offset < this.models.length; offset += 1) {
      const index = (this.preferred + offset) % this.models.length;
      const { ref, model } = this.models[index];
      const label = `${ref.provider}:${ref.model}`;
      try {
        const result = await generateText({
          model,
          system: request.system,
          messages: toModelMessages(request.messages),
          tools: this.toolSet(request.tools),
          maxRetries: this.options.maxRetries ?? 2,
          temperature: this.options.temperature,
          maxOutputTokens: this.options.maxOutputTokens,
          abortSignal: request.abortSignal,
        });
        if (index !== this.preferred) {
          this.options.log?.(`model failover: now using ${label}`);
          this.preferred = index;
        }
        return {
          text: result.text ?? '',
          toolCalls: result.toolCalls.map((call) => {
            let input: unknown = call.input;
            if (typeof input === 'string') {
              // An unparsable call arrives as raw text; give the loop a chance to validate what it can.
              try {
                input = JSON.parse(input);
              } catch {
                input = { _raw: input };
              }
            }
            return { id: call.toolCallId, name: call.toolName, input };
          }),
          usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
          model: label,
        };
      } catch (error) {
        if (request.abortSignal?.aborted) {
          throw error; // The scenario's own deadline: another model would not be given time either.
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${label}: ${message.slice(0, 300)}`);
        this.options.log?.(`model ${label} failed: ${message.slice(0, 300)}`);
      }
    }
    throw new Error(`every configured model failed — ${failures.join(' | ')}`);
  }
}
