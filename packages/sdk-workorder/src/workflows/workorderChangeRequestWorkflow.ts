import { ChangeRequestAPIApi } from '../apis/ChangeRequestAPIApi';

export class WorkorderChangeRequestWorkflow {
  constructor(private readonly changeRequestApi: ChangeRequestAPIApi) { }

  /** @operationId createChangeRequest */
  submit(params: Parameters<ChangeRequestAPIApi['createChangeRequest']>[0]) {
    return this.changeRequestApi.createChangeRequest(params);
  }

  /** @operationId approveChangeRequest */
  approve(params: Parameters<ChangeRequestAPIApi['approveChangeRequest']>[0]) {
    return this.changeRequestApi.approveChangeRequest(params);
  }

  /** @operationId declineChangeRequest */
  decline(params: Parameters<ChangeRequestAPIApi['declineChangeRequest']>[0]) {
    return this.changeRequestApi.declineChangeRequest(params);
  }
}
