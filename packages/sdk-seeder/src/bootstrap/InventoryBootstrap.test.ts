import { createInventoryClient } from '@durion-sdk/inventory';
import { createOrderClient, PurchaseOrderResponseStatusEnum } from '@durion-sdk/order';
import type { DurionSdkConfig } from '@durion-sdk/transport';
import { InventoryBootstrap } from './InventoryBootstrap';

jest.mock('@durion-sdk/inventory', () => ({
  ...jest.requireActual('@durion-sdk/inventory'),
  createInventoryClient: jest.fn(),
}));

jest.mock('@durion-sdk/order', () => ({
  ...jest.requireActual('@durion-sdk/order'),
  createOrderClient: jest.fn(),
}));

const PRODUCT_ID = 'product-1';
const PRODUCT_NAME = 'Brake Pad Set';
const LOCATION_ID = 'location-1';
const VIRTUAL_NOW = new Date('2026-03-01T00:00:00.000Z');
const SEED_COMMENT = `sdk-seeder-bootstrap:${PRODUCT_ID}`;

/** An availability read for a SKU that has never had a stock-summary row. */
const notFound = () =>
  Promise.reject(Object.assign(new Error('Not Found'), { response: { status: 404 } }));

function purchaseOrder(status: PurchaseOrderResponseStatusEnum, comment = SEED_COMMENT) {
  return { purchaseOrderId: `po-${status}`, poNumber: `PO-${status}`, status, comment };
}

function mockClients() {
  const asnApi = {
    createAsn: jest.fn().mockResolvedValue({ asnId: 'asn-1' }),
    createGoodsReceipt: jest.fn().mockResolvedValue({}),
  };
  const inventoryAvailabilityApi = { getAvailabilityBySku: jest.fn() };
  const purchaseOrdersApi = {
    createPurchaseOrder: jest
      .fn()
      .mockResolvedValue({ purchaseOrderId: 'po-new', lines: [{ lineId: 'line-1' }] }),
    approvePurchaseOrder: jest.fn().mockResolvedValue({}),
  };

  (createInventoryClient as jest.Mock).mockReturnValue({ asnApi, inventoryAvailabilityApi });
  (createOrderClient as jest.Mock).mockReturnValue({ purchaseOrdersApi });

  return { asnApi, inventoryAvailabilityApi, purchaseOrdersApi };
}

/** Answers the paged purchase order lookup with a single page. */
function mockPurchaseOrderPage(content: unknown[]) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content, totalPages: 1 }),
  }) as unknown as typeof fetch;
}

async function run(bootstrapClients = mockClients()) {
  const sdkConfig = { baseUrl: 'http://inventory' } as DurionSdkConfig;
  const orderSdkConfig = { baseUrl: 'http://order' } as DurionSdkConfig;
  const result = await new InventoryBootstrap(sdkConfig, orderSdkConfig).run(
    [{ id: PRODUCT_ID, name: PRODUCT_NAME }],
    LOCATION_ID,
    VIRTUAL_NOW,
  );
  return { result, ...bootstrapClients };
}

describe('InventoryBootstrap idempotency check', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('re-seeds a product whose only seeded purchase order is CANCELLED', async () => {
    mockPurchaseOrderPage([purchaseOrder(PurchaseOrderResponseStatusEnum.Cancelled)]);
    const clients = mockClients();
    clients.inventoryAvailabilityApi.getAvailabilityBySku.mockImplementation(notFound);

    const { result, purchaseOrdersApi, asnApi } = await run(clients);

    expect(result.created).toEqual([PRODUCT_NAME]);
    expect(result.createdCount).toBe(1);
    expect(purchaseOrdersApi.createPurchaseOrder).toHaveBeenCalledTimes(1);
    expect(purchaseOrdersApi.approvePurchaseOrder).toHaveBeenCalledTimes(1);
    expect(asnApi.createGoodsReceipt).toHaveBeenCalledTimes(1);
  });

  it('skips a product that already has stock on hand', async () => {
    mockPurchaseOrderPage([purchaseOrder(PurchaseOrderResponseStatusEnum.FullyReceived)]);
    const clients = mockClients();
    clients.inventoryAvailabilityApi.getAvailabilityBySku.mockResolvedValue({
      onHandQuantity: 50,
      availableToPromiseQuantity: 50,
      incomingQty: 0,
    });

    const { result, purchaseOrdersApi } = await run(clients);

    expect(result.skipped).toEqual([PRODUCT_NAME]);
    expect(purchaseOrdersApi.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('skips a product whose stock is still incoming on an approved order', async () => {
    // The alpha majority: approved, nothing received yet, so on-hand is zero
    // and only incomingQty says an order is live.
    mockPurchaseOrderPage([purchaseOrder(PurchaseOrderResponseStatusEnum.Approved)]);
    const clients = mockClients();
    clients.inventoryAvailabilityApi.getAvailabilityBySku.mockResolvedValue({
      onHandQuantity: 0,
      availableToPromiseQuantity: 0,
      incomingQty: 75,
    });

    const { result, purchaseOrdersApi } = await run(clients);

    expect(result.skipped).toEqual([PRODUCT_NAME]);
    expect(result.createdCount).toBe(0);
    expect(purchaseOrdersApi.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it('skips with a warning when an unapproved DRAFT order would be left as litter', async () => {
    mockPurchaseOrderPage([purchaseOrder(PurchaseOrderResponseStatusEnum.Draft)]);
    const clients = mockClients();
    clients.inventoryAvailabilityApi.getAvailabilityBySku.mockImplementation(notFound);

    const { result, purchaseOrdersApi } = await run(clients);

    expect(result.skipped).toEqual([PRODUCT_NAME]);
    expect(purchaseOrdersApi.createPurchaseOrder).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DRAFT'));
  });

  it('ignores a seeded order that belongs to another product', async () => {
    mockPurchaseOrderPage([
      purchaseOrder(PurchaseOrderResponseStatusEnum.Draft, 'sdk-seeder-bootstrap:product-2'),
    ]);
    const clients = mockClients();
    clients.inventoryAvailabilityApi.getAvailabilityBySku.mockImplementation(notFound);

    const { result, purchaseOrdersApi } = await run(clients);

    expect(result.created).toEqual([PRODUCT_NAME]);
    expect(purchaseOrdersApi.createPurchaseOrder).toHaveBeenCalledTimes(1);
  });

  describe('when availability cannot be read', () => {
    const unavailable = () =>
      Promise.reject(Object.assign(new Error('Bad Gateway'), { response: { status: 502 } }));

    it('falls back to the order check and skips while a live order exists', async () => {
      mockPurchaseOrderPage([purchaseOrder(PurchaseOrderResponseStatusEnum.Approved)]);
      const clients = mockClients();
      clients.inventoryAvailabilityApi.getAvailabilityBySku.mockImplementation(unavailable);

      const { result, purchaseOrdersApi } = await run(clients);

      expect(result.skipped).toEqual([PRODUCT_NAME]);
      expect(purchaseOrdersApi.createPurchaseOrder).not.toHaveBeenCalled();
    });

    it('falls back to the order check and re-seeds when every order is cancelled', async () => {
      mockPurchaseOrderPage([purchaseOrder(PurchaseOrderResponseStatusEnum.Cancelled)]);
      const clients = mockClients();
      clients.inventoryAvailabilityApi.getAvailabilityBySku.mockImplementation(unavailable);

      const { result, purchaseOrdersApi } = await run(clients);

      expect(result.created).toEqual([PRODUCT_NAME]);
      expect(purchaseOrdersApi.createPurchaseOrder).toHaveBeenCalledTimes(1);
    });
  });
});
