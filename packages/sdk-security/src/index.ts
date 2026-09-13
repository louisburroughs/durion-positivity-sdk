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
import { UserRoleManagementApi } from './apis/UserRoleManagementApi';
import { TenantAPIApi } from './apis/TenantAPIApi';
import { PlatformAdministratorAPIApi } from './apis/PlatformAdministratorAPIApi';
import { PlatformSupportAPIApi } from './apis/PlatformSupportAPIApi';
import { PlatformRoleTemplateAPIApi } from './apis/PlatformRoleTemplateAPIApi';

export function createSecurityClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
        url: urlStr,
        idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
      });
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
    // Reading a user's effective permissions and assigning a single role by id
    // (GET /v1/users/{userId}/permissions, PUT /v1/users/{userId}/roles/{roleId})
    // live here, not on roleManagementApi. Surfaced so the integration suite's
    // role-mode preflight can verify a persona before any suite runs.
    userRoleManagementApi: new UserRoleManagementApi(configuration),
    // The tenant-aware surface. Generated and exported by the apis barrel, but
    // never surfaced here, so no consumer of this factory could ask which
    // tenant its own token is bound to, nor reach anything under
    // /v1/platform/tenants. This file is hand-maintained and protected by
    // .openapi-generator-ignore, so regeneration adds a class without ever
    // adding its accessor -- the gap does not close on its own.
    tenantAPIApi: new TenantAPIApi(configuration),
    platformAdministratorAPIApi: new PlatformAdministratorAPIApi(configuration),
    platformSupportAPIApi: new PlatformSupportAPIApi(configuration),
    platformRoleTemplateAPIApi: new PlatformRoleTemplateAPIApi(configuration),
  };
}