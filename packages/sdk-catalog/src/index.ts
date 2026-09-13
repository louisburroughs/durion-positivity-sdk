/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
// Note: supplierItemCostApi used to be constructed here from a stale
// SupplierItemCostAPIApi. pos-catalog's contract no longer declares
// /v1/catalog/supplier-item-costs at all, so the class and its DTOs were
// dropped at regeneration. Supplier pricing now lives behind
// supplierPricesApi and supplierArticleCodesApi.
import { Configuration } from './runtime';

export function createCatalogClient(config: DurionSdkConfig) {
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
    catalogApi: new GeneratedApis.CatalogAPIApi(configuration),
    catalogItemsApi: new GeneratedApis.CatalogItemsAPIApi(configuration),
    itemCostApi: new GeneratedApis.ItemCostAPIApi(configuration),
    priceBookApi: new GeneratedApis.PriceBookAPIApi(configuration),
    productMSRPApi: new GeneratedApis.ProductMSRPAPIApi(configuration),
    productsApi: new GeneratedApis.ProductsAPIApi(configuration),
    supplierArticleCodesApi: new GeneratedApis.SupplierArticleCodesApi(configuration),
    supplierPricesApi: new GeneratedApis.SupplierPricesApi(configuration),
    uomConversionApi: new GeneratedApis.UOMConversionAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';