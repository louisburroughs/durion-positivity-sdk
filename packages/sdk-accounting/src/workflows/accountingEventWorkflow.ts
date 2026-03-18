import { AccountingEventsApi } from '../apis/AccountingEventsApi';

export class AccountingEventWorkflow {
  constructor(private readonly accountingEventsApi: AccountingEventsApi) { }

  /** @operationId retryEventProcessing */
  retry(params: Parameters<AccountingEventsApi['retryEventProcessing']>[0]) {
    return this.accountingEventsApi.retryEventProcessing(params);
  }

  /** @operationId reprocessSuspendedEvent */
  reprocess(params: Parameters<AccountingEventsApi['reprocessSuspendedEvent']>[0]) {
    return this.accountingEventsApi.reprocessSuspendedEvent(params);
  }

  /** @operationId submitEvent */
  submit(params: Parameters<AccountingEventsApi['submitEvent']>[0]) {
    return this.accountingEventsApi.submitEvent(params);
  }
}
