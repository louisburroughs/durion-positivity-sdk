import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createCatalogClient(config: DurionSdkConfig): {
    catalogApi: GeneratedApis.CatalogAPIApi;
    catalogItemsApi: GeneratedApis.CatalogItemsAPIApi;
    itemCostApi: GeneratedApis.ItemCostAPIApi;
    priceBookApi: GeneratedApis.PriceBookAPIApi;
    productMSRPApi: GeneratedApis.ProductMSRPAPIApi;
    productsApi: GeneratedApis.ProductsAPIApi;
    supplierItemCostApi: GeneratedApis.SupplierItemCostAPIApi;
    uomConversionApi: GeneratedApis.UOMConversionAPIApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
