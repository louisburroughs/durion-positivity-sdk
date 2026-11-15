/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

/**
 * Client for the pos-platform-sender device registration API (ADR-0076), the
 * only platform-sender surface the gateway routes. The generated paths already
 * carry the service's own `/platform-sender/v1` prefix and the gateway route has
 * no StripPrefix, so `config.baseUrl` is the gateway root (no `/platform-sender`
 * suffix). The shared-secret send API is service-to-service only and is not in
 * this package: it is generated from openapi-public.yaml, which excludes it.
 */
export function createPlatformSenderClient(config: DurionSdkConfig) {
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
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    platformSenderDevicesApi: new GeneratedApis.PlatformSenderDevicesApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';

export type { DurionSdkConfig } from '@durion-sdk/transport';
