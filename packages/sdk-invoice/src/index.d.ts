import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createInvoiceClient(config: DurionSdkConfig): {
    billingRulesApi: GeneratedApis.BillingRulesApi;
    invoiceApi: GeneratedApis.InvoiceApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
