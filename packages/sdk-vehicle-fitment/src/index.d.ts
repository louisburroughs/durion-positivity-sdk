import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createVehicleFitmentClient(config: DurionSdkConfig): {
    vehicleFitmentApi: GeneratedApis.VehicleFitmentAPIApi;
    vehicleApplicabilityHintsApi: GeneratedApis.VehicleApplicabilityHintsApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
