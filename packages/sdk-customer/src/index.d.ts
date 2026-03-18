import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createCustomerClient(config: DurionSdkConfig): {
    crmAccountsApi: GeneratedApis.CRMAccountsApi;
    crmPersonsApi: GeneratedApis.CRMPersonsApi;
    crmCommunicationPreferencesApi: GeneratedApis.CRMCommunicationPreferencesApi;
    crmContactsApi: GeneratedApis.CRMContactsApi;
    crmPartyRelationshipsApi: GeneratedApis.CRMPartyRelationshipsApi;
    crmSnapshotsApi: GeneratedApis.CRMSnapshotsApi;
    crmVehiclesApi: GeneratedApis.CRMVehiclesApi;
    customerAPIApi: GeneratedApis.CustomerAPIApi;
    promotionRedemptionsApi: GeneratedApis.PromotionRedemptionsApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
