/* tslint:disable */
/* eslint-disable */
export * from './runtime';
export * from './apis/index';
export * from './models/index';
export { InventoryProcureToReceiveWorkflow } from './workflows/inventoryProcureToReceiveWorkflow';

import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import { ASNApi } from './apis/ASNApi';
import { CycleCountAdjustmentsApi } from './apis/CycleCountAdjustmentsApi';
import { InventoryManagementApi } from './apis/InventoryManagementApi';
import { PurchaseOrdersApi } from './apis/PurchaseOrdersApi';
import { ReceivingApi } from './apis/ReceivingApi';
import { BackordersApi } from './apis/BackordersApi';
import { InventoryAvailabilityApi } from './apis/InventoryAvailabilityApi';
import { PutawayApi } from './apis/PutawayApi';
import { PutawayExecutionApi } from './apis/PutawayExecutionApi';
import { PickListsApi } from './apis/PickListsApi';

export function createInventoryClient(config: DurionSdkConfig) {
  const httpClient = new SdkHttpClient(config);
  const configuration = new Configuration({
    basePath: config.baseUrl,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const sdkHeaders = await httpClient.buildRequestHeaders(method);
      const mergedHeaders = new Headers(init?.headers);
      Object.entries(sdkHeaders).forEach(([key, value]) => {
        mergedHeaders.set(key, value);
      });
      return fetch(url, { ...init, headers: mergedHeaders });
    },
  });
  return {
    asnApi: new ASNApi(configuration),
    cycleCountAdjustmentsApi: new CycleCountAdjustmentsApi(configuration),
    inventoryManagementApi: new InventoryManagementApi(configuration),
    /**
     * @deprecated Purchase orders moved to pos-order; these paths
     * (/v1/inventory/purchase-orders) 404 against the gateway. Use
     * `createOrderClient(...).purchaseOrdersApi` instead. Kept only so the
     * removal is a deliberate breaking change rather than a silent one.
     */
    purchaseOrdersApi: new PurchaseOrdersApi(configuration),
    receivingApi: new ReceivingApi(configuration),
    // Generated and exported by the apis barrel, but never surfaced here, so no
    // consumer of this factory could reach availability, backorders or putaway.
    inventoryAvailabilityApi: new InventoryAvailabilityApi(configuration),
    backordersApi: new BackordersApi(configuration),
    putawayApi: new PutawayApi(configuration),
    putawayExecutionApi: new PutawayExecutionApi(configuration),
    pickListsApi: new PickListsApi(configuration),
  };
}