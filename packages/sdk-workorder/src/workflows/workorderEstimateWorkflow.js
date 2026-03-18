"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkorderEstimateWorkflow = void 0;
class WorkorderEstimateWorkflow {
    constructor(estimateApi) {
        this.estimateApi = estimateApi;
    }
    /** @operationId createEstimate */
    create(params) {
        return this.estimateApi.createEstimate(params);
    }
    /** @operationId submitForApproval */
    submitForApproval(params) {
        return this.estimateApi.submitForApproval(params);
    }
    /** @operationId approveEstimate */
    approve(params) {
        return this.estimateApi.approveEstimate(params);
    }
    /** @operationId declineEstimate */
    decline(params) {
        return this.estimateApi.declineEstimate(params);
    }
    /** @operationId promoteEstimateToWorkorder */
    promoteToWorkorder(params) {
        return this.estimateApi.promoteEstimateToWorkorder(params);
    }
}
exports.WorkorderEstimateWorkflow = WorkorderEstimateWorkflow;
