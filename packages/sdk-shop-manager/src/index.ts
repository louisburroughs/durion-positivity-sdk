/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
// Note: shopApi, assignmentApi, shopAuditControllerApi, shopBayApi,
// shopMobileUnitApi and workorderOperationalContextApi used to be constructed
// here from generated classes that had fallen out of the apis barrel. The
// regenerated pos-shop-manager contract settles what they were: bays, mobile
// units, service details and workorder operational context are gone from the
// spec entirely, and the two that survive moved to classes the barrel does
// export - /v1/appointments/{appointmentId}/assignments is
// appointmentAssignmentsApi, /v1/shop/audit is shopAuditApi. Both are already
// on this factory, so callers of the removed accessors switch to those.
import { Configuration } from './runtime';

export function createShopManagerClient(config: DurionSdkConfig) {
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
    appointmentsApi: new GeneratedApis.AppointmentsAPIApi(configuration),
    appointmentAssignmentsApi: new GeneratedApis.AppointmentAssignmentsApi(configuration),
    conflictOverrideApi: new GeneratedApis.ConflictOverrideAPIApi(configuration),
    scheduleApi: new GeneratedApis.ScheduleAPIApi(configuration),
    shopAuditApi: new GeneratedApis.ShopAuditApi(configuration),
    technicianApi: new GeneratedApis.TechnicianAPIApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';

// Re-exported, not re-declared: this package used to export its own identical
// copy of DurionSdkConfig, so `import type { DurionSdkConfig } from
// '@durion-sdk/shop-manager'` has to keep working. The canonical definition now lives
// in one place.
export type { DurionSdkConfig } from '@durion-sdk/transport';

