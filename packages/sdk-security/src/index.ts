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

export function createSecurityClient(config: DurionSdkConfig) {
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

export { SecurityAuthWorkflow } from './workflows/securityAuthWorkflow';
export * from './runtime';
export * from './apis/index';
export * from './models/index';
export * from './workflows/securityAuthWorkflow';

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
