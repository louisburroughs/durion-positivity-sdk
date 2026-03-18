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

export function createAccountingClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const sdkHeaders = await httpClient.buildRequestHeaders(method, {
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
