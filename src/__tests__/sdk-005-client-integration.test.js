"use strict";
/**
 * SDK-005 Phase 2 Generated Client Integration — factory call coverage tests.
 *
 * Verifies that each of the 11 Phase 2 generated client packages exposes a
 * working factory function that:
 *   - returns a non-null client object (AC-1)
 *   - exposes all required API namespace properties (AC-2)
 *   - accepts optional token + apiVersion config (AC-3)
 *   - executes the inline fetchApi callback in both ?? branches (AC-4)
 *
 * No server is required. All factories construct configuration objects and
 * instantiate API classes from the generated code; they make no outbound
 * HTTP calls in isolation.
 *
 * Issue: SDK-005
 */
Object.defineProperty(exports, "__esModule", { value: true });
// ---------------------------------------------------------------------------
// Global fetch mock — prevents real network calls from any constructor or
// callback invoked during these tests.
// ---------------------------------------------------------------------------
global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
    headers: new Headers(),
});
// ---------------------------------------------------------------------------
// Phase 2 module / factory mapping
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const catalog_1 = require("@durion-sdk/catalog");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const customer_1 = require("@durion-sdk/customer");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const invoice_1 = require("@durion-sdk/invoice");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const location_1 = require("@durion-sdk/location");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const people_1 = require("@durion-sdk/people");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const price_1 = require("@durion-sdk/price");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const shop_manager_1 = require("@durion-sdk/shop-manager");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const image_1 = require("@durion-sdk/image");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const event_receiver_1 = require("@durion-sdk/event-receiver");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const vehicle_fitment_1 = require("@durion-sdk/vehicle-fitment");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const vehicle_inventory_1 = require("@durion-sdk/vehicle-inventory");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function minimalConfig(baseUrl) {
    return { baseUrl };
}
function fullConfig(baseUrl) {
    return { baseUrl, token: () => 'test-bearer', apiVersion: '1' };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getFetchApi(client, apiKey) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return client[apiKey]?.configuration?.fetchApi;
}
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-catalog
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-catalog: createCatalogClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, catalog_1.createCatalogClient)(minimalConfig('http://localhost:8080'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, catalog_1.createCatalogClient)(minimalConfig('http://localhost:8080'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.catalogApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.catalogItemsApi).toBeDefined();
        // Spot check additional APIs returned by this factory
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.productsApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.priceBookApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, catalog_1.createCatalogClient)(fullConfig('http://localhost:9090'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-catalog fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-catalog: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A: no ?? fallback)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, catalog_1.createCatalogClient)(fullConfig('http://localhost:8080'));
        const fetchApi = getFetchApi(client, 'catalogApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8080/api/catalog', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B: ?? fallback to GET)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, catalog_1.createCatalogClient)(fullConfig('http://localhost:8080'));
        const fetchApi = getFetchApi(client, 'catalogApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8080/api/catalog', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-customer
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-customer: createCustomerClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, customer_1.createCustomerClient)(minimalConfig('http://localhost:8081'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, customer_1.createCustomerClient)(minimalConfig('http://localhost:8081'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.crmAccountsApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.crmPersonsApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.customerAPIApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, customer_1.createCustomerClient)(fullConfig('http://localhost:9091'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-customer fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-customer: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, customer_1.createCustomerClient)(fullConfig('http://localhost:8081'));
        const fetchApi = getFetchApi(client, 'crmAccountsApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8081/api/customers', { method: 'POST' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, customer_1.createCustomerClient)(fullConfig('http://localhost:8081'));
        const fetchApi = getFetchApi(client, 'crmAccountsApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8081/api/customers', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-invoice
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-invoice: createInvoiceClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, invoice_1.createInvoiceClient)(minimalConfig('http://localhost:8082'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, invoice_1.createInvoiceClient)(minimalConfig('http://localhost:8082'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.billingRulesApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.invoiceApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, invoice_1.createInvoiceClient)(fullConfig('http://localhost:9092'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-invoice fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-invoice: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, invoice_1.createInvoiceClient)(fullConfig('http://localhost:8082'));
        const fetchApi = getFetchApi(client, 'invoiceApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8082/api/invoice', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, invoice_1.createInvoiceClient)(fullConfig('http://localhost:8082'));
        const fetchApi = getFetchApi(client, 'invoiceApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8082/api/invoice', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-location
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-location: createLocationClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, location_1.createLocationClient)(minimalConfig('http://localhost:8083'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, location_1.createLocationClient)(minimalConfig('http://localhost:8083'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.bayApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.locationApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.mobileUnitApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.serviceAreaApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, location_1.createLocationClient)(fullConfig('http://localhost:9093'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-location fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-location: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, location_1.createLocationClient)(fullConfig('http://localhost:8083'));
        const fetchApi = getFetchApi(client, 'locationApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8083/api/locations', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, location_1.createLocationClient)(fullConfig('http://localhost:8083'));
        const fetchApi = getFetchApi(client, 'locationApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8083/api/locations', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-people
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-people: createPeopleClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, people_1.createPeopleClient)(minimalConfig('http://localhost:8084'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, people_1.createPeopleClient)(minimalConfig('http://localhost:8084'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.employeeApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.peopleApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, people_1.createPeopleClient)(fullConfig('http://localhost:9094'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-people fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-people: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, people_1.createPeopleClient)(fullConfig('http://localhost:8084'));
        const fetchApi = getFetchApi(client, 'employeeApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8084/api/employees', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, people_1.createPeopleClient)(fullConfig('http://localhost:8084'));
        const fetchApi = getFetchApi(client, 'employeeApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8084/api/employees', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-price
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-price: createPriceClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, price_1.createPriceClient)(minimalConfig('http://localhost:8085'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, price_1.createPriceClient)(minimalConfig('http://localhost:8085'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.priceQuotesApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.priceRestrictionsApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, price_1.createPriceClient)(fullConfig('http://localhost:9095'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-price fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-price: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, price_1.createPriceClient)(fullConfig('http://localhost:8085'));
        const fetchApi = getFetchApi(client, 'priceQuotesApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8085/api/prices', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, price_1.createPriceClient)(fullConfig('http://localhost:8085'));
        const fetchApi = getFetchApi(client, 'priceQuotesApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8085/api/prices', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-shop-manager
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-shop-manager: createShopManagerClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, shop_manager_1.createShopManagerClient)(minimalConfig('http://localhost:8086'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, shop_manager_1.createShopManagerClient)(minimalConfig('http://localhost:8086'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.appointmentsApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.shopApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, shop_manager_1.createShopManagerClient)(fullConfig('http://localhost:9096'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-shop-manager fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-shop-manager: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, shop_manager_1.createShopManagerClient)(fullConfig('http://localhost:8086'));
        const fetchApi = getFetchApi(client, 'appointmentsApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8086/api/appointments', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, shop_manager_1.createShopManagerClient)(fullConfig('http://localhost:8086'));
        const fetchApi = getFetchApi(client, 'appointmentsApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8086/api/appointments', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-image
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-image: createImageClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, image_1.createImageClient)(minimalConfig('http://localhost:8087'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, image_1.createImageClient)(minimalConfig('http://localhost:8087'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.imageApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, image_1.createImageClient)(fullConfig('http://localhost:9097'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-image fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-image: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, image_1.createImageClient)(fullConfig('http://localhost:8087'));
        const fetchApi = getFetchApi(client, 'imageApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8087/api/images', { method: 'POST' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, image_1.createImageClient)(fullConfig('http://localhost:8087'));
        const fetchApi = getFetchApi(client, 'imageApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8087/api/images', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-event-receiver
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-event-receiver: createEventReceiverClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, event_receiver_1.createEventReceiverClient)(minimalConfig('http://localhost:8088'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, event_receiver_1.createEventReceiverClient)(minimalConfig('http://localhost:8088'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.eventEmissionApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.eventTypesApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, event_receiver_1.createEventReceiverClient)(fullConfig('http://localhost:9098'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-event-receiver fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-event-receiver: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, event_receiver_1.createEventReceiverClient)(fullConfig('http://localhost:8088'));
        const fetchApi = getFetchApi(client, 'eventEmissionApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8088/api/events', { method: 'POST' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, event_receiver_1.createEventReceiverClient)(fullConfig('http://localhost:8088'));
        const fetchApi = getFetchApi(client, 'eventEmissionApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8088/api/events', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-vehicle-fitment
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-vehicle-fitment: createVehicleFitmentClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, vehicle_fitment_1.createVehicleFitmentClient)(minimalConfig('http://localhost:8089'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, vehicle_fitment_1.createVehicleFitmentClient)(minimalConfig('http://localhost:8089'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.vehicleFitmentApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, vehicle_fitment_1.createVehicleFitmentClient)(fullConfig('http://localhost:9099'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-vehicle-fitment fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-vehicle-fitment: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, vehicle_fitment_1.createVehicleFitmentClient)(fullConfig('http://localhost:8089'));
        const fetchApi = getFetchApi(client, 'vehicleFitmentApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8089/api/fitment', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, vehicle_fitment_1.createVehicleFitmentClient)(fullConfig('http://localhost:8089'));
        const fetchApi = getFetchApi(client, 'vehicleFitmentApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8089/api/fitment', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-1..AC-3: sdk-vehicle-inventory
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-vehicle-inventory: createVehicleInventoryClient', () => {
    it('AC-1: factory returns a defined non-null object', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, vehicle_inventory_1.createVehicleInventoryClient)(minimalConfig('http://localhost:8090'));
        expect(client).toBeDefined();
        expect(client).not.toBeNull();
    });
    it('AC-2: required API properties are defined', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, vehicle_inventory_1.createVehicleInventoryClient)(minimalConfig('http://localhost:8090'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.vehicleApi).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        expect(client.vehicleRegistryApi).toBeDefined();
    });
    it('AC-3: factory accepts optional token + apiVersion config', () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = (0, vehicle_inventory_1.createVehicleInventoryClient)(fullConfig('http://localhost:9100'));
        expect(client).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-4: sdk-vehicle-inventory fetchApi branch coverage
// ---------------------------------------------------------------------------
describe('SDK-005 sdk-vehicle-inventory: fetchApi callback branches', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('AC-4: fetchApi — explicit method (Branch A)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, vehicle_inventory_1.createVehicleInventoryClient)(fullConfig('http://localhost:8090'));
        const fetchApi = getFetchApi(client, 'vehicleApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8090/api/vehicles', { method: 'GET' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('AC-4: fetchApi — absent method (Branch B)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = (0, vehicle_inventory_1.createVehicleInventoryClient)(fullConfig('http://localhost:8090'));
        const fetchApi = getFetchApi(client, 'vehicleApi');
        expect(fetchApi).toBeDefined();
        await fetchApi('http://localhost:8090/api/vehicles', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
// ---------------------------------------------------------------------------
// AC-5: All 11 Phase 2 factories — consolidated invocations (no-server smoke)
//
// Confirms all factories can be called with only a baseUrl (no token) and
// return structured objects. This surfaces any constructor-level throws.
// ---------------------------------------------------------------------------
describe('SDK-005 AC-5: all 11 Phase 2 factories — minimal-config smoke test', () => {
    it('all factories return a non-null object with minimal config', () => {
        const BASE = 'http://localhost:8080';
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, catalog_1.createCatalogClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, customer_1.createCustomerClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, invoice_1.createInvoiceClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, location_1.createLocationClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, people_1.createPeopleClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, price_1.createPriceClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, shop_manager_1.createShopManagerClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, image_1.createImageClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, event_receiver_1.createEventReceiverClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, vehicle_fitment_1.createVehicleFitmentClient)(minimalConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, vehicle_inventory_1.createVehicleInventoryClient)(minimalConfig(BASE))).toBeDefined();
    });
    it('all factories return a non-null object with full config', () => {
        const BASE = 'http://localhost:9000';
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, catalog_1.createCatalogClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, customer_1.createCustomerClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, invoice_1.createInvoiceClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, location_1.createLocationClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, people_1.createPeopleClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, price_1.createPriceClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, shop_manager_1.createShopManagerClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, image_1.createImageClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, event_receiver_1.createEventReceiverClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, vehicle_fitment_1.createVehicleFitmentClient)(fullConfig(BASE))).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        expect((0, vehicle_inventory_1.createVehicleInventoryClient)(fullConfig(BASE))).toBeDefined();
    });
});
