import { PriceOverridesApi } from '../apis/PriceOverridesApi';

export class OrderPriceOverrideWorkflow {
  constructor(private readonly priceOverridesApi: PriceOverridesApi) { }

  /** @operationId applyPriceOverride */
  submit(params: Parameters<PriceOverridesApi['applyPriceOverride']>[0]) {
    return this.priceOverridesApi.applyPriceOverride(params);
  }

  /** @operationId approvePriceOverride */
  approve(params: Parameters<PriceOverridesApi['approvePriceOverride']>[0]) {
    return this.priceOverridesApi.approvePriceOverride(params);
  }

  /** @operationId rejectPriceOverride */
  reject(params: Parameters<PriceOverridesApi['rejectPriceOverride']>[0]) {
    return this.priceOverridesApi.rejectPriceOverride(params);
  }

  /** @operationId getPendingApprovals */
  getPending() {
    return this.priceOverridesApi.getPendingApprovals();
  }
}
