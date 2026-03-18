import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createImageClient(config: DurionSdkConfig): {
    imageApi: GeneratedApis.ImageAPIApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
