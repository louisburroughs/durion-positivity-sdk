/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

export function createTenantClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method ?? 'GET') as string).toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      // url and any caller-supplied Idempotency-Key are passed through so
      // config.idempotencyKeyGenerator still fires on mutating requests. The
      // other transport-aware factories call buildRequestHeaders(method) with
      // neither, which means they never emit the header at all; keeping both
      // here preserves what this package already did.
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
        url: urlStr,
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });
      Object.keys(sdkHeaders).forEach((key: string) => mergedHeaders.set(key, sdkHeaders[key]));
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    platformAccountApi: new GeneratedApis.PlatformAccountAPIApi(configuration),
    platformTenantApi: new GeneratedApis.PlatformTenantAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
