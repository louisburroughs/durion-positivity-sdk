/** Shared test doubles. Not part of the harness runtime. */
import type { LoopMessage, ModelPort, ModelRequest, ModelToolCall, ModelTurn } from '../agent/loop';
import { SdkInvoker } from '../sdk/SdkInvoker';

export type Route = (request: { method: string; path: string; headers: Headers; body: string | undefined }) =>
  | { status: number; body?: unknown }
  | undefined;

export interface FakeBackend {
  fetchImpl: typeof fetch;
  requests: Array<{ method: string; path: string; headers: Headers; body: string | undefined }>;
}

/** A fetch that answers from `route`; anything it does not handle is a 404 with a code. */
export function fakeBackend(route: Route = () => undefined): FakeBackend {
  const requests: FakeBackend['requests'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const request = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    requests.push(request);
    const answer = route(request) ?? { status: 404, body: { code: 'NOT_FOUND', message: 'no such resource' } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

export const GATEWAY = 'http://gateway.test';

/** An invoker over the real generated clients, talking to a fake backend. */
export function invokerFor(backend: FakeBackend, unreachable: readonly string[] = ['internal', 'documents']): SdkInvoker {
  return new SdkInvoker({
    baseUrlFor: (pkg) => (unreachable.includes(pkg) ? undefined : `${GATEWAY}/${pkg}`),
    tokenFor: async (persona) => `token-${persona}`,
    fetchImpl: backend.fetchImpl,
  });
}

export type Script = Array<ModelToolCall[] | string | Error | ((request: ModelRequest) => ModelToolCall[] | string)>;

/** A model that plays a fixed script: each entry is one turn (tool calls, plain text, or a failure). */
export class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private turn = 0;

  constructor(
    private readonly script: Script,
    private readonly tokensPerTurn = 10,
  ) {}

  async generate(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const entry = this.script[Math.min(this.turn, this.script.length - 1)];
    this.turn += 1;
    if (entry instanceof Error) {
      throw entry;
    }
    const value = typeof entry === 'function' ? entry(request) : entry;
    return {
      text: typeof value === 'string' ? value : '',
      toolCalls: typeof value === 'string' ? [] : value,
      usage: { inputTokens: this.tokensPerTurn, outputTokens: this.tokensPerTurn },
      model: 'scripted',
    };
  }
}

let callSeq = 0;
export const call = (name: string, input: unknown = {}): ModelToolCall => ({ id: `call-${(callSeq += 1)}`, name, input });

/** The outputs the model was shown for its most recent tool calls. */
export function lastToolOutputs(messages: LoopMessage[]): unknown[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'tool') {
      return message.results.map((result) => result.output);
    }
  }
  return [];
}
