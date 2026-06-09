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
export function createAccountingClient(config: DurionSdkConfig) {
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
    apPaymentsApi: new GeneratedApis.APPaymentsApi(configuration),
    accountingEventsApi: new GeneratedApis.AccountingEventsApi(configuration),
    auditTrailApi: new GeneratedApis.AuditTrailApi(configuration),
    creditMemosApi: new GeneratedApis.CreditMemosApi(configuration),
    defaultGLMappingsApi: new GeneratedApis.DefaultGLMappingsApi(configuration),
    financialReportingApi: new GeneratedApis.FinancialReportingApi(configuration),
    glAccountsApi: new GeneratedApis.GLAccountsApi(configuration),
    glMappingAPIApi: new GeneratedApis.GLMappingAPIApi(configuration),
    invoicePaymentsApi: new GeneratedApis.InvoicePaymentsApi(configuration),
    journalEntriesApi: new GeneratedApis.JournalEntriesApi(configuration),
    mappingKeysApi: new GeneratedApis.MappingKeysApi(configuration),
    paymentApplicationsApi: new GeneratedApis.PaymentApplicationsApi(configuration),
    postingCategoriesApi: new GeneratedApis.PostingCategoriesApi(configuration),
    postingRulesApi: new GeneratedApis.PostingRulesApi(configuration),
    vendorBillAPIApi: new GeneratedApis.VendorBillAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
export * from './workflows/accountingEventWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { JournalEntriesApi } from './apis/JournalEntriesApi';
import { GLAccountsApi } from './apis/GLAccountsApi';
import { FinancialReportingApi } from './apis/FinancialReportingApi';

export function createAccountingClient(config: DurionSdkConfig) {
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
    journalEntriesApi: new JournalEntriesApi(configuration),
    glAccountsApi: new GLAccountsApi(configuration),
    financialReportingApi: new FinancialReportingApi(configuration),
  };
}
