"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryProcureToReceiveWorkflow = void 0;
class InventoryProcureToReceiveWorkflow {
    constructor(purchaseOrdersApi, asnApi, receivingApi, availabilityApi) {
        this.purchaseOrdersApi = purchaseOrdersApi;
        this.asnApi = asnApi;
        this.receivingApi = receivingApi;
        this.availabilityApi = availabilityApi;
    }
    /** @operationId createPurchaseOrder */
    createPurchaseOrder(params) {
        return this.purchaseOrdersApi.createPurchaseOrder(params);
    }
    /** @operationId approvePurchaseOrder */
    approvePurchaseOrder(params) {
        return this.purchaseOrdersApi.approvePurchaseOrder(params);
    }
    /** @operationId createAsn */
    registerAsn(params) {
        return this.asnApi.createAsn(params);
    }
    /** @operationId createReceivingSession */
    startReceivingSession(params) {
        return this.receivingApi.createReceivingSession(params);
    }
    /** @operationId receiveItemsIntoStaging */
    receiveItems(params) {
        return this.receivingApi.receiveItemsIntoStaging(params);
    }
    /** @operationId queryInventoryAvailability */
    checkAvailability(params) {
        return this.availabilityApi.queryInventoryAvailability(params);
    }
}
exports.InventoryProcureToReceiveWorkflow = InventoryProcureToReceiveWorkflow;
