/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

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
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method ?? 'GET') as string).toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
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
