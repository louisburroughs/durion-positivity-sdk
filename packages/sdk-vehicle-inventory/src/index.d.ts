import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createVehicleInventoryClient(config: DurionSdkConfig): {
    vehicleApi: GeneratedApis.VehicleAPIApi;
    vehicleRegistryApi: GeneratedApis.VehicleRegistryAPIApi;
    vehiclePreferencesApi: GeneratedApis.VehiclePreferencesApi;
    vehicleSearchApi: GeneratedApis.VehicleSearchApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
