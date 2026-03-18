import { DurionSdkConfig } from '@durion-sdk/transport';
import * as GeneratedApis from './apis';
export declare function createPriceClient(config: DurionSdkConfig): {
    priceQuotesApi: GeneratedApis.PriceQuotesApi;
    priceRestrictionsApi: GeneratedApis.PriceRestrictionsApi;
    priceNormalizationApi: GeneratedApis.PriceNormalizationApi;
    pricingSnapshotsApi: GeneratedApis.PricingSnapshotsApi;
    promotionEligibilityRulesApi: GeneratedApis.PromotionEligibilityRulesApi;
    promotionOffersApi: GeneratedApis.PromotionOffersApi;
    restrictionRulesApi: GeneratedApis.RestrictionRulesApi;
};
export * from './runtime';
export * from './apis/index';
export * from './models/index';
