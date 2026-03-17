/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

export function createSecurityClient(config: DurionSdkConfig) {
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
    adminAccountStateAPIApi: new GeneratedApis.AdminAccountStateAPIApi(configuration),
    auditApi: new GeneratedApis.AuditApi(configuration),
    authAPIApi: new GeneratedApis.AuthAPIApi(configuration),
    authorizationApi: new GeneratedApis.AuthorizationApi(configuration),
    jwtAPIApi: new GeneratedApis.JWTAPIApi(configuration),
    permissionRegistryApi: new GeneratedApis.PermissionRegistryApi(configuration),
    principalRoleManagementApi: new GeneratedApis.PrincipalRoleManagementApi(configuration),
    roleManagementApi: new GeneratedApis.RoleManagementApi(configuration),
    selfRegistrationReviewAPIApi: new GeneratedApis.SelfRegistrationReviewAPIApi(configuration),
    userAPIApi: new GeneratedApis.UserAPIApi(configuration),
    userRoleManagementApi: new GeneratedApis.UserRoleManagementApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
