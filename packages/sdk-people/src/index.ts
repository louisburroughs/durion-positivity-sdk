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

export function createPeopleClient(config: DurionSdkConfig) {
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
