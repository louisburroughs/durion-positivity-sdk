"use strict";
/**
 * SDK-007 Transport Enhancements — RED phase acceptance tests.
 *
 * Verifies that DurionSdkConfig and SdkHttpClient satisfy the acceptance
 * criteria defined in Story SDK-007:
 *
 *   correlationIdProvider?: () => string
 *     Added to DurionSdkConfig; SdkHttpClient.buildRequestHeaders() and
 *     request() must call it instead of falling back immediately to
 *     crypto.randomUUID().
 *
 *   idempotencyKeyGenerator?: (method: string, url: string) => string
 *     Added to DurionSdkConfig for future per-call idempotency key generation.
 *
 * Structural tests (AC-1 through AC-4) read packages/sdk-transport/src/config.ts
 * and fail RED because neither field is present in the current interface.
 *
 * Behavioral tests (AC-5 and AC-6) instantiate SdkHttpClient with a provider
 * mock and assert that the mock is invoked; they fail RED because
 * buildRequestHeaders() and request() currently call crypto.randomUUID()
 * unconditionally.
 *
 * AC-7 is a regression baseline: it asserts the existing fallback to
 * crypto.randomUUID() and PASSES even in RED phase (documents existing behavior).
 *
 * Issue: SDK-007
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
const http_client_1 = require("../../packages/sdk-transport/src/http-client");
// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const TRANSPORT_SRC = path.join(REPO_ROOT, 'packages', 'sdk-transport', 'src');
const CONFIG_TS_PATH = path.join(TRANSPORT_SRC, 'config.ts');
function readText(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}
// ---------------------------------------------------------------------------
// AC-1 — DurionSdkConfig has a correlationIdProvider field.
//
//         Current config.ts declares only { baseUrl, token?, apiVersion? },
//         so this test fails RED.
// ---------------------------------------------------------------------------
describe('SDK-007 AC-1: DurionSdkConfig has correlationIdProvider field', () => {
    it('packages/sdk-transport/src/config.ts exists', () => {
        expect(fs.existsSync(CONFIG_TS_PATH)).toBe(true);
    });
    it('config.ts DurionSdkConfig contains correlationIdProvider', () => {
        expect(fs.existsSync(CONFIG_TS_PATH)).toBe(true);
        const content = readText(CONFIG_TS_PATH);
        expect(content).toContain('correlationIdProvider');
    });
});
// ---------------------------------------------------------------------------
// AC-2 — DurionSdkConfig has an idempotencyKeyGenerator field.
//
//         Current config.ts does not declare this field, so this test fails RED.
// ---------------------------------------------------------------------------
describe('SDK-007 AC-2: DurionSdkConfig has idempotencyKeyGenerator field', () => {
    it('config.ts DurionSdkConfig contains idempotencyKeyGenerator', () => {
        expect(fs.existsSync(CONFIG_TS_PATH)).toBe(true);
        const content = readText(CONFIG_TS_PATH);
        expect(content).toContain('idempotencyKeyGenerator');
    });
});
// ---------------------------------------------------------------------------
// AC-3 — correlationIdProvider is typed as an optional () => string callback.
//
//         Field is absent, so the regex match fails RED.
// ---------------------------------------------------------------------------
describe('SDK-007 AC-3: correlationIdProvider typed as optional () => string', () => {
    it('config.ts corrrelationIdProvider has type signature "?: () => string"', () => {
        expect(fs.existsSync(CONFIG_TS_PATH)).toBe(true);
        const content = readText(CONFIG_TS_PATH);
        // Matches:  correlationIdProvider?: () => string
        expect(content).toMatch(/correlationIdProvider\?\s*:\s*\(\s*\)\s*=>\s*string/);
    });
});
// ---------------------------------------------------------------------------
// AC-4 — idempotencyKeyGenerator is typed as an optional (method, url) callback.
//
//         Field is absent, so the regex match fails RED.
// ---------------------------------------------------------------------------
describe('SDK-007 AC-4: idempotencyKeyGenerator typed with method and url params', () => {
    it('config.ts idempotencyKeyGenerator signature starts with "?: (method"', () => {
        expect(fs.existsSync(CONFIG_TS_PATH)).toBe(true);
        const content = readText(CONFIG_TS_PATH);
        // Matches:  idempotencyKeyGenerator?: (method...
        expect(content).toMatch(/idempotencyKeyGenerator\?\s*:\s*\(method/);
    });
});
// ---------------------------------------------------------------------------
// AC-5 — SdkHttpClient.buildRequestHeaders() calls correlationIdProvider when
//         one is present in the config.
//
//         Current buildRequestHeaders() calls crypto.randomUUID() directly
//         without consulting config.correlationIdProvider, so:
//           - mockProvider is never called  → toHaveBeenCalledTimes(1) fails RED
//           - X-Correlation-Id is a random UUID, not 'test-correlation-id-123'
//                                           → toBe(...) fails RED
// ---------------------------------------------------------------------------
describe('SDK-007 AC-5: buildRequestHeaders uses correlationIdProvider when present', () => {
    it('calls correlationIdProvider from config and uses its return value as X-Correlation-Id', () => __awaiter(void 0, void 0, void 0, function* () {
        const mockProvider = jest.fn().mockReturnValue('test-correlation-id-123');
        // TypeScript structural typing: the extra correlationIdProvider property is
        // accepted at the call site because it is not a fresh object literal
        // assigned to a typed variable.  At runtime the property is present on the
        // config object but the current implementation does not read it, causing
        // the behavioral assertions below to fail RED.
        const configWithProvider = {
            baseUrl: 'http://localhost:8080',
            correlationIdProvider: mockProvider,
        };
        const client = new http_client_1.SdkHttpClient(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configWithProvider);
        const headers = yield client.buildRequestHeaders('GET');
        // Fails RED: mockProvider is never called by the current implementation.
        expect(mockProvider).toHaveBeenCalledTimes(1);
        // Fails RED: the current implementation uses crypto.randomUUID(), not the provider.
        expect(headers['X-Correlation-Id']).toBe('test-correlation-id-123');
    }));
});
// ---------------------------------------------------------------------------
// AC-6 — SdkHttpClient.request() calls correlationIdProvider when present.
//
//         Current request() hard-codes crypto.randomUUID() for the
//         X-Correlation-Id header passed to fetch, so:
//           - mockProvider is never called  → toHaveBeenCalledTimes(1) fails RED
//           - the fetch header value is a random UUID, not 'test-correlation-id-123'
//                                           → toBe(...) fails RED
// ---------------------------------------------------------------------------
describe('SDK-007 AC-6: request() uses correlationIdProvider when present', () => {
    let mockFetch;
    let savedFetch;
    beforeAll(() => {
        savedFetch = globalThis['fetch'];
    });
    afterAll(() => {
        globalThis['fetch'] = savedFetch;
    });
    beforeEach(() => {
        mockFetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis['fetch'] = mockFetch;
    });
    afterEach(() => {
        jest.clearAllMocks();
    });
    it('calls correlationIdProvider and forwards its value as X-Correlation-Id to fetch', () => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const mockProvider = jest.fn().mockReturnValue('test-correlation-id-123');
        const configWithProvider = {
            baseUrl: 'http://localhost:8080',
            correlationIdProvider: mockProvider,
        };
        const client = new http_client_1.SdkHttpClient(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        configWithProvider);
        yield client.request('GET', '/test');
        // Fails RED: mockProvider is never called by the current implementation.
        expect(mockProvider).toHaveBeenCalledTimes(1);
        const fetchInit = (_a = mockFetch.mock.calls[0]) === null || _a === void 0 ? void 0 : _a[1];
        const fetchHeaders = fetchInit === null || fetchInit === void 0 ? void 0 : fetchInit.headers;
        // Fails RED: the current implementation uses crypto.randomUUID(), not the provider.
        expect(fetchHeaders === null || fetchHeaders === void 0 ? void 0 : fetchHeaders['X-Correlation-Id']).toBe('test-correlation-id-123');
    }));
});
// ---------------------------------------------------------------------------
// AC-7 — SdkHttpClient.buildRequestHeaders() falls back to crypto.randomUUID()
//         when no correlationIdProvider is configured.
//
//         This test PASSES even in RED phase — it documents the existing
//         fallback behavior so it is not accidentally broken during GREEN.
// ---------------------------------------------------------------------------
describe('SDK-007 AC-7: buildRequestHeaders falls back to crypto.randomUUID() when no provider', () => {
    // This test PASSES even RED — it documents existing fallback behavior.
    it('X-Correlation-Id is a valid UUIDv4 when correlationIdProvider is not configured', () => __awaiter(void 0, void 0, void 0, function* () {
        const client = new http_client_1.SdkHttpClient({ baseUrl: 'http://localhost:8080' });
        const headers = yield client.buildRequestHeaders('GET');
        expect(headers['X-Correlation-Id']).toBeDefined();
        // crypto.randomUUID() produces a standard UUIDv4.
        expect(headers['X-Correlation-Id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }));
});
describe('SDK-007 AC-8: buildRequestHeaders uses idempotencyKeyGenerator with normalized method and url', () => {
    it('generates Idempotency-Key for mutating requests using an absolute URL', () => __awaiter(void 0, void 0, void 0, function* () {
        const mockGenerator = jest.fn().mockReturnValue('generated-key-123');
        const client = new http_client_1.SdkHttpClient({
            baseUrl: 'http://localhost:8080',
            idempotencyKeyGenerator: mockGenerator,
        });
        const headers = yield client.buildRequestHeaders('post', { url: '/v1/orders/123?expand=true' });
        expect(mockGenerator).toHaveBeenCalledTimes(1);
        expect(mockGenerator).toHaveBeenCalledWith('POST', 'http://localhost:8080/v1/orders/123?expand=true');
        expect(headers['Idempotency-Key']).toBe('generated-key-123');
    }));
});
describe('SDK-007 AC-9: explicit idempotency keys win over generated keys', () => {
    it('does not call idempotencyKeyGenerator when an explicit key is supplied', () => __awaiter(void 0, void 0, void 0, function* () {
        const mockGenerator = jest.fn().mockReturnValue('generated-key-123');
        const client = new http_client_1.SdkHttpClient({
            baseUrl: 'http://localhost:8080',
            idempotencyKeyGenerator: mockGenerator,
        });
        const headers = yield client.buildRequestHeaders('POST', {
            url: '/v1/orders/123',
            idempotencyKey: 'explicit-key-456',
        });
        expect(mockGenerator).not.toHaveBeenCalled();
        expect(headers['Idempotency-Key']).toBe('explicit-key-456');
    }));
});
describe('SDK-007 AC-10: request() uses idempotencyKeyGenerator with normalized method and absolute url', () => {
    let mockFetch;
    let savedFetch;
    beforeAll(() => {
        savedFetch = globalThis['fetch'];
    });
    afterAll(() => {
        globalThis['fetch'] = savedFetch;
    });
    beforeEach(() => {
        mockFetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis['fetch'] = mockFetch;
    });
    afterEach(() => {
        jest.clearAllMocks();
    });
    it('forwards a generated Idempotency-Key header for mutating requests', () => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const mockGenerator = jest.fn().mockReturnValue('generated-key-789');
        const client = new http_client_1.SdkHttpClient({
            baseUrl: 'http://localhost:8080',
            idempotencyKeyGenerator: mockGenerator,
        });
        yield client.request('patch', '/v1/orders/123');
        expect(mockGenerator).toHaveBeenCalledTimes(1);
        expect(mockGenerator).toHaveBeenCalledWith('PATCH', 'http://localhost:8080/v1/orders/123');
        const fetchInit = (_a = mockFetch.mock.calls[0]) === null || _a === void 0 ? void 0 : _a[1];
        const fetchHeaders = fetchInit === null || fetchInit === void 0 ? void 0 : fetchInit.headers;
        expect(fetchHeaders === null || fetchHeaders === void 0 ? void 0 : fetchHeaders['Idempotency-Key']).toBe('generated-key-789');
    }));
});
