/* tslint:disable */
/* eslint-disable */
export * from './runtime';
export * from './apis/index';
export * from './models/index';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { TaxApi } from './apis/TaxApi';

export function createTaxClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const sdkHeaders = await httpClient.buildRequestHeaders(method);
      const mergedHeaders = new Headers(init?.headers);
      Object.entries(sdkHeaders).forEach(([key, value]) => {
        mergedHeaders.set(key, value);
      });
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    taxApi: new TaxApi(configuration),
  };
}
