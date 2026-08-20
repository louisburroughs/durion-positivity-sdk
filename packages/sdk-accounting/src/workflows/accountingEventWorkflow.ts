import { AccountingEventsApi } from '../apis/AccountingEventsApi';

export class AccountingEventWorkflow {
  constructor(private readonly accountingEventsApi: AccountingEventsApi) { }

  /** @operationId retryAccountingEvent */
  retry(params: Parameters<AccountingEventsApi['retryAccountingEvent']>[0]) {
    return this.accountingEventsApi.retryAccountingEvent(params);
  }

  /** @operationId reprocessSuspendedEvent */
  reprocess(params: Parameters<AccountingEventsApi['reprocessSuspendedEvent']>[0]) {
    return this.accountingEventsApi.reprocessSuspendedEvent(params);
  }

  /** @operationId submitAccountingEvent */
  submit(params: Parameters<AccountingEventsApi['submitAccountingEvent']>[0]) {
    return this.accountingEventsApi.submitAccountingEvent(params);
  }
}
