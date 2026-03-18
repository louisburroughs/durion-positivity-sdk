import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createOrderClient(config: DurionSdkConfig): {
    orderCancellationApi: GeneratedApis.OrderCancellationApi;
    priceOverridesApi: GeneratedApis.PriceOverridesApi;
    salesOrdersApi: GeneratedApis.SalesOrdersApi;
};
export { OrderPriceOverrideWorkflow } from './workflows/orderPriceOverrideWorkflow';
export * from './runtime';
export * from './apis/index';
export * from './models/index';
