import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createShopManagerClient(config: DurionSdkConfig): {
    appointmentsApi: GeneratedApis.AppointmentsAPIApi;
    shopApi: GeneratedApis.ShopAPIApi;
    assignmentControllerApi: GeneratedApis.AssignmentControllerApi;
    conflictOverrideApi: GeneratedApis.ConflictOverrideAPIApi;
    scheduleApi: GeneratedApis.ScheduleAPIApi;
    shopAuditControllerApi: GeneratedApis.ShopAuditControllerApi;
    shopBayAPIApi: GeneratedApis.ShopBayAPIApi;
    shopMobileUnitAPIApi: GeneratedApis.ShopMobileUnitAPIApi;
    workorderOperationalContextAPIApi: GeneratedApis.WorkorderOperationalContextAPIApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
