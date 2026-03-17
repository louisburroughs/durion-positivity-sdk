/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

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
		asnApi: new GeneratedApis.ASNApi(configuration),
		consumptionApi: new GeneratedApis.ConsumptionApi(configuration),
		cycleCountAdjustmentsApi: new GeneratedApis.CycleCountAdjustmentsApi(configuration),
		cycleCountOperationsApi: new GeneratedApis.CycleCountOperationsApi(configuration),
		cycleCountPlansApi: new GeneratedApis.CycleCountPlansApi(configuration),
		cycleCountQueryApi: new GeneratedApis.CycleCountQueryApi(configuration),
		inventoryAvailabilityApi: new GeneratedApis.InventoryAvailabilityApi(configuration),
		inventoryLocationsApi: new GeneratedApis.InventoryLocationsApi(configuration),
		inventoryManagementApi: new GeneratedApis.InventoryManagementApi(configuration),
		inventoryReservationsApi: new GeneratedApis.InventoryReservationsApi(configuration),
		inventorySitesApi: new GeneratedApis.InventorySitesApi(configuration),
		pickListsApi: new GeneratedApis.PickListsApi(configuration),
		pickingListsApi: new GeneratedApis.PickingListsApi(configuration),
		purchaseOrdersApi: new GeneratedApis.PurchaseOrdersApi(configuration),
		putawayApi: new GeneratedApis.PutawayApi(configuration),
		putawayExecutionApi: new GeneratedApis.PutawayExecutionApi(configuration),
		reallocationApi: new GeneratedApis.ReallocationApi(configuration),
		receivingApi: new GeneratedApis.ReceivingApi(configuration),
		replenishmentApi: new GeneratedApis.ReplenishmentApi(configuration),
		returnsApi: new GeneratedApis.ReturnsApi(configuration),
		shortageResolutionApi: new GeneratedApis.ShortageResolutionApi(configuration),
		stockMovementsApi: new GeneratedApis.StockMovementsApi(configuration),
	};
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
