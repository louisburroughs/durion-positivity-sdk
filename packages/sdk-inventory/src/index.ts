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
import { ReceivingApi } from './apis/ReceivingApi';
import { BackordersApi } from './apis/BackordersApi';
import { InventoryAvailabilityApi } from './apis/InventoryAvailabilityApi';
import { PutawayApi } from './apis/PutawayApi';
import { PutawayExecutionApi } from './apis/PutawayExecutionApi';
import { PickListsApi } from './apis/PickListsApi';
import { CycleCountOperationsApi } from './apis/CycleCountOperationsApi';
import { CycleCountPlansApi } from './apis/CycleCountPlansApi';
import { CycleCountQueryApi } from './apis/CycleCountQueryApi';
import { CycleCountTolerancesApi } from './apis/CycleCountTolerancesApi';
import { InventoryBulkIngestAPIApi } from './apis/InventoryBulkIngestAPIApi';
import { StockMovementsApi } from './apis/StockMovementsApi';

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
    // Note: purchaseOrdersApi is deliberately absent. Purchase orders moved to
    // pos-order and the regenerated pos-inventory contract no longer declares
    // /v1/inventory/purchase-orders, so the class and its DTOs were dropped
    // rather than kept as a deprecated accessor that 404s. Use
    // `createOrderClient(...).purchaseOrdersApi`.
    receivingApi: new ReceivingApi(configuration),
    // Generated and exported by the apis barrel, but never surfaced here, so no
    // consumer of this factory could reach availability, backorders or putaway.
    inventoryAvailabilityApi: new InventoryAvailabilityApi(configuration),
    backordersApi: new BackordersApi(configuration),
    putawayApi: new PutawayApi(configuration),
    putawayExecutionApi: new PutawayExecutionApi(configuration),
    pickListsApi: new PickListsApi(configuration),
    // The rest of the cycle count family. cycleCountAdjustmentsApi was surfaced
    // on its own, which left the factory able to settle a count it could not
    // plan, generate, record or read.
    cycleCountPlansApi: new CycleCountPlansApi(configuration),
    cycleCountOperationsApi: new CycleCountOperationsApi(configuration),
    cycleCountQueryApi: new CycleCountQueryApi(configuration),
    cycleCountTolerancesApi: new CycleCountTolerancesApi(configuration),
    // Stock arrives through these two together: bulk ingest raises an
    // adjustment request per row and stock movements approves it, which is what
    // posts the ledger entry.
    inventoryBulkIngestAPIApi: new InventoryBulkIngestAPIApi(configuration),
    stockMovementsApi: new StockMovementsApi(configuration),
  };
}