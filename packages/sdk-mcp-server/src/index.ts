/* tslint:disable */
/* eslint-disable */
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

export interface DurionSdkConfig {
  baseUrl: string;
  token?: () => string | Promise<string>;
  apiVersion?: string;
  correlationIdProvider?: () => string;
  idempotencyKeyGenerator?: (method: string, url: string) => string;
}

async function buildRequestHeaders(
  config: DurionSdkConfig,
  method: string,
  options?: { url?: string; idempotencyKey?: string },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (config.token) {
    const token = await config.token();
    headers['Authorization'] = `Bearer ${token}`;
  }
  headers['X-API-Version'] = config.apiVersion ?? '1';
  headers['X-Correlation-Id'] = config.correlationIdProvider?.() ?? crypto.randomUUID();
  const url = options?.url;
  if (url) {
    const absUrl = url.startsWith('http') ? url : `${config.baseUrl}${url}`;
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method.toUpperCase()) !== -1;
    const idempotencyKey =
      options?.idempotencyKey ??
      (mutating ? config.idempotencyKeyGenerator?.(method.toUpperCase(), absUrl) : undefined);
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}
/**
 * Path of the one endpoint whose only declared response media type is
 * text/event-stream.
 *
 * typescript-fetch derives a Content-Type header from the request body but
 * never derives an Accept header from the response content, so the generated
 * streamMcpChat sends no Accept at all and negotiation falls to whatever the
 * server or an intermediary defaults to - for an operation whose own
 * description says the client must accept text/event-stream. Setting it in the
 * generated class would not survive the next regeneration; this factory is
 * hand-maintained and listed in .openapi-generator-ignore, so the header is set
 * here instead.
 */
const SSE_PATH = '/v1/mcp/chat/stream';

export function createMcpServerClient(config: DurionSdkConfig) {
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method ?? 'GET') as string).toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const sdkHeaders = await buildRequestHeaders(config, method, {
        url: urlStr,
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });
      Object.keys(sdkHeaders).forEach((key: string) => mergedHeaders.set(key, sdkHeaders[key]));
      // A caller-supplied Accept wins: overriding it would break anyone who
      // deliberately asks for something else. urlStr is undefined when the
      // caller hands fetchApi an object that is neither a string, a URL nor a
      // Request - buildRequestHeaders already tolerates that, so this must too.
      if (!mergedHeaders.has('Accept') && (urlStr ?? '').split('?')[0].endsWith(SSE_PATH)) {
        mergedHeaders.set('Accept', 'text/event-stream');
      }
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    documentIngestionApi: new GeneratedApis.DocumentIngestionApi(configuration),
    llmApiConfigurationApi: new GeneratedApis.LLMAPIConfigurationApi(configuration),
    mcpToolPermissionsApi: new GeneratedApis.MCPToolPermissionsApi(configuration),
    mcpChatApi: new GeneratedApis.McpChatControllerApi(configuration),
    mcpStreamingChatApi: new GeneratedApis.McpStreamingChatControllerApi(configuration),
    nltiApi: new GeneratedApis.NLTIApi(configuration),
    nltiAuditApi: new GeneratedApis.NLTIAuditApi(configuration),
    systemPromptsApi: new GeneratedApis.SystemPromptsApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
