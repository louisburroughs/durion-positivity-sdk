import { AccountingEventsApi } from '../apis/AccountingEventsApi';
export declare class AccountingEventWorkflow {
    private readonly accountingEventsApi;
    constructor(accountingEventsApi: AccountingEventsApi);
    /** @operationId retryEventProcessing */
    retry(params: Parameters<AccountingEventsApi['retryEventProcessing']>[0]): Promise<import("..").AccountingEventResponse>;
    /** @operationId reprocessSuspendedEvent */
    reprocess(params: Parameters<AccountingEventsApi['reprocessSuspendedEvent']>[0]): Promise<import("..").AccountingEventResponse>;
    /** @operationId submitEvent */
    submit(params: Parameters<AccountingEventsApi['submitEvent']>[0]): Promise<import("..").AccountingEventResponse>;
}
