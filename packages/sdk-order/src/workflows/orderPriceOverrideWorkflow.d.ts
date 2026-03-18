import { PriceOverridesApi } from '../apis/PriceOverridesApi';
export declare class OrderPriceOverrideWorkflow {
    private readonly priceOverridesApi;
    constructor(priceOverridesApi: PriceOverridesApi);
    /** @operationId applyPriceOverride */
    submit(params: Parameters<PriceOverridesApi['applyPriceOverride']>[0]): Promise<{
        [key: string]: any;
    }>;
    /** @operationId approvePriceOverride */
    approve(params: Parameters<PriceOverridesApi['approvePriceOverride']>[0]): Promise<{
        [key: string]: any;
    }>;
    /** @operationId rejectPriceOverride */
    reject(params: Parameters<PriceOverridesApi['rejectPriceOverride']>[0]): Promise<{
        [key: string]: any;
    }>;
    /** @operationId getPendingApprovals */
    getPending(): Promise<Array<import("..").PriceOverrideDetail>>;
}
