"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore
const catalog_1 = require("@durion-sdk/catalog");
// @ts-ignore
const customer_1 = require("@durion-sdk/customer");
// @ts-ignore
const event_receiver_1 = require("@durion-sdk/event-receiver");
// @ts-ignore
const image_1 = require("@durion-sdk/image");
// @ts-ignore
const invoice_1 = require("@durion-sdk/invoice");
// @ts-ignore
const location_1 = require("@durion-sdk/location");
// @ts-ignore
const people_1 = require("@durion-sdk/people");
// @ts-ignore
const price_1 = require("@durion-sdk/price");
// @ts-ignore
const shop_manager_1 = require("@durion-sdk/shop-manager");
// @ts-ignore
const vehicle_fitment_1 = require("@durion-sdk/vehicle-fitment");
// @ts-ignore
const vehicle_inventory_1 = require("@durion-sdk/vehicle-inventory");
/**
 * Walk the top-level keys of `client` and return the first `fetchApi`
 * function found on a nested `configuration` object.  The generated API
 * classes store the shared Configuration via `.configuration.fetchApi`.
 */
function getFirstFetchApi(client) {
    var _a, _b;
    for (const key of Object.keys(client)) {
        const fetchApi = (_b = (_a = client[key]) === null || _a === void 0 ? void 0 : _a.configuration) === null || _b === void 0 ? void 0 : _b.fetchApi;
        if (typeof fetchApi === 'function') {
            return fetchApi;
        }
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Factory registry
// ---------------------------------------------------------------------------
const FACTORIES = [
    { name: 'catalog', create: catalog_1.createCatalogClient, port: 8080 },
    { name: 'customer', create: customer_1.createCustomerClient, port: 8081 },
    { name: 'invoice', create: invoice_1.createInvoiceClient, port: 8082 },
    { name: 'location', create: location_1.createLocationClient, port: 8083 },
    { name: 'people', create: people_1.createPeopleClient, port: 8084 },
    { name: 'price', create: price_1.createPriceClient, port: 8085 },
    { name: 'shop-manager', create: shop_manager_1.createShopManagerClient, port: 8086 },
    { name: 'image', create: image_1.createImageClient, port: 8087 },
    { name: 'event-receiver', create: event_receiver_1.createEventReceiverClient, port: 8088 },
    { name: 'vehicle-fitment', create: vehicle_fitment_1.createVehicleFitmentClient, port: 8089 },
    { name: 'vehicle-inventory', create: vehicle_inventory_1.createVehicleInventoryClient, port: 8090 },
];
// ---------------------------------------------------------------------------
// Tests — one describe per factory × 3 normalizeRequestUrl branch variants
// ---------------------------------------------------------------------------
describe('normalizeRequestUrl: URL and Request object branches in Phase 2 factories', () => {
    let fetchMock;
    let savedFetch;
    beforeAll(() => {
        savedFetch = globalThis.fetch;
    });
    afterAll(() => {
        globalThis.fetch = savedFetch;
    });
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.clearAllMocks();
    });
    for (const { name, create, port } of FACTORIES) {
        const BASE = `http://localhost:${port}`;
        describe(`sdk-${name}: normalizeRequestUrl`, () => {
            it(`passes a URL object to fetchApi — covers url instanceof URL branch`, () => __awaiter(void 0, void 0, void 0, function* () {
                const client = create({ baseUrl: BASE });
                const fetchApi = getFirstFetchApi(client);
                expect(fetchApi).toBeDefined();
                yield fetchApi(new URL(`${BASE}/api/test`), { method: 'GET' });
                expect(fetchMock).toHaveBeenCalledTimes(1);
            }));
            it(`passes a Request object to fetchApi — covers url instanceof Request branch`, () => __awaiter(void 0, void 0, void 0, function* () {
                const client = create({ baseUrl: BASE });
                const fetchApi = getFirstFetchApi(client);
                expect(fetchApi).toBeDefined();
                yield fetchApi(new Request(`${BASE}/api/test`, { method: 'GET' }), { method: 'GET' });
                expect(fetchMock).toHaveBeenCalledTimes(1);
            }));
            it(`passes an exotic object to fetchApi — covers String(url) fallback branch`, () => __awaiter(void 0, void 0, void 0, function* () {
                const client = create({ baseUrl: BASE });
                const fetchApi = getFirstFetchApi(client);
                expect(fetchApi).toBeDefined();
                // An object that is neither string, URL, nor Request reaches the final
                // `return String(url)` line in normalizeRequestUrl.
                const exotic = { toString: () => `${BASE}/api/test` };
                yield fetchApi(exotic, { method: 'GET' });
                expect(fetchMock).toHaveBeenCalledTimes(1);
            }));
        });
    }
});
