/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

function normalizeRequestUrl(url: RequestInfo | URL): string {
  if (typeof url === 'string') {
    return url;
  }
  if (url instanceof URL) {
    return url.toString();
  }
  if (typeof Request !== 'undefined' && url instanceof Request) {
    return url.url;
  }
  return String(url);
}

export function createLocationClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
        url: normalizeRequestUrl(url),
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });

      Object.entries(sdkHeaders).forEach(([key, value]) => {
        mergedHeaders.set(key, value);
      });

      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });

  return {
    bayApi: new GeneratedApis.BayAPIApi(configuration),
    locationApi: new GeneratedApis.LocationAPIApi(configuration),
    mobileUnitApi: new GeneratedApis.MobileUnitAPIApi(configuration),
    serviceAreaApi: new GeneratedApis.ServiceAreaAPIApi(configuration),
    mobileUnitEligibilityControllerApi: new GeneratedApis.MobileUnitEligibilityControllerApi(configuration),
    siteDefaultsAPIApi: new GeneratedApis.SiteDefaultsAPIApi(configuration),
    storageLocationControllerApi: new GeneratedApis.StorageLocationControllerApi(configuration),
    storageLocationValidationControllerApi: new GeneratedApis.StorageLocationValidationControllerApi(configuration),
    travelBufferPolicyAPIApi: new GeneratedApis.TravelBufferPolicyAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
