"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountingEventWorkflow = void 0;
class AccountingEventWorkflow {
    constructor(accountingEventsApi) {
        this.accountingEventsApi = accountingEventsApi;
    }
    /** @operationId retryEventProcessing */
    retry(params) {
        return this.accountingEventsApi.retryEventProcessing(params);
    }
    /** @operationId reprocessSuspendedEvent */
    reprocess(params) {
        return this.accountingEventsApi.reprocessSuspendedEvent(params);
    }
    /** @operationId submitEvent */
    submit(params) {
        return this.accountingEventsApi.submitEvent(params);
    }
}
exports.AccountingEventWorkflow = AccountingEventWorkflow;
