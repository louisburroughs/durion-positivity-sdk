import { EstimateAPIApi } from '../apis/EstimateAPIApi';

export class WorkorderEstimateWorkflow {
  constructor(private readonly estimateApi: EstimateAPIApi) {}

  /** @operationId createEstimate */
  create(params: Parameters<EstimateAPIApi['createEstimate']>[0]) {
    return this.estimateApi.createEstimate(params);
  }

  /** @operationId submitForApproval */
  submitForApproval(params: Parameters<EstimateAPIApi['submitForApproval']>[0]) {
    return this.estimateApi.submitForApproval(params);
  }

  /** @operationId approveEstimate */
  approve(params: Parameters<EstimateAPIApi['approveEstimate']>[0]) {
    return this.estimateApi.approveEstimate(params);
  }

  /** @operationId declineEstimate */
  decline(params: Parameters<EstimateAPIApi['declineEstimate']>[0]) {
    return this.estimateApi.declineEstimate(params);
  }

  /** @operationId promoteEstimateToWorkorder */
  promoteToWorkorder(params: Parameters<EstimateAPIApi['promoteEstimateToWorkorder']>[0]) {
    return this.estimateApi.promoteEstimateToWorkorder(params);
  }
}
