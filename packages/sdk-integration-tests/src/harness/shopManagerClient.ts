import { AppointmentsAPIApi, Configuration } from '@durion-sdk/shop-manager';

/**
 * sdk-shop-manager ships no create*Client factory (unlike the other domain
 * packages), so this shim mirrors their generated pattern: a Configuration
 * whose fetchApi injects the bearer token, API version, and correlation id
 * on every request. The gateway route prefix is `shop-manager`.
 */
export interface ShopManagerClient {
  appointmentsApi: AppointmentsAPIApi;
}

export function createShopManagerClient(options: {
  baseUrl: string;
  token: () => string;
}): ShopManagerClient {
  const configuration = new Configuration({
    basePath: `${options.baseUrl}/shop-manager`,
    fetchApi: async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${options.token()}`);
      if (!headers.has('X-API-Version')) {
        headers.set('X-API-Version', '1');
      }
      if (!headers.has('X-Correlation-Id')) {
        headers.set('X-Correlation-Id', crypto.randomUUID());
      }
      return fetch(url, { ...init, headers });
    },
  });

  return {
    appointmentsApi: new AppointmentsAPIApi(configuration),
  };
}
