/* tslint:disable */
/* eslint-disable */
export * from './runtime';
export * from './apis/index';
export * from './models/index';
export { WorkorderEstimateWorkflow } from './workflows/workorderEstimateWorkflow';
export { WorkorderChangeRequestWorkflow } from './workflows/workorderChangeRequestWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { WorkOrderAPIApi } from './apis/WorkOrderAPIApi';
import { EstimateAPIApi } from './apis/EstimateAPIApi';
import { TechnicianAssignmentAPIApi } from './apis/TechnicianAssignmentAPIApi';
import { WorkorderPickFacadeApi } from './apis/WorkorderPickFacadeApi';
import { WorkorderPickedItemsApi } from './apis/WorkorderPickedItemsApi';
import { WorkSessionAPIApi } from './apis/WorkSessionAPIApi';
import { WorkexecTimeTrackingAPIApi } from './apis/WorkexecTimeTrackingAPIApi';
import { ChangeRequestAPIApi } from './apis/ChangeRequestAPIApi';
import { WorkorderDetailApi } from './apis/WorkorderDetailApi';
import { OperationalContextApi } from './apis/OperationalContextApi';

export function createWorkorderClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const sdkHeaders = await httpClient.buildRequestHeaders(method);
      const mergedHeaders = new Headers(init?.headers);
      Object.entries(sdkHeaders).forEach(([key, value]) => {
        mergedHeaders.set(key, value);
      });
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    workOrderAPIApi: new WorkOrderAPIApi(configuration),
    estimateAPIApi: new EstimateAPIApi(configuration),
    technicianAssignmentAPIApi: new TechnicianAssignmentAPIApi(configuration),
    workorderPickFacadeApi: new WorkorderPickFacadeApi(configuration),
    workorderPickedItemsApi: new WorkorderPickedItemsApi(configuration),
    workSessionAPIApi: new WorkSessionAPIApi(configuration),
    workexecTimeTrackingAPIApi: new WorkexecTimeTrackingAPIApi(configuration),
    changeRequestAPIApi: new ChangeRequestAPIApi(configuration),
    workorderDetailApi: new WorkorderDetailApi(configuration),
    operationalContextApi: new OperationalContextApi(configuration),
  };
}