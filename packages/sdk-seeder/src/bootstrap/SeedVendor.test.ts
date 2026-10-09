import type { PurchaseOrdersApi } from '@durion-sdk/order';
import type { SupplierVendorsApi, VendorView } from '@durion-sdk/supplier';
import { createPurchaseOrderOnceVendorReplicated, ensureSeedVendor, SEED_VENDOR_NUMBER } from './SeedVendor';

function responseError(status: number, code: string): Error {
  return Object.assign(new Error('Response returned an error code'), {
    response: new Response(JSON.stringify({ code }), { status }),
  });
}

function vendorsApi(pages: VendorView[][], create?: jest.Mock): SupplierVendorsApi {
  const listSupplierVendors = jest.fn();
  for (const items of pages) {
    listSupplierVendors.mockResolvedValueOnce({ items });
  }
  return {
    listSupplierVendors,
    createSupplierVendor: create ?? jest.fn(),
  } as unknown as SupplierVendorsApi;
}

describe('ensureSeedVendor', () => {
  it('returns the existing seed vendor without creating one', async () => {
    const create = jest.fn();
    const api = vendorsApi(
      [[
        { vendorId: 'other', vendorNumber: `${SEED_VENDOR_NUMBER}-X`, status: 'ACTIVE' as VendorView['status'] },
        { vendorId: 'seed', vendorNumber: SEED_VENDOR_NUMBER, status: 'ACTIVE' as VendorView['status'] },
      ]],
      create,
    );

    await expect(ensureSeedVendor(api)).resolves.toBe('seed');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates the seed vendor under its fixed number when none exists', async () => {
    const create = jest.fn().mockResolvedValue({ vendorId: 'new-seed' });
    const api = vendorsApi([[]], create);

    await expect(ensureSeedVendor(api)).resolves.toBe('new-seed');
    expect(create).toHaveBeenCalledWith({
      vendorCreateRequest: expect.objectContaining({
        vendorNumber: SEED_VENDOR_NUMBER,
        defaultPaymentTerms: 'NET30',
        defaultCurrency: 'USD',
      }),
    });
  });

  it('adopts the vendor a concurrent run created first', async () => {
    const create = jest.fn().mockRejectedValue(responseError(409, 'SUPPLIER_VENDOR_NUMBER_TAKEN'));
    const api = vendorsApi(
      [[], [{ vendorId: 'raced', vendorNumber: SEED_VENDOR_NUMBER, status: 'ACTIVE' as VendorView['status'] }]],
      create,
    );

    await expect(ensureSeedVendor(api)).resolves.toBe('raced');
  });

  it('refuses an inactive seed vendor rather than ordering from it', async () => {
    const api = vendorsApi([[
      { vendorId: 'seed', vendorNumber: SEED_VENDOR_NUMBER, status: 'INACTIVE' as VendorView['status'] },
    ]]);

    await expect(ensureSeedVendor(api)).rejects.toThrow(/INACTIVE/);
  });
});

describe('createPurchaseOrderOnceVendorReplicated', () => {
  const request = { createPurchaseOrderRequest: { vendorId: 'seed' } } as Parameters<
    PurchaseOrdersApi['createPurchaseOrder']
  >[0];

  it('retries while pos-order has not received the vendor yet', async () => {
    const createPurchaseOrder = jest
      .fn()
      .mockRejectedValueOnce(responseError(503, 'VENDOR_REPLICATION_PENDING'))
      .mockResolvedValueOnce({ purchaseOrderId: 'po-1' });
    const api = { createPurchaseOrder } as unknown as PurchaseOrdersApi;

    await expect(createPurchaseOrderOnceVendorReplicated(api, request, { pollMs: 1 })).resolves.toEqual({
      purchaseOrderId: 'po-1',
    });
    expect(createPurchaseOrder).toHaveBeenCalledTimes(2);
  });

  it('rethrows any other failure at once', async () => {
    const createPurchaseOrder = jest.fn().mockRejectedValue(responseError(400, 'VALIDATION_ERROR'));
    const api = { createPurchaseOrder } as unknown as PurchaseOrdersApi;

    await expect(createPurchaseOrderOnceVendorReplicated(api, request, { pollMs: 1 })).rejects.toThrow();
    expect(createPurchaseOrder).toHaveBeenCalledTimes(1);
  });
});
