"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderPriceOverrideWorkflow = void 0;
class OrderPriceOverrideWorkflow {
    priceOverridesApi;
    constructor(priceOverridesApi) {
        this.priceOverridesApi = priceOverridesApi;
    }
    /** @operationId applyPriceOverride */
    submit(params) {
        return this.priceOverridesApi.applyPriceOverride(params);
    }
    /** @operationId approvePriceOverride */
    approve(params) {
        return this.priceOverridesApi.approvePriceOverride(params);
    }
    /** @operationId rejectPriceOverride */
    reject(params) {
        return this.priceOverridesApi.rejectPriceOverride(params);
    }
    /** @operationId getPendingApprovals */
    getPending() {
        return this.priceOverridesApi.getPendingApprovals();
    }
}
exports.OrderPriceOverrideWorkflow = OrderPriceOverrideWorkflow;
