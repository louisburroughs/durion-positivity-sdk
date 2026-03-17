/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

export function createShopManagerClient(config: DurionSdkConfig) {
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
    appointmentsApi: new GeneratedApis.AppointmentsAPIApi(configuration),
    shopApi: new GeneratedApis.ShopAPIApi(configuration),
    assignmentControllerApi: new GeneratedApis.AssignmentControllerApi(configuration),
    conflictOverrideApi: new GeneratedApis.ConflictOverrideAPIApi(configuration),
    scheduleApi: new GeneratedApis.ScheduleAPIApi(configuration),
    shopAuditControllerApi: new GeneratedApis.ShopAuditControllerApi(configuration),
    shopBayAPIApi: new GeneratedApis.ShopBayAPIApi(configuration),
    shopMobileUnitAPIApi: new GeneratedApis.ShopMobileUnitAPIApi(configuration),
    workorderOperationalContextAPIApi: new GeneratedApis.WorkorderOperationalContextAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
