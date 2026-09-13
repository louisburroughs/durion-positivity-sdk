/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
// These API classes are no longer part of the generated apis barrel but their
import { Configuration } from './runtime';

// Note: PeopleAPIApi, PeopleAccessControlApi and UserPersonLinkingAPIApi used to
// be constructed here. Those endpoints (/v1/people/{personId},
// /v1/people/{personId}/users, /v1/people/user-links/{personId}) are declared by
// pos-people-contact, not pos-people, so pointing them at this client's base URL
// could never work. They now live in @durion-sdk/people-contact.
export function createPeopleClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method ?? 'GET') as string).toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
        url: urlStr,
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });
      Object.keys(sdkHeaders).forEach((key: string) => mergedHeaders.set(key, sdkHeaders[key]));
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    employeeApi: new GeneratedApis.EmployeeAPIApi(configuration),
    peopleAvailabilityApi: new GeneratedApis.PeopleAvailabilityAPIApi(configuration),
    peopleBulkIngestAPIApi: new GeneratedApis.PeopleBulkIngestAPIApi(configuration),
    peopleComplianceAPIApi: new GeneratedApis.PeopleComplianceAPIApi(configuration),
    peopleExceptionsApi: new GeneratedApis.PeopleExceptionsApi(configuration),
    peopleReportsAPIApi: new GeneratedApis.PeopleReportsAPIApi(configuration),
    peopleStaffingAssignmentsApi: new GeneratedApis.PeopleStaffingAssignmentsApi(configuration),
    peopleTimeEntriesApi: new GeneratedApis.PeopleTimeEntriesApi(configuration),
    timeEntryApprovalAPIApi: new GeneratedApis.TimeEntryApprovalAPIApi(configuration),
    timePeriodManagementAPIApi: new GeneratedApis.TimePeriodManagementAPIApi(configuration),
    timekeepingApprovalAPIApi: new GeneratedApis.TimekeepingApprovalAPIApi(configuration),
    workSessionsAPIApi: new GeneratedApis.WorkSessionsAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';