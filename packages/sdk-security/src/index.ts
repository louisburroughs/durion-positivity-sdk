/* tslint:disable */
/* eslint-disable */
export * from './runtime';
export * from './apis/index';
export * from './models/index';
export { SecurityAuthWorkflow } from './workflows/securityAuthWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { AuthAPIApi } from './apis/AuthAPIApi';
import { UserAPIApi } from './apis/UserAPIApi';
import { PermissionRegistryApi } from './apis/PermissionRegistryApi';
import { RoleManagementApi } from './apis/RoleManagementApi';
import { JWTAPIApi } from './apis/JWTAPIApi';

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
    authAPIApi: new AuthAPIApi(configuration),
    userAPIApi: new UserAPIApi(configuration),
    permissionRegistryApi: new PermissionRegistryApi(configuration),
    roleManagementApi: new RoleManagementApi(configuration),
    jwtAPIApi: new JWTAPIApi(configuration),
  };
}