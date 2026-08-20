import { EstimateAPIApi } from '../apis/EstimateAPIApi';

export class WorkorderEstimateWorkflow {
  constructor(private readonly estimateApi: EstimateAPIApi) { }

  /** @operationId createEstimate */
  create(params: Parameters<EstimateAPIApi['createEstimate']>[0]) {
    return this.estimateApi.createEstimate(params);
  }

  /** @operationId submitEstimateForApproval */
  submitForApproval(params: Parameters<EstimateAPIApi['submitEstimateForApproval']>[0]) {
    return this.estimateApi.submitEstimateForApproval(params);
  }

  /** @operationId approveEstimate */
  approve(params: Parameters<EstimateAPIApi['approveEstimate']>[0]) {
    return this.estimateApi.approveEstimate(params);
  }

  /** @operationId declineEstimate */
  decline(params: Parameters<EstimateAPIApi['declineEstimate']>[0]) {
    return this.estimateApi.declineEstimate(params);
  }

  /** @operationId promoteEstimate */
  promoteToWorkorder(params: Parameters<EstimateAPIApi['promoteEstimate']>[0]) {
    return this.estimateApi.promoteEstimate(params);
  }
}
