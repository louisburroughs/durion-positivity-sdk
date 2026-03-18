import { PurchaseOrdersApi } from '../apis/PurchaseOrdersApi';
import { ASNApi } from '../apis/ASNApi';
import { ReceivingApi } from '../apis/ReceivingApi';
import { InventoryAvailabilityApi } from '../apis/InventoryAvailabilityApi';
export declare class InventoryProcureToReceiveWorkflow {
    private readonly purchaseOrdersApi;
    private readonly asnApi;
    private readonly receivingApi;
    private readonly availabilityApi;
    constructor(purchaseOrdersApi: PurchaseOrdersApi, asnApi: ASNApi, receivingApi: ReceivingApi, availabilityApi: InventoryAvailabilityApi);
    /** @operationId createPurchaseOrder */
    createPurchaseOrder(params: Parameters<PurchaseOrdersApi['createPurchaseOrder']>[0]): Promise<import("..").PurchaseOrderResponse>;
    /** @operationId approvePurchaseOrder */
    approvePurchaseOrder(params: Parameters<PurchaseOrdersApi['approvePurchaseOrder']>[0]): Promise<import("..").PurchaseOrderResponse>;
    /** @operationId createAsn */
    registerAsn(params: Parameters<ASNApi['createAsn']>[0]): Promise<import("..").AsnResponse>;
    /** @operationId createReceivingSession */
    startReceivingSession(params: Parameters<ReceivingApi['createReceivingSession']>[0]): Promise<import("..").ReceivingSessionResponse>;
    /** @operationId receiveItemsIntoStaging */
    receiveItems(params: Parameters<ReceivingApi['receiveItemsIntoStaging']>[0]): Promise<import("..").ReceiveItemsResponse>;
    /** @operationId queryInventoryAvailability */
    checkAvailability(params: Parameters<InventoryAvailabilityApi['queryInventoryAvailability']>[0]): Promise<Array<import("..").LocationAvailabilityDto>>;
}
