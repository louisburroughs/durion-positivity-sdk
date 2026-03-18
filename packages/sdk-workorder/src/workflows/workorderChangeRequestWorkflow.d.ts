import { ChangeRequestAPIApi } from '../apis/ChangeRequestAPIApi';
export declare class WorkorderChangeRequestWorkflow {
    private readonly changeRequestApi;
    constructor(changeRequestApi: ChangeRequestAPIApi);
    /** @operationId createChangeRequest */
    submit(params: Parameters<ChangeRequestAPIApi['createChangeRequest']>[0]): Promise<import("..").ChangeRequestResponse>;
    /** @operationId approveChangeRequest */
    approve(params: Parameters<ChangeRequestAPIApi['approveChangeRequest']>[0]): Promise<import("..").ChangeRequestResponse>;
    /** @operationId declineChangeRequest */
    decline(params: Parameters<ChangeRequestAPIApi['declineChangeRequest']>[0]): Promise<import("..").ChangeRequestResponse>;
}
