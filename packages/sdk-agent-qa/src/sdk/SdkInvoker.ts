/**
 * Calls one catalog {@link Operation} through the real generated client.
 *
 * Nothing here re-implements a request. The invoker instantiates the generated
 * API class, hands it the same kind of `Configuration` the packages'
 * `createXxxClient` factories build — one whose `fetchApi` takes its headers
 * from `@durion-sdk/transport`'s `SdkHttpClient` — and calls the method. So a
 * run exercises the SDK's own serialization, path building, auth and
 * idempotency handling, which is what the harness exists to test.
 *
 * A call never throws for an HTTP error. Error responses are the point of half
 * the scenarios, so every outcome — 2xx, 4xx, 5xx, a network failure, a
 * client-side refusal — comes back as a {@link CallOutcome} the model can read
 * and the oracle can judge.
 */
import { SdkHttpClient, type DurionSdkConfig } from '@durion-sdk/transport';
import { hydrate } from '../catalog/zodFromIr';
import type { Operation } from '../catalog/types';

export type OutcomeKind =
  /** The backend answered 2xx. */
  | 'success'
  /** The backend answered with an error status. */
  | 'http-error'
  /**
   * The backend answered 2xx but the generated client could not turn the body
   * into the declared model: the response and the SDK's contract disagree.
   */
  | 'decode-error'
  /** No response: connection refused, DNS, timeout, aborted. */
  | 'transport-error'
  /** The generated client refused before sending (e.g. a required parameter was null). */
  | 'client-error';

export interface CallOutcome {
  kind: OutcomeKind;
  /** HTTP status, when a response arrived. */
  status?: number;
  /** The backend's machine-readable error code, when the error body carried one. */
  errorCode?: string;
  /** The returned value, or the parsed error body. */
  body?: unknown;
  message?: string;
  httpMethod: string;
  /** Path and query actually requested, without the origin. */
  requestPath?: string;
  correlationId?: string;
  durationMs: number;
}

export interface SdkModule {
  Configuration: new (params: { basePath: string; fetchApi: typeof fetch }) => unknown;
  [exported: string]: unknown;
}

export interface SdkInvokerOptions {
  /** Base URL the package's requests go to, or undefined when the package is unreachable. */
  baseUrlFor(pkg: string): string | undefined;
  /** Bearer token for a persona, renewed as needed. */
  tokenFor(persona: string): Promise<string>;
  /** Loads the built SDK package. Defaults to `require('@durion-sdk/<pkg>')`. */
  loadModule?(pkg: string): SdkModule;
  fetchImpl?: typeof fetch;
  /** Abort a single request after this long. */
  requestTimeoutMs?: number;
}

const ERROR_CODE_KEYS = ['code', 'errorCode', 'error_code', 'error'] as const;

export function extractErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  for (const key of ERROR_CODE_KEYS) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

function defaultLoadModule(pkg: string): SdkModule {
  // The packages resolve through node_modules to their built dist/, exactly as
  // they do for a consumer; `npm run build` at the root has to have run.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(`@durion-sdk/${pkg}`) as SdkModule;
}

function isResponseError(error: unknown): error is { response: Response } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { response?: { status?: unknown } }).response?.status === 'number'
  );
}

export class SdkInvoker {
  private readonly modules = new Map<string, SdkModule>();

  constructor(private readonly options: SdkInvokerOptions) {}

  private moduleFor(pkg: string): SdkModule {
    let loaded = this.modules.get(pkg);
    if (!loaded) {
      loaded = (this.options.loadModule ?? defaultLoadModule)(pkg);
      this.modules.set(pkg, loaded);
    }
    return loaded;
  }

  isReachable(pkg: string): boolean {
    return this.options.baseUrlFor(pkg) !== undefined;
  }

