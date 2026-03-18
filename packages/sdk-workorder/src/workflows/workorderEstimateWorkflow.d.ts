import { EstimateAPIApi } from '../apis/EstimateAPIApi';
export declare class WorkorderEstimateWorkflow {
    private readonly estimateApi;
    constructor(estimateApi: EstimateAPIApi);
    /** @operationId createEstimate */
    create(params: Parameters<EstimateAPIApi['createEstimate']>[0]): Promise<any>;
    /** @operationId submitForApproval */
    submitForApproval(params: Parameters<EstimateAPIApi['submitForApproval']>[0]): Promise<import("..").EstimateResponse>;
    /** @operationId approveEstimate */
    approve(params: Parameters<EstimateAPIApi['approveEstimate']>[0]): Promise<import("..").EstimateResponse>;
    /** @operationId declineEstimate */
    decline(params: Parameters<EstimateAPIApi['declineEstimate']>[0]): Promise<import("..").EstimateResponse>;
    /** @operationId promoteEstimateToWorkorder */
    promoteToWorkorder(params: Parameters<EstimateAPIApi['promoteEstimateToWorkorder']>[0]): Promise<import("..").WorkorderResponse>;
}
