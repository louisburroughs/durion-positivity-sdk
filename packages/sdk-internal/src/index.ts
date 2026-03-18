/* tslint:disable */
/* eslint-disable */
/**
 * @internal
 * This package is INTERNAL ONLY and classified under ADR-0021.
 * It is NOT intended for consumption by external clients or public SDK users.
 * Do not re-export from any public @durion-sdk/* package.
 */
import { DurionSdkConfig, SdkHttpClient } from '@durion-sdk/transport';
import { Configuration } from './runtime';
import * as GeneratedApis from './apis';

function normalizeRequestUrl(url: RequestInfo | URL): string {
	if (typeof url === 'string') {
		return url;
	}
	if (url instanceof URL) {
		return url.toString();
	}
	if (typeof Request !== 'undefined' && url instanceof Request) {
		return url.url;
	}
	return String(url);
}

/**
 * @internal
 * Creates an internal tax service client. Only for use by internal platform services.
 * See ADR-0021 for access policy.
 */
export function createTaxClient(config: DurionSdkConfig) {
	const httpClient = new SdkHttpClient(config);
	const configuration = new Configuration({
		basePath: config.baseUrl,
		fetchApi: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const method = (init?.method ?? 'GET').toUpperCase();
			const mergedHeaders = new Headers(init?.headers);
			const sdkHeaders = await httpClient.buildRequestHeaders(method, {
				url: normalizeRequestUrl(url),
				idempotencyKey: mergedHeaders.get('Idempotency-Key') ?? undefined,
			});
			Object.entries(sdkHeaders).forEach(([key, value]) => {
				mergedHeaders.set(key, value);
			});
			return fetch(url, { ...init, headers: mergedHeaders });
		},
	});

	return {
		taxApi: new GeneratedApis.TaxApi(configuration),
	};
}

export * from './runtime';
export * from './apis/index';
export * from './models/index';
