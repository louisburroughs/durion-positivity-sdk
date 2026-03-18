import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createLocationClient(config: DurionSdkConfig): {
    bayApi: GeneratedApis.BayAPIApi;
    locationApi: GeneratedApis.LocationAPIApi;
    mobileUnitApi: GeneratedApis.MobileUnitAPIApi;
    serviceAreaApi: GeneratedApis.ServiceAreaAPIApi;
    mobileUnitEligibilityControllerApi: GeneratedApis.MobileUnitEligibilityControllerApi;
    siteDefaultsAPIApi: GeneratedApis.SiteDefaultsAPIApi;
    storageLocationControllerApi: GeneratedApis.StorageLocationControllerApi;
    storageLocationValidationControllerApi: GeneratedApis.StorageLocationValidationControllerApi;
    travelBufferPolicyAPIApi: GeneratedApis.TravelBufferPolicyAPIApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
