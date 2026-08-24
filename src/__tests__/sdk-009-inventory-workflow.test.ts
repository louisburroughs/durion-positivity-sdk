/**
 * SDK-009 Inventory Procure-To-Receive Workflow Tests — GREEN phase.
 *
 * Tests verify the InventoryProcureToReceiveWorkflow class at:
 *   packages/sdk-inventory/src/workflows/inventoryProcureToReceiveWorkflow.ts
 * exported from packages/sdk-inventory/src/index.ts.
 *
 * Test categories
 * ---------------
 * 1. Structural tests  — verify the workflow source file exists on disk.
 *
 * 2. Export tests      — verify InventoryProcureToReceiveWorkflow is
 *    re-exported from packages/sdk-inventory/src/index.ts.
 *
 * 3. Behavioral tests  — verify each workflow method delegates correctly to
 *    the underlying generated API instance (constructor injection).
 *
 * Issue: SDK-009
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Workflow class import — exported from packages/sdk-inventory/src/index.ts.
// ---------------------------------------------------------------------------
import { InventoryProcureToReceiveWorkflow } from '@durion-sdk/inventory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Root of the monorepo — src/__tests__ is two directories below the root. */
const REPO_ROOT = path.resolve(__dirname, '../..');

function workflowFilePath(...segments: string[]): string {
  return path.join(REPO_ROOT, 'packages', ...segments);
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// Mock API instances — shared across behavioral describe blocks
// ---------------------------------------------------------------------------

const mockAsnApi = {
  createAsn: jest.fn(),
  getAsn: jest.fn(),
} as any;

const mockReceivingApi = {
  createReceivingSession: jest.fn(),
  receiveItemsIntoStaging: jest.fn(),
  getReceivingSession: jest.fn(),
} as any;

const mockAvailabilityApi = {
  getAvailabilityByProduct: jest.fn(),
  getAvailabilityBySku: jest.fn(),
} as any;

// ===========================================================================
// 1. STRUCTURAL TESTS — file-system existence check
//    Fails RED because the workflow file is absent.
// ===========================================================================

describe('SDK-009 Structural: workflow source file exists', () => {
  it('packages/sdk-inventory/src/workflows/inventoryProcureToReceiveWorkflow.ts exists', () => {
    const target = workflowFilePath(
      'sdk-inventory',
      'src',
      'workflows',
      'inventoryProcureToReceiveWorkflow.ts',
    );
    expect(fs.existsSync(target)).toBe(true);
  });
});

// ===========================================================================
// 2. EXPORT TESTS — package index.ts must re-export the workflow class
//    Fails RED because the class name is absent from the index.
// ===========================================================================

describe('SDK-009 Exports: InventoryProcureToReceiveWorkflow is exported from package index', () => {
  it('packages/sdk-inventory/src/index.ts exports InventoryProcureToReceiveWorkflow', () => {
    const indexPath = workflowFilePath('sdk-inventory', 'src', 'index.ts');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = readText(indexPath);
    expect(content).toContain('InventoryProcureToReceiveWorkflow');
  });
});

// ===========================================================================
// 3. BEHAVIORAL TESTS — delegation to generated API instances
//
//    Constructor: new InventoryProcureToReceiveWorkflow(
//      asnApi, receivingApi, availabilityApi
//    )
//
//    Purchase orders are not in this list: pos-inventory's contract no longer
//    declares /v1/inventory/purchase-orders, so creating and approving a PO is
//    `createOrderClient(...).purchaseOrdersApi`, not this workflow.
//
//    In RED phase the imported class is `undefined`, so `new ClassX()`
//    throws: TypeError: InventoryProcureToReceiveWorkflow is not a constructor
// ===========================================================================

describe('SDK-009 Behavior: InventoryProcureToReceiveWorkflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAsnApi.createAsn.mockResolvedValue({ asnId: 'asn-1' });
    mockReceivingApi.createReceivingSession.mockResolvedValue({ sessionId: 'sess-1' });
    mockReceivingApi.receiveItemsIntoStaging.mockResolvedValue({ received: true });
    mockAvailabilityApi.getAvailabilityByProduct.mockResolvedValue({ available: 10 });
  });

  it('when_registerAsn_then_delegates_to_asnApi_createAsn', async () => {
    // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
    const workflow = new (InventoryProcureToReceiveWorkflow as any)(
      mockAsnApi,
      mockReceivingApi,
      mockAvailabilityApi,
    );
    const params = { createAsnRequest: { purchaseOrderId: 'po-1', expectedDate: '2026-04-01' } };

    const result = await workflow.registerAsn(params);

    expect(mockAsnApi.createAsn).toHaveBeenCalledTimes(1);
    expect(mockAsnApi.createAsn).toHaveBeenCalledWith(expect.objectContaining(params));
    expect(result).toBeDefined();
  });

  it('when_startReceivingSession_then_delegates_to_receivingApi_createReceivingSession', async () => {
    // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
    const workflow = new (InventoryProcureToReceiveWorkflow as any)(
      mockAsnApi,
      mockReceivingApi,
      mockAvailabilityApi,
    );
    const params = { createReceivingSessionRequest: { purchaseOrderId: 'po-1', dockId: 'dock-1' } };

    const result = await workflow.startReceivingSession(params);

    expect(mockReceivingApi.createReceivingSession).toHaveBeenCalledTimes(1);
    expect(mockReceivingApi.createReceivingSession).toHaveBeenCalledWith(
      expect.objectContaining(params),
    );
    expect(result).toBeDefined();
  });

  it('when_receiveItems_then_delegates_to_receivingApi_receiveItemsIntoStaging', async () => {
    // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
    const workflow = new (InventoryProcureToReceiveWorkflow as any)(
      mockAsnApi,
      mockReceivingApi,
      mockAvailabilityApi,
    );
    const params = { receiveItemsRequest: { sessionId: 'sess-1', items: [{ sku: 'SKU-42', qty: 10 }] } };

    const result = await workflow.receiveItems(params);

    expect(mockReceivingApi.receiveItemsIntoStaging).toHaveBeenCalledTimes(1);
    expect(mockReceivingApi.receiveItemsIntoStaging).toHaveBeenCalledWith(
      expect.objectContaining(params),
    );
    expect(result).toBeDefined();
  });

  it('when_checkAvailability_then_delegates_to_availabilityApi_getAvailabilityByProduct', async () => {
    // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
    const workflow = new (InventoryProcureToReceiveWorkflow as any)(
      mockAsnApi,
      mockReceivingApi,
      mockAvailabilityApi,
    );
    const params = { queryInventoryAvailabilityRequest: { locationId: 'loc-1', skus: ['SKU-42'] } };

    const result = await workflow.checkAvailability(params);

    expect(mockAvailabilityApi.getAvailabilityByProduct).toHaveBeenCalledTimes(1);
    expect(mockAvailabilityApi.getAvailabilityByProduct).toHaveBeenCalledWith(
      expect.objectContaining(params),
    );
    expect(result).toBeDefined();
  });
});
