import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createPeopleClient(config: DurionSdkConfig): {
    employeeApi: GeneratedApis.EmployeeAPIApi;
    peopleApi: GeneratedApis.PeopleAPIApi;
    peopleAvailabilityApi: GeneratedApis.PeopleAvailabilityAPIApi;
    peopleAccessControlApi: GeneratedApis.PeopleAccessControlApi;
    peopleExceptionsApi: GeneratedApis.PeopleExceptionsApi;
    peopleReportsAPIApi: GeneratedApis.PeopleReportsAPIApi;
    peopleStaffingAssignmentsApi: GeneratedApis.PeopleStaffingAssignmentsApi;
    peopleTimeEntriesApi: GeneratedApis.PeopleTimeEntriesApi;
    timeEntryApprovalAPIApi: GeneratedApis.TimeEntryApprovalAPIApi;
    userPersonLinkingAPIApi: GeneratedApis.UserPersonLinkingAPIApi;
    workSessionsAPIApi: GeneratedApis.WorkSessionsAPIApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
