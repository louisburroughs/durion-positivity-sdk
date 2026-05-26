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
export function createPeopleClient(config: DurionSdkConfig) {
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
    employeeApi: new GeneratedApis.EmployeeAPIApi(configuration),
    peopleApi: new GeneratedApis.PeopleAPIApi(configuration),
    peopleAvailabilityApi: new GeneratedApis.PeopleAvailabilityAPIApi(configuration),
    peopleAccessControlApi: new GeneratedApis.PeopleAccessControlApi(configuration),
    peopleExceptionsApi: new GeneratedApis.PeopleExceptionsApi(configuration),
    peopleReportsAPIApi: new GeneratedApis.PeopleReportsAPIApi(configuration),
    peopleStaffingAssignmentsApi: new GeneratedApis.PeopleStaffingAssignmentsApi(configuration),
    peopleTimeEntriesApi: new GeneratedApis.PeopleTimeEntriesApi(configuration),
    timeEntryApprovalAPIApi: new GeneratedApis.TimeEntryApprovalAPIApi(configuration),
    userPersonLinkingAPIApi: new GeneratedApis.UserPersonLinkingAPIApi(configuration),
    workSessionsAPIApi: new GeneratedApis.WorkSessionsAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';