"use strict";
/**
 * SDK-008 Workflow Helper Tests — GREEN phase.
 *
 * Tests verify the implemented workflow helper classes. The workflow classes
 * are exported from their respective package index files and delegate to the
 * underlying generated API classes.
 *
 * Test categories
 * ---------------
 * 1. Structural tests  — verify workflow source files exist on disk.
 *
 * 2. Export tests      — verify each workflow class is re-exported from its
 *    package index.ts.
 *
 * 3. Behavioral tests  — verify each workflow method delegates correctly to
 *    the underlying generated API class (constructor injection).
 *    Each test exercises delegation with jest.fn() mocks.
 *
 * Issue: SDK-008
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
// Workflow class imports — exported from each package index file.
// ---------------------------------------------------------------------------
const order_1 = require("@durion-sdk/order");
const workorder_1 = require("@durion-sdk/workorder");
const accounting_1 = require("@durion-sdk/accounting");
const security_1 = require("@durion-sdk/security");
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
// ===========================================================================
// 1. STRUCTURAL TESTS — file-system existence checks
//    Each test fails RED because its workflow file is absent.
// ===========================================================================
describe('SDK-008 Structural: workflow source files exist', () => {
    it('packages/sdk-order/src/workflows/orderPriceOverrideWorkflow.ts exists', () => {
        const target = workflowFilePath('sdk-order', 'src', 'workflows', 'orderPriceOverrideWorkflow.ts');
        expect(fs.existsSync(target)).toBe(true);
    });
    it('packages/sdk-workorder/src/workflows/workorderEstimateWorkflow.ts exists', () => {
        const target = workflowFilePath('sdk-workorder', 'src', 'workflows', 'workorderEstimateWorkflow.ts');
        expect(fs.existsSync(target)).toBe(true);
    });
    it('packages/sdk-workorder/src/workflows/workorderChangeRequestWorkflow.ts exists', () => {
        const target = workflowFilePath('sdk-workorder', 'src', 'workflows', 'workorderChangeRequestWorkflow.ts');
        expect(fs.existsSync(target)).toBe(true);
    });
    it('packages/sdk-accounting/src/workflows/accountingEventWorkflow.ts exists', () => {
        const target = workflowFilePath('sdk-accounting', 'src', 'workflows', 'accountingEventWorkflow.ts');
        expect(fs.existsSync(target)).toBe(true);
    });
    it('packages/sdk-security/src/workflows/securityAuthWorkflow.ts exists', () => {
        const target = workflowFilePath('sdk-security', 'src', 'workflows', 'securityAuthWorkflow.ts');
        expect(fs.existsSync(target)).toBe(true);
    });
});
// ===========================================================================
// 2. EXPORT TESTS — package index.ts must re-export each workflow class
//    Each test fails RED because the class name is absent from the index.
// ===========================================================================
describe('SDK-008 Exports: workflow classes are exported from package index', () => {
    it('packages/sdk-order/src/index.ts exports OrderPriceOverrideWorkflow', () => {
        const indexPath = workflowFilePath('sdk-order', 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        expect(content).toContain('OrderPriceOverrideWorkflow');
    });
    it('packages/sdk-workorder/src/index.ts exports WorkorderEstimateWorkflow', () => {
        const indexPath = workflowFilePath('sdk-workorder', 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        expect(content).toContain('WorkorderEstimateWorkflow');
    });
    it('packages/sdk-workorder/src/index.ts exports WorkorderChangeRequestWorkflow', () => {
        const indexPath = workflowFilePath('sdk-workorder', 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        expect(content).toContain('WorkorderChangeRequestWorkflow');
    });
    it('packages/sdk-accounting/src/index.ts exports AccountingEventWorkflow', () => {
        const indexPath = workflowFilePath('sdk-accounting', 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        expect(content).toContain('AccountingEventWorkflow');
    });
    it('packages/sdk-security/src/index.ts exports SecurityAuthWorkflow', () => {
        const indexPath = workflowFilePath('sdk-security', 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        expect(content).toContain('SecurityAuthWorkflow');
    });
});
// ===========================================================================
// 3. BEHAVIORAL TESTS — delegation to generated API classes
//
//    Constructor injection: each workflow receives pre-constructed API mocks.
//    In RED phase the imported class names are `undefined`, so `new ClassX()`
//    throws: TypeError: ClassX is not a constructor.
// ===========================================================================
// ---------------------------------------------------------------------------
// 3a. OrderPriceOverrideWorkflow — delegates to PriceOverridesApi
// ---------------------------------------------------------------------------
describe('SDK-008 Behavior: OrderPriceOverrideWorkflow', () => {
    const mockPriceOverridesApi = {
        applyPriceOverride: jest.fn(),
        approvePriceOverride: jest.fn(),
        rejectPriceOverride: jest.fn(),
        getPendingApprovals: jest.fn(),
        getOverride: jest.fn(),
        getOverridesByOrder: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        mockPriceOverridesApi.applyPriceOverride.mockResolvedValue({});
        mockPriceOverridesApi.approvePriceOverride.mockResolvedValue({});
        mockPriceOverridesApi.rejectPriceOverride.mockResolvedValue({});
        mockPriceOverridesApi.getPendingApprovals.mockResolvedValue([]);
    });
    it('when_submit_then_delegates_to_priceOverridesApi_applyPriceOverride', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: OrderPriceOverrideWorkflow is not a constructor (undefined)
        const workflow = new order_1.OrderPriceOverrideWorkflow(mockPriceOverridesApi);
        const params = { applyPriceOverrideRequest: { orderId: 'ord-1', amount: 100 } };
        const result = yield workflow.submit(params);
        expect(mockPriceOverridesApi.applyPriceOverride).toHaveBeenCalledTimes(1);
        expect(mockPriceOverridesApi.applyPriceOverride).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_approve_then_delegates_to_priceOverridesApi_approvePriceOverride', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: OrderPriceOverrideWorkflow is not a constructor (undefined)
        const workflow = new order_1.OrderPriceOverrideWorkflow(mockPriceOverridesApi);
        const params = { overrideId: 'ov-1', approvePriceOverrideRequest: { reason: 'ok' } };
        const result = yield workflow.approve(params);
        expect(mockPriceOverridesApi.approvePriceOverride).toHaveBeenCalledTimes(1);
        expect(mockPriceOverridesApi.approvePriceOverride).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_reject_then_delegates_to_priceOverridesApi_rejectPriceOverride', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: OrderPriceOverrideWorkflow is not a constructor (undefined)
        const workflow = new order_1.OrderPriceOverrideWorkflow(mockPriceOverridesApi);
        const params = { overrideId: 'ov-1', rejectPriceOverrideRequest: { reason: 'denied' } };
        const result = yield workflow.reject(params);
        expect(mockPriceOverridesApi.rejectPriceOverride).toHaveBeenCalledTimes(1);
        expect(mockPriceOverridesApi.rejectPriceOverride).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_getPending_then_delegates_to_priceOverridesApi_getPendingApprovals', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: OrderPriceOverrideWorkflow is not a constructor (undefined)
        const workflow = new order_1.OrderPriceOverrideWorkflow(mockPriceOverridesApi);
        const result = yield workflow.getPending();
        expect(mockPriceOverridesApi.getPendingApprovals).toHaveBeenCalledTimes(1);
        expect(result).toBeDefined();
    }));
});
// ---------------------------------------------------------------------------
// 3b. WorkorderEstimateWorkflow — delegates to EstimateAPIApi
// ---------------------------------------------------------------------------
describe('SDK-008 Behavior: WorkorderEstimateWorkflow', () => {
    const mockEstimateApi = {
        createEstimate: jest.fn(),
        approveEstimate: jest.fn(),
        declineEstimate: jest.fn(),
        submitForApproval: jest.fn(),
        promoteEstimateToWorkorder: jest.fn(),
        getEstimateById: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        mockEstimateApi.createEstimate.mockResolvedValue({});
        mockEstimateApi.approveEstimate.mockResolvedValue({});
        mockEstimateApi.declineEstimate.mockResolvedValue({});
        mockEstimateApi.submitForApproval.mockResolvedValue({});
        mockEstimateApi.promoteEstimateToWorkorder.mockResolvedValue({});
    });
    it('when_create_then_delegates_to_estimateApi_createEstimate', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderEstimateWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderEstimateWorkflow(mockEstimateApi);
        const params = { createEstimateRequest: { locationId: 'loc-1' } };
        const result = yield workflow.create(params);
        expect(mockEstimateApi.createEstimate).toHaveBeenCalledTimes(1);
        expect(mockEstimateApi.createEstimate).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_submitForApproval_then_delegates_to_estimateApi_submitForApproval', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderEstimateWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderEstimateWorkflow(mockEstimateApi);
        const params = { estimateId: 'est-1' };
        const result = yield workflow.submitForApproval(params);
        expect(mockEstimateApi.submitForApproval).toHaveBeenCalledTimes(1);
        expect(mockEstimateApi.submitForApproval).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_approve_then_delegates_to_estimateApi_approveEstimate', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderEstimateWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderEstimateWorkflow(mockEstimateApi);
        const params = { estimateId: 'est-1', approveEstimateRequest: { approvedBy: 'user-1' } };
        const result = yield workflow.approve(params);
        expect(mockEstimateApi.approveEstimate).toHaveBeenCalledTimes(1);
        expect(mockEstimateApi.approveEstimate).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_decline_then_delegates_to_estimateApi_declineEstimate', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderEstimateWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderEstimateWorkflow(mockEstimateApi);
        const params = { estimateId: 'est-1', declineEstimateRequest: { reason: 'price too high' } };
        const result = yield workflow.decline(params);
        expect(mockEstimateApi.declineEstimate).toHaveBeenCalledTimes(1);
        expect(mockEstimateApi.declineEstimate).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_promoteToWorkorder_then_delegates_to_estimateApi_promoteEstimateToWorkorder', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderEstimateWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderEstimateWorkflow(mockEstimateApi);
        const params = { estimateId: 'est-1', promoteEstimateToWorkorderRequest: {} };
        const result = yield workflow.promoteToWorkorder(params);
        expect(mockEstimateApi.promoteEstimateToWorkorder).toHaveBeenCalledTimes(1);
        expect(mockEstimateApi.promoteEstimateToWorkorder).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
});
// ---------------------------------------------------------------------------
// 3c. WorkorderChangeRequestWorkflow — delegates to ChangeRequestAPIApi
// ---------------------------------------------------------------------------
describe('SDK-008 Behavior: WorkorderChangeRequestWorkflow', () => {
    const mockChangeRequestApi = {
        createChangeRequest: jest.fn(),
        approveChangeRequest: jest.fn(),
        declineChangeRequest: jest.fn(),
        getChangeRequestById: jest.fn(),
        getChangeRequestsByWorkorder: jest.fn(),
        applyEmergencyOverride: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        mockChangeRequestApi.createChangeRequest.mockResolvedValue({});
        mockChangeRequestApi.approveChangeRequest.mockResolvedValue({});
        mockChangeRequestApi.declineChangeRequest.mockResolvedValue({});
    });
    it('when_submit_then_delegates_to_changeRequestApi_createChangeRequest', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderChangeRequestWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderChangeRequestWorkflow(mockChangeRequestApi);
        const params = { createChangeRequestRequest: { workorderId: 'wo-1', description: 'add brake pads' } };
        const result = yield workflow.submit(params);
        expect(mockChangeRequestApi.createChangeRequest).toHaveBeenCalledTimes(1);
        expect(mockChangeRequestApi.createChangeRequest).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_approve_then_delegates_to_changeRequestApi_approveChangeRequest', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderChangeRequestWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderChangeRequestWorkflow(mockChangeRequestApi);
        const params = { changeRequestId: 'cr-1', approveChangeRequestRequest: { approvedBy: 'user-1' } };
        const result = yield workflow.approve(params);
        expect(mockChangeRequestApi.approveChangeRequest).toHaveBeenCalledTimes(1);
        expect(mockChangeRequestApi.approveChangeRequest).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_decline_then_delegates_to_changeRequestApi_declineChangeRequest', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: WorkorderChangeRequestWorkflow is not a constructor (undefined)
        const workflow = new workorder_1.WorkorderChangeRequestWorkflow(mockChangeRequestApi);
        const params = { changeRequestId: 'cr-1', declineChangeRequestRequest: { reason: 'out of scope' } };
        const result = yield workflow.decline(params);
        expect(mockChangeRequestApi.declineChangeRequest).toHaveBeenCalledTimes(1);
        expect(mockChangeRequestApi.declineChangeRequest).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
});
// ---------------------------------------------------------------------------
// 3d. AccountingEventWorkflow — delegates to AccountingEventsApi
// ---------------------------------------------------------------------------
describe('SDK-008 Behavior: AccountingEventWorkflow', () => {
    const mockAccountingEventsApi = {
        retryEventProcessing: jest.fn(),
        reprocessSuspendedEvent: jest.fn(),
        getEvent: jest.fn(),
        listEvents: jest.fn(),
        submitEvent: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        mockAccountingEventsApi.retryEventProcessing.mockResolvedValue({});
        mockAccountingEventsApi.reprocessSuspendedEvent.mockResolvedValue({});
        mockAccountingEventsApi.submitEvent.mockResolvedValue({});
    });
    it('when_retry_then_delegates_to_accountingEventsApi_retryEventProcessing', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: AccountingEventWorkflow is not a constructor (undefined)
        const workflow = new accounting_1.AccountingEventWorkflow(mockAccountingEventsApi);
        const params = { eventId: 'evt-1' };
        const result = yield workflow.retry(params);
        expect(mockAccountingEventsApi.retryEventProcessing).toHaveBeenCalledTimes(1);
        expect(mockAccountingEventsApi.retryEventProcessing).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_reprocess_then_delegates_to_accountingEventsApi_reprocessSuspendedEvent', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: AccountingEventWorkflow is not a constructor (undefined)
        const workflow = new accounting_1.AccountingEventWorkflow(mockAccountingEventsApi);
        const params = { eventId: 'evt-1' };
        const result = yield workflow.reprocess(params);
        expect(mockAccountingEventsApi.reprocessSuspendedEvent).toHaveBeenCalledTimes(1);
        expect(mockAccountingEventsApi.reprocessSuspendedEvent).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
    it('when_submit_then_delegates_to_accountingEventsApi_submitEvent', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: AccountingEventWorkflow is not a constructor (undefined)
        const workflow = new accounting_1.AccountingEventWorkflow(mockAccountingEventsApi);
        const params = { submitEventRequest: { eventType: 'INVOICE_CREATED', payload: {} } };
        const result = yield workflow.submit(params);
        expect(mockAccountingEventsApi.submitEvent).toHaveBeenCalledTimes(1);
        expect(mockAccountingEventsApi.submitEvent).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toBeDefined();
    }));
});
// ---------------------------------------------------------------------------
// 3e. SecurityAuthWorkflow — delegates to AuthAPIApi + JWTAPIApi
// ---------------------------------------------------------------------------
describe('SDK-008 Behavior: SecurityAuthWorkflow', () => {
    const mockAuthApi = {
        login: jest.fn(),
        selfRegister: jest.fn(),
    };
    const mockJwtApi = {
        refreshAccessToken: jest.fn(),
        revokeToken: jest.fn(),
        validateToken: jest.fn(),
    };
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuthApi.login.mockResolvedValue({ accessToken: 'token-abc', refreshToken: 'refresh-xyz' });
        mockJwtApi.refreshAccessToken.mockResolvedValue({ accessToken: 'new-token', refreshToken: 'new-refresh' });
        mockJwtApi.revokeToken.mockResolvedValue(undefined);
        mockJwtApi.validateToken.mockResolvedValue({ valid: true });
    });
    it('when_login_then_delegates_to_authApi_login_and_returns_result', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: SecurityAuthWorkflow is not a constructor (undefined)
        const workflow = new security_1.SecurityAuthWorkflow(mockAuthApi, mockJwtApi);
        const params = { loginRequest: { username: 'user@example.com', password: 'secret' } };
        const result = yield workflow.login(params);
        expect(mockAuthApi.login).toHaveBeenCalledTimes(1);
        expect(mockAuthApi.login).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toEqual({ accessToken: 'token-abc', refreshToken: 'refresh-xyz' });
    }));
    it('when_refresh_then_delegates_to_jwtApi_refreshAccessToken_and_returns_result', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: SecurityAuthWorkflow is not a constructor (undefined)
        const workflow = new security_1.SecurityAuthWorkflow(mockAuthApi, mockJwtApi);
        const params = { refreshTokenRequest: { refreshToken: 'refresh-xyz' } };
        const result = yield workflow.refresh(params);
        expect(mockJwtApi.refreshAccessToken).toHaveBeenCalledTimes(1);
        expect(mockJwtApi.refreshAccessToken).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toEqual({ accessToken: 'new-token', refreshToken: 'new-refresh' });
    }));
    it('when_validate_then_delegates_to_jwtApi_validateToken_and_returns_result', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: SecurityAuthWorkflow is not a constructor (undefined)
        const workflow = new security_1.SecurityAuthWorkflow(mockAuthApi, mockJwtApi);
        const params = { token: 'token-abc' };
        const result = yield workflow.validate(params);
        expect(mockJwtApi.validateToken).toHaveBeenCalledTimes(1);
        expect(mockJwtApi.validateToken).toHaveBeenCalledWith(expect.objectContaining(params));
        expect(result).toEqual({ valid: true });
    }));
    it('when_revoke_then_delegates_to_jwtApi_revokeToken', () => __awaiter(void 0, void 0, void 0, function* () {
        // Fails RED: SecurityAuthWorkflow is not a constructor (undefined)
        const workflow = new security_1.SecurityAuthWorkflow(mockAuthApi, mockJwtApi);
        const params = { token: 'token-abc' };
        yield workflow.revoke(params);
        expect(mockJwtApi.revokeToken).toHaveBeenCalledTimes(1);
        expect(mockJwtApi.revokeToken).toHaveBeenCalledWith(expect.objectContaining(params));
    }));
});
