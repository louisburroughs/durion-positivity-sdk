/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

export function createCustomerClient(config: DurionSdkConfig) {
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
    crmAccountsApi: new GeneratedApis.CRMAccountsApi(configuration),
    crmPersonsApi: new GeneratedApis.CRMPersonsApi(configuration),
    crmCommunicationPreferencesApi: new GeneratedApis.CRMCommunicationPreferencesApi(configuration),
    crmContactsApi: new GeneratedApis.CRMContactsApi(configuration),
    crmPartyRelationshipsApi: new GeneratedApis.CRMPartyRelationshipsApi(configuration),
    crmSnapshotsApi: new GeneratedApis.CRMSnapshotsApi(configuration),
    crmVehiclesApi: new GeneratedApis.CRMVehiclesApi(configuration),
    customerAPIApi: new GeneratedApis.CustomerAPIApi(configuration),
    promotionRedemptionsApi: new GeneratedApis.PromotionRedemptionsApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';