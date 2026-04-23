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

export function createPriceClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const mergedHeaders = new Headers(init?.headers);
      const sdkHeaders: Record<string, string> = await httpClient.buildRequestHeaders(method, {
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
    priceQuotesApi: new GeneratedApis.PriceQuotesApi(configuration),
    priceRestrictionsApi: new GeneratedApis.PriceRestrictionsApi(configuration),
    priceNormalizationApi: new GeneratedApis.PriceNormalizationApi(configuration),
    pricingSnapshotsApi: new GeneratedApis.PricingSnapshotsApi(configuration),
    promotionEligibilityRulesApi: new GeneratedApis.PromotionEligibilityRulesApi(configuration),
    promotionOffersApi: new GeneratedApis.PromotionOffersApi(configuration),
    restrictionRulesApi: new GeneratedApis.RestrictionRulesApi(configuration),
  };
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
