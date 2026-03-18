import { PurchaseOrdersApi } from '../apis/PurchaseOrdersApi';
import { ASNApi } from '../apis/ASNApi';
import { ReceivingApi } from '../apis/ReceivingApi';
import { InventoryAvailabilityApi } from '../apis/InventoryAvailabilityApi';

export class InventoryProcureToReceiveWorkflow {
  constructor(
    private readonly purchaseOrdersApi: PurchaseOrdersApi,
    private readonly asnApi: ASNApi,
    private readonly receivingApi: ReceivingApi,
    private readonly availabilityApi: InventoryAvailabilityApi,
  ) {}

  /** @operationId createPurchaseOrder */
  createPurchaseOrder(params: Parameters<PurchaseOrdersApi['createPurchaseOrder']>[0]) {
    return this.purchaseOrdersApi.createPurchaseOrder(params);
  }

  /** @operationId approvePurchaseOrder */
  approvePurchaseOrder(params: Parameters<PurchaseOrdersApi['approvePurchaseOrder']>[0]) {
    return this.purchaseOrdersApi.approvePurchaseOrder(params);
  }

  /** @operationId createAsn */
  registerAsn(params: Parameters<ASNApi['createAsn']>[0]) {
    return this.asnApi.createAsn(params);
  }

  /** @operationId createReceivingSession */
  startReceivingSession(params: Parameters<ReceivingApi['createReceivingSession']>[0]) {
    return this.receivingApi.createReceivingSession(params);
  }

  /** @operationId receiveItemsIntoStaging */
  receiveItems(params: Parameters<ReceivingApi['receiveItemsIntoStaging']>[0]) {
    return this.receivingApi.receiveItemsIntoStaging(params);
  }

  /** @operationId queryInventoryAvailability */
  checkAvailability(params: Parameters<InventoryAvailabilityApi['queryInventoryAvailability']>[0]) {
    return this.availabilityApi.queryInventoryAvailability(params);
  }
}
