import { ASNApi } from '../apis/ASNApi';
import { ReceivingApi } from '../apis/ReceivingApi';
import { InventoryAvailabilityApi } from '../apis/InventoryAvailabilityApi';

/**
 * The procure half of procure-to-receive now lives in pos-order: creating and
 * approving a purchase order is `createOrderClient(...).purchaseOrdersApi`, and
 * the regenerated pos-inventory contract no longer declares those paths. This
 * workflow covers what pos-inventory still owns - ASN, receiving, availability -
 * and takes the PO id the order service issued.
 */
export class InventoryProcureToReceiveWorkflow {
  constructor(
    private readonly asnApi: ASNApi,
    private readonly receivingApi: ReceivingApi,
    private readonly availabilityApi: InventoryAvailabilityApi,
  ) { }

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

  /** @operationId getAvailabilityByProduct */
  checkAvailability(params: Parameters<InventoryAvailabilityApi['getAvailabilityByProduct']>[0]) {
    return this.availabilityApi.getAvailabilityByProduct(params);
  }
}
