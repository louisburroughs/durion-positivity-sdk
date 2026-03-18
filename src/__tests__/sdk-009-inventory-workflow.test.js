"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// ---------------------------------------------------------------------------
// Workflow class import — exported from packages/sdk-inventory/src/index.ts.
// ---------------------------------------------------------------------------
const inventory_1 = require("@durion-sdk/inventory");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Root of the monorepo — src/__tests__ is two directories below the root. */
const REPO_ROOT = path.resolve(__dirname, '../..');
function workflowFilePath(...segments) {
    return path.join(REPO_ROOT, 'packages', ...segments);
}
function readText(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}
// ---------------------------------------------------------------------------
// Mock API instances — shared across behavioral describe blocks
// ---------------------------------------------------------------------------
const mockPurchaseOrdersApi = {
    createPurchaseOrder: jest.fn(),
    approvePurchaseOrder: jest.fn(),
    getPurchaseOrder: jest.fn(),
    receivePurchaseOrder: jest.fn(),
};
const mockAsnApi = {
    createAsn: jest.fn(),
    getAsn: jest.fn(),
};
const mockReceivingApi = {
    createReceivingSession: jest.fn(),
    receiveItemsIntoStaging: jest.fn(),
    getReceivingSession: jest.fn(),
};
const mockAvailabilityApi = {
    queryInventoryAvailability: jest.fn(),
    queryAvailabilityBySku: jest.fn(),
};
// ===========================================================================
// 1. STRUCTURAL TESTS — file-system existence check
//    Fails RED because the workflow file is absent.
// ===========================================================================
describe('SDK-009 Structural: workflow source file exists', () => {
    it('packages/sdk-inventory/src/workflows/inventoryProcureToReceiveWorkflow.ts exists', () => {
        const target = workflowFilePath('sdk-inventory', 'src', 'workflows', 'inventoryProcureToReceiveWorkflow.ts');
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
//      purchaseOrdersApi, asnApi, receivingApi, availabilityApi
//    )
//
//    In RED phase the imported class is `undefined`, so `new ClassX()`
//    throws: TypeError: InventoryProcureToReceiveWorkflow is not a constructor
// ===========================================================================
describe('SDK-009 Behavior: InventoryProcureToReceiveWorkflow', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPurchaseOrdersApi.createPurchaseOrder.mockResolvedValue({ purchaseOrderId: 'po-1' });
        mockPurchaseOrdersApi.approvePurchaseOrder.mockResolvedValue({ status: 'APPROVED' });
        mockAsnApi.createAsn.mockResolvedValue({ asnId: 'asn-1' });
        mockReceivingApi.createReceivingSession.mockResolvedValue({ sessionId: 'sess-1' });
        mockReceivingApi.receiveItemsIntoStaging.mockResolvedValue({ received: true });
        mockAvailabilityApi.queryInventoryAvailability.mockResolvedValue({ available: 10 });
    });
    it('when_createPurchaseOrder_then_delegates_to_purchaseOrdersApi_createPurchaseOrder', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
        const workflow = new inventory_1.InventoryProcureToReceiveWorkflow(mockPurchaseOrdersApi, mockAsnApi, mockReceivingApi, mockAvailabilityApi);
        const params = { createPurchaseOrderRequest: { locationId: 'loc-1', supplierId: 'sup-1' } };
        const result = yield workflow.createPurchaseOrder(params);
        expect(mockPurchaseOrdersApi.createPurchaseOrder).toHaveBeenCalledTimes(1);
        expect(mockPurchaseOrdersApi.createPurchaseOrder).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_approvePurchaseOrder_then_delegates_to_purchaseOrdersApi_approvePurchaseOrder', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
        const workflow = new inventory_1.InventoryProcureToReceiveWorkflow(mockPurchaseOrdersApi, mockAsnApi, mockReceivingApi, mockAvailabilityApi);
        const params = { purchaseOrderId: 'po-1', approvePurchaseOrderRequest: { approvedBy: 'mgr-1' } };
        const result = yield workflow.approvePurchaseOrder(params);
        expect(mockPurchaseOrdersApi.approvePurchaseOrder).toHaveBeenCalledTimes(1);
        expect(mockPurchaseOrdersApi.approvePurchaseOrder).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_registerAsn_then_delegates_to_asnApi_createAsn', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
        const workflow = new inventory_1.InventoryProcureToReceiveWorkflow(mockPurchaseOrdersApi, mockAsnApi, mockReceivingApi, mockAvailabilityApi);
        const params = { createAsnRequest: { purchaseOrderId: 'po-1', expectedDate: '2026-04-01' } };
        const result = yield workflow.registerAsn(params);
        expect(mockAsnApi.createAsn).toHaveBeenCalledTimes(1);
        expect(mockAsnApi.createAsn).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_startReceivingSession_then_delegates_to_receivingApi_createReceivingSession', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
        const workflow = new inventory_1.InventoryProcureToReceiveWorkflow(mockPurchaseOrdersApi, mockAsnApi, mockReceivingApi, mockAvailabilityApi);
        const params = { createReceivingSessionRequest: { purchaseOrderId: 'po-1', dockId: 'dock-1' } };
        const result = yield workflow.startReceivingSession(params);
        expect(mockReceivingApi.createReceivingSession).toHaveBeenCalledTimes(1);
        expect(mockReceivingApi.createReceivingSession).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_receiveItems_then_delegates_to_receivingApi_receiveItemsIntoStaging', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
        const workflow = new inventory_1.InventoryProcureToReceiveWorkflow(mockPurchaseOrdersApi, mockAsnApi, mockReceivingApi, mockAvailabilityApi);
        const params = { receiveItemsRequest: { sessionId: 'sess-1', items: [{ sku: 'SKU-42', qty: 10 }] } };
        const result = yield workflow.receiveItems(params);
        expect(mockReceivingApi.receiveItemsIntoStaging).toHaveBeenCalledTimes(1);
        expect(mockReceivingApi.receiveItemsIntoStaging).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_checkAvailability_then_delegates_to_availabilityApi_queryInventoryAvailability', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: InventoryProcureToReceiveWorkflow is not a constructor (undefined)
        const workflow = new inventory_1.InventoryProcureToReceiveWorkflow(mockPurchaseOrdersApi, mockAsnApi, mockReceivingApi, mockAvailabilityApi);
        const params = { queryInventoryAvailabilityRequest: { locationId: 'loc-1', skus: ['SKU-42'] } };
        const result = yield workflow.checkAvailability(params);
        expect(mockAvailabilityApi.queryInventoryAvailability).toHaveBeenCalledTimes(1);
        expect(mockAvailabilityApi.queryInventoryAvailability).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
});
