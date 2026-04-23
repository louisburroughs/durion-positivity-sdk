/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

function normalizeRequestUrl(url: RequestInfo | URL): string {
  if (typeof url === 'string') {
    return url;
  }
  if (url instanceof URL) {
    return url.toString();
  }
  if (typeof Request !== 'undefined' && url instanceof Request) {
    return url.url;
  }
  return String(url);
}

export function createWorkorderClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const sdkHeaders: Record<string, string> = await httpClient.buildRequestHeaders(method, {
        url: normalizeRequestUrl(url),
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });

      Object.entries(sdkHeaders).forEach(([key, value]) => {
        mergedHeaders.set(key, value);
      });

      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });

  return {
    approvalConfigurationAPIApi: new GeneratedApis.ApprovalConfigurationAPIApi(configuration),
    changeRequestAPIApi: new GeneratedApis.ChangeRequestAPIApi(configuration),
    dailyDispatchBoardDashboardApi: new GeneratedApis.DailyDispatchBoardDashboardApi(configuration),
    estimateAPIApi: new GeneratedApis.EstimateAPIApi(configuration),
    estimateSearchApi: new GeneratedApis.EstimateSearchApi(configuration),
    estimatesFromAppointmentsApi: new GeneratedApis.EstimatesFromAppointmentsApi(configuration),
    operationalContextApi: new GeneratedApis.OperationalContextApi(configuration),
    substituteLinkControllerApi: new GeneratedApis.SubstituteLinkControllerApi(configuration),
    technicianAssignmentAPIApi: new GeneratedApis.TechnicianAssignmentAPIApi(configuration),
    timeEntryAPIApi: new GeneratedApis.TimeEntryAPIApi(configuration),
    travelSegmentAPIApi: new GeneratedApis.TravelSegmentAPIApi(configuration),
    wipDashboardApi: new GeneratedApis.WIPDashboardApi(configuration),
    workOrderAPIApi: new GeneratedApis.WorkOrderAPIApi(configuration),
    workSessionAPIApi: new GeneratedApis.WorkSessionAPIApi(configuration),
    workexecTimeTrackingAPIApi: new GeneratedApis.WorkexecTimeTrackingAPIApi(configuration),
    workorderDetailApi: new GeneratedApis.WorkorderDetailApi(configuration),
    workorderLaborAPIApi: new GeneratedApis.WorkorderLaborAPIApi(configuration),
    workorderPartAdjustmentsApi: new GeneratedApis.WorkorderPartAdjustmentsApi(configuration),
    workorderPartsUsageApi: new GeneratedApis.WorkorderPartsUsageApi(configuration),
    workorderPickFacadeApi: new GeneratedApis.WorkorderPickFacadeApi(configuration),
    workorderPickedItemsApi: new GeneratedApis.WorkorderPickedItemsApi(configuration),
  };
}

export { WorkorderEstimateWorkflow } from './workflows/workorderEstimateWorkflow';
export { WorkorderChangeRequestWorkflow } from './workflows/workorderChangeRequestWorkflow';
export * from './runtime';
export * from './apis/index';
export * from './models/index';
