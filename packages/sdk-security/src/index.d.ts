import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createSecurityClient(config: DurionSdkConfig): {
    adminAccountStateAPIApi: GeneratedApis.AdminAccountStateAPIApi;
    auditApi: GeneratedApis.AuditApi;
    authAPIApi: GeneratedApis.AuthAPIApi;
    authorizationApi: GeneratedApis.AuthorizationApi;
    jwtAPIApi: GeneratedApis.JWTAPIApi;
    permissionRegistryApi: GeneratedApis.PermissionRegistryApi;
    principalRoleManagementApi: GeneratedApis.PrincipalRoleManagementApi;
    roleManagementApi: GeneratedApis.RoleManagementApi;
    selfRegistrationReviewAPIApi: GeneratedApis.SelfRegistrationReviewAPIApi;
    userAPIApi: GeneratedApis.UserAPIApi;
    userRoleManagementApi: GeneratedApis.UserRoleManagementApi;
};
export { SecurityAuthWorkflow } from './workflows/securityAuthWorkflow';
export * from './runtime';
export * from './apis/index';
export * from './models/index';
