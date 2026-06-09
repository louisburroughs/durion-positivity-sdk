/* tslint:disable */
/* eslint-disable */
import * as GeneratedApis from './apis';
import { Configuration } from './runtime';

export interface DurionSdkConfig {
  baseUrl: string;
  token?: () => string | Promise<string>;
  apiVersion?: string;
  correlationIdProvider?: () => string;
  idempotencyKeyGenerator?: (method: string, url: string) => string;
}

async function buildRequestHeaders(
  config: DurionSdkConfig,
  method: string,
  options?: { url?: string; idempotencyKey?: string },
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (config.token) {
    const token = await config.token();
    headers['Authorization'] = `Bearer ${token}`;
  }
  headers['X-API-Version'] = config.apiVersion ?? '1';
  headers['X-Correlation-Id'] = config.correlationIdProvider?.() ?? crypto.randomUUID();
  const url = options?.url;
  if (url) {
    const absUrl = url.startsWith('http') ? url : `${config.baseUrl}${url}`;
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method.toUpperCase()) !== -1;
    const idempotencyKey =
      options?.idempotencyKey ??
      (mutating ? config.idempotencyKeyGenerator?.(method.toUpperCase(), absUrl) : undefined);
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }
  return headers;
}
export function createWorkorderClient(config: DurionSdkConfig) {
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method ?? 'GET') as string).toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const sdkHeaders = await buildRequestHeaders(config, method, {
        url: urlStr,
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });
      Object.keys(sdkHeaders).forEach((key: string) => mergedHeaders.set(key, sdkHeaders[key]));
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

export * from './runtime';
export * from './apis/index';
export * from './models/index';
export * from './workflows/workorderEstimateWorkflow';
export * from './workflows/workorderChangeRequestWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { WorkOrderAPIApi } from './apis/WorkOrderAPIApi';
import { EstimateAPIApi } from './apis/EstimateAPIApi';
import { TechnicianAssignmentAPIApi } from './apis/TechnicianAssignmentAPIApi';
import { WorkorderPickFacadeApi } from './apis/WorkorderPickFacadeApi';
import { WorkorderPickedItemsApi } from './apis/WorkorderPickedItemsApi';

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
  };
}
