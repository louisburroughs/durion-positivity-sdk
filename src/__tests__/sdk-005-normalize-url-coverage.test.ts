/**
 * Coverage: normalizeRequestUrl branches in Phase 2 factory index.ts files.
 *
 * Every Phase 2 factory embeds a module-private normalizeRequestUrl helper
 * that normalises the url argument before forwarding it to SdkHttpClient.
 * The existing sdk-005-client-integration.test.ts always invokes fetchApi
 * with string URLs, so the URL-object and Request-object branches (and the
 * String(url) fallback) are never reached.  This file provides the missing
 * coverage by calling fetchApi — extracted from the live configuration stored
 * on a generated API instance — with each of those input shapes.
 *
 * One describe block per factory × three url-type branches = 33 targeted
 * tests.  All factories share the same helper and fetch mock.
 *
 * Issue: SDK-005
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore
import { createCatalogClient } from '@durion-sdk/catalog';
// @ts-ignore
import { createCustomerClient } from '@durion-sdk/customer';
// @ts-ignore
import { createEventReceiverClient } from '@durion-sdk/event-receiver';
// @ts-ignore
import { createImageClient } from '@durion-sdk/image';
// @ts-ignore
import { createInvoiceClient } from '@durion-sdk/invoice';
// @ts-ignore
import { createLocationClient } from '@durion-sdk/location';
// @ts-ignore
import { createPeopleClient } from '@durion-sdk/people';
// @ts-ignore
import { createPriceClient } from '@durion-sdk/price';
// @ts-ignore
import { createShopManagerClient } from '@durion-sdk/shop-manager';
// @ts-ignore
import { createVehicleFitmentClient } from '@durion-sdk/vehicle-fitment';
// @ts-ignore
import { createVehicleInventoryClient } from '@durion-sdk/vehicle-inventory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchApiFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Walk the top-level keys of `client` and return the first `fetchApi`
 * function found on a nested `configuration` object.  The generated API
 * classes store the shared Configuration via `.configuration.fetchApi`.
 */
function getFirstFetchApi(client: any): FetchApiFn | undefined {
  for (const key of Object.keys(client as object)) {
    const fetchApi = (client[key] as any)?.configuration?.fetchApi;
    if (typeof fetchApi === 'function') {
      return fetchApi as FetchApiFn;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory registry
// ---------------------------------------------------------------------------

const FACTORIES: Array<{
  name: string;
  create: (cfg: { baseUrl: string }) => unknown;
  port: number;
}> = [
    { name: 'catalog', create: createCatalogClient, port: 8080 },
    { name: 'customer', create: createCustomerClient, port: 8081 },
    { name: 'invoice', create: createInvoiceClient, port: 8082 },
    { name: 'location', create: createLocationClient, port: 8083 },
    { name: 'people', create: createPeopleClient, port: 8084 },
    { name: 'price', create: createPriceClient, port: 8085 },
    { name: 'shop-manager', create: createShopManagerClient, port: 8086 },
    { name: 'image', create: createImageClient, port: 8087 },
    { name: 'event-receiver', create: createEventReceiverClient, port: 8088 },
    { name: 'vehicle-fitment', create: createVehicleFitmentClient, port: 8089 },
    { name: 'vehicle-inventory', create: createVehicleInventoryClient, port: 8090 },
  ];

// ---------------------------------------------------------------------------
// Tests — one describe per factory × 3 normalizeRequestUrl branch variants
// ---------------------------------------------------------------------------

describe('normalizeRequestUrl: URL and Request object branches in Phase 2 factories', () => {
  let fetchMock: jest.Mock;
  let savedFetch: unknown;

  beforeAll(() => {
    savedFetch = (globalThis as any).fetch;
  });

  afterAll(() => {
    (globalThis as any).fetch = savedFetch;
  });

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  for (const { name, create, port } of FACTORIES) {
    const BASE = `http://localhost:${port}`;

    describe(`sdk-${name}: normalizeRequestUrl`, () => {
      it(`passes a URL object to fetchApi — covers url instanceof URL branch`, async () => {
        const client = create({ baseUrl: BASE });
        const fetchApi = getFirstFetchApi(client);
        expect(fetchApi).toBeDefined();

        await fetchApi!(new URL(`${BASE}/api/test`), { method: 'GET' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it(`passes a Request object to fetchApi — covers url instanceof Request branch`, async () => {
        const client = create({ baseUrl: BASE });
        const fetchApi = getFirstFetchApi(client);
        expect(fetchApi).toBeDefined();

        await fetchApi!(new Request(`${BASE}/api/test`, { method: 'GET' }), { method: 'GET' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it(`passes an exotic object to fetchApi — covers String(url) fallback branch`, async () => {
        const client = create({ baseUrl: BASE });
        const fetchApi = getFirstFetchApi(client);
        expect(fetchApi).toBeDefined();

        // An object that is neither string, URL, nor Request reaches the final
        // `return String(url)` line in normalizeRequestUrl.
        const exotic = { toString: () => `${BASE}/api/test` } as unknown as RequestInfo;
        await fetchApi!(exotic, { method: 'GET' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });
  }
});
