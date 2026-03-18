"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkorderChangeRequestWorkflow = void 0;
class WorkorderChangeRequestWorkflow {
    constructor(changeRequestApi) {
        this.changeRequestApi = changeRequestApi;
    }
    /** @operationId createChangeRequest */
    submit(params) {
        return this.changeRequestApi.createChangeRequest(params);
    }
    /** @operationId approveChangeRequest */
    approve(params) {
        return this.changeRequestApi.approveChangeRequest(params);
    }
    /** @operationId declineChangeRequest */
    decline(params) {
        return this.changeRequestApi.declineChangeRequest(params);
    }
}
exports.WorkorderChangeRequestWorkflow = WorkorderChangeRequestWorkflow;
