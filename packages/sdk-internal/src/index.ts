/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

export function createTaxClient(config: DurionSdkConfig) {
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
    taxApi: new GeneratedApis.TaxApi(configuration),
    taxExemptionCertificatesApi: new GeneratedApis.TaxExemptionCertificatesApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';

// Re-exported, not re-declared: this package used to export its own identical
// copy of DurionSdkConfig, so `import type { DurionSdkConfig } from
// '@durion-sdk/internal'` has to keep working. The canonical definition now lives
// in one place.
export type { DurionSdkConfig } from '@durion-sdk/transport';

