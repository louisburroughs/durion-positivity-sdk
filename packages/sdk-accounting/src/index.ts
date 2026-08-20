/* tslint:disable */
/* eslint-disable */
export * from './runtime';
export * from './apis/index';
export * from './models/index';
export * from './workflows/accountingEventWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { JournalEntriesApi } from './apis/JournalEntriesApi';
import { GLAccountsApi } from './apis/GLAccountsApi';
import { FinancialReportingApi } from './apis/FinancialReportingApi';
import { AccountingEventsApi } from './apis/AccountingEventsApi';

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
    accountingEventsApi: new AccountingEventsApi(configuration),
  };
}