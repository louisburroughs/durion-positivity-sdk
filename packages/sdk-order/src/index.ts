/* tslint:disable */
/* eslint-disable */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

export function createOrderClient(config: DurionSdkConfig) {
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
		orderCancellationApi: new GeneratedApis.OrderCancellationApi(configuration),
		priceOverridesApi: new GeneratedApis.PriceOverridesApi(configuration),
		salesOrdersApi: new GeneratedApis.SalesOrdersApi(configuration),
	};
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
