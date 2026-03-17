/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

export function createCustomerClient(config: DurionSdkConfig) {
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
