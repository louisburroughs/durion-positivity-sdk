/* tslint:disable */
/* eslint-disable */
export * from './runtime';
export * from './apis/index';
export * from './models/index';
export * from './workflows/orderPriceOverrideWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { SalesOrdersApi } from './apis/SalesOrdersApi';
import { PriceOverridesApi } from './apis/PriceOverridesApi';
import { OrderCancellationApi } from './apis/OrderCancellationApi';

export function createOrderClient(config: DurionSdkConfig) {
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
    salesOrdersApi: new SalesOrdersApi(configuration),
    priceOverridesApi: new PriceOverridesApi(configuration),
    orderCancellationApi: new OrderCancellationApi(configuration),
  };
}