  /**
   * @param input the tool input, already validated (or deliberately not) by the caller
   */
  async invoke(operation: Operation, input: Record<string, unknown>, persona: string): Promise<CallOutcome> {
    const started = Date.now();
    const base: Pick<CallOutcome, 'httpMethod'> = { httpMethod: operation.http };
    const finish = (outcome: Omit<CallOutcome, 'durationMs' | 'httpMethod'>): CallOutcome => ({
      ...base,
      ...outcome,
      durationMs: Date.now() - started,
    });

    const baseUrl = this.options.baseUrlFor(operation.pkg);
    if (baseUrl === undefined) {
      return finish({
        kind: 'client-error',
        message: `package "${operation.pkg}" has no route on this backend (set QA_SERVICE_URL_${operation.pkg
          .toUpperCase()
          .replace(/-/g, '_')} to reach it directly)`,
      });
    }

    let requestPath: string | undefined;
    let responseStatus: number | undefined;
    let correlationId: string | undefined;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const sdkConfig: DurionSdkConfig = { baseUrl, token: () => this.options.tokenFor(persona) };
    const httpClient = new SdkHttpClient(sdkConfig);

    const fetchApi = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const urlText = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
        url: urlText,
        idempotencyKey: headers.get('Idempotency-Key') ?? undefined,
      });
      for (const [key, value] of Object.entries(sdkHeaders)) {
        headers.set(key, value);
      }
      requestPath = urlText.startsWith(baseUrl) ? urlText.slice(baseUrl.length) : urlText;
      correlationId = headers.get('X-Correlation-Id') ?? undefined;
      const timeout = this.options.requestTimeoutMs;
      const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
      const response = await fetchImpl(url, { ...init, headers, signal: init?.signal ?? signal });
      responseStatus = response.status;
      return response;
    };

    let api: Record<string, unknown>;
    try {
      const sdk = this.moduleFor(operation.pkg);
      const ApiClass = sdk[operation.api] as (new (configuration: unknown) => Record<string, unknown>) | undefined;
      if (typeof ApiClass !== 'function') {
        return finish({ kind: 'client-error', message: `@durion-sdk/${operation.pkg} does not export ${operation.api}` });
      }
      api = new ApiClass(new sdk.Configuration({ basePath: baseUrl, fetchApi: fetchApi as typeof fetch }));
    } catch (error) {
      return finish({
        kind: 'client-error',
        message: `could not load @durion-sdk/${operation.pkg}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const method = api[operation.method];
    if (typeof method !== 'function') {
      return finish({ kind: 'client-error', message: `${operation.api} has no method ${operation.method}` });
    }

    const hasInput = Object.keys(operation.input.properties).length > 0;
    try {
      const args = hasInput ? [hydrate(operation.input, input)] : [];
      const value: unknown = await (method as (...a: unknown[]) => Promise<unknown>).apply(api, args);
      const body = value instanceof Blob ? { blob: { size: value.size, type: value.type } } : value;
      return finish({ kind: 'success', status: responseStatus ?? 200, body, requestPath, correlationId });
    } catch (error) {
      if (isResponseError(error)) {
        const { response } = error;
        let body: unknown;
        try {
          const text = await response.clone().text();
          try {
            body = JSON.parse(text);
          } catch {
            body = text.slice(0, 2000);
          }
        } catch {
          body = undefined;
        }
        return finish({
          kind: 'http-error',
          status: response.status,
          errorCode: extractErrorCode(body),
          body,
          requestPath,
          correlationId,
        });
      }
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      if (responseStatus !== undefined) {
        // A response arrived and was not an HTTP error, so what failed is reading it.
        return finish({
          kind: 'decode-error',
          status: responseStatus,
          message: `the SDK could not decode the ${responseStatus} response: ${message}`,
          requestPath,
          correlationId,
        });
      }
      // RequiredError is the generated client declining to send; a FetchError
      // (or anything raised once a request was on its way) is the network.
      const kind: OutcomeKind = name === 'RequiredError' || requestPath === undefined ? 'client-error' : 'transport-error';
      return finish({ kind, message: `${name || 'Error'}: ${message}${cause}`, requestPath, correlationId });
    }
  }
}
