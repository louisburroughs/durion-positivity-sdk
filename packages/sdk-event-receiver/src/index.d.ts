import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createEventReceiverClient(config: DurionSdkConfig): {
    eventEmissionApi: GeneratedApis.EventEmissionApi;
    eventTypesApi: GeneratedApis.EventTypesApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
