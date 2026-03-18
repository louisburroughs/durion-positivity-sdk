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

export function createCatalogClient(config: DurionSdkConfig) {
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
    catalogApi: new GeneratedApis.CatalogAPIApi(configuration),
    catalogItemsApi: new GeneratedApis.CatalogItemsAPIApi(configuration),
    itemCostApi: new GeneratedApis.ItemCostAPIApi(configuration),
    priceBookApi: new GeneratedApis.PriceBookAPIApi(configuration),
    productMSRPApi: new GeneratedApis.ProductMSRPAPIApi(configuration),
    productsApi: new GeneratedApis.ProductsAPIApi(configuration),
    supplierItemCostApi: new GeneratedApis.SupplierItemCostAPIApi(configuration),
    uomConversionApi: new GeneratedApis.UOMConversionAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
