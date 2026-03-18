"use strict";
/**
 * SDK-003 Shared Transport Layer acceptance tests.
 *
 * Verifies that the shared transport package satisfies the acceptance criteria
 * defined in Story SDK-003.
 *
 * Structural tests cover transport package layout and exports (AC-1 through
 * AC-5, AC-10, AC-11).
 *
 * Behavioral tests verify SdkHttpClient header behavior for authorization,
 * correlation, idempotency, and API version handling (AC-6 through AC-9).
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
// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const TRANSPORT_PKG = path.join(REPO_ROOT, 'packages', 'sdk-transport');
// ---------------------------------------------------------------------------
// AC-1 — Transport package directory exists
// ---------------------------------------------------------------------------
describe('SDK-003 AC-1: packages/sdk-transport/ directory exists', () => {
    it('packages/sdk-transport/ path exists', () => {
        expect(fs.existsSync(TRANSPORT_PKG)).toBe(true);
    });
    it('packages/sdk-transport/ is a directory', () => {
        expect(fs.existsSync(TRANSPORT_PKG)).toBe(true);
        expect(fs.statSync(TRANSPORT_PKG).isDirectory()).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-2 — Transport package has correct package.json
// ---------------------------------------------------------------------------
describe('SDK-003 AC-2: packages/sdk-transport/package.json', () => {
    const pkgJsonPath = path.join(TRANSPORT_PKG, 'package.json');
    it('package.json file exists', () => {
        expect(fs.existsSync(pkgJsonPath)).toBe(true);
    });
    it('name field is "@durion-sdk/transport"', () => {
        expect(fs.existsSync(pkgJsonPath)).toBe(true);
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        expect(pkg['name']).toBe('@durion-sdk/transport');
    });
});
// ---------------------------------------------------------------------------
// AC-3 — Transport package has src directory
// ---------------------------------------------------------------------------
describe('SDK-003 AC-3: packages/sdk-transport/src/ directory exists', () => {
    it('packages/sdk-transport/src/ path exists', () => {
        const srcDir = path.join(TRANSPORT_PKG, 'src');
        expect(fs.existsSync(srcDir)).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-4 — DurionSdkConfig interface is exported from src/index.ts
// ---------------------------------------------------------------------------
describe('SDK-003 AC-4: DurionSdkConfig exported from src/index.ts', () => {
    const indexPath = path.join(TRANSPORT_PKG, 'src', 'index.ts');
    it('packages/sdk-transport/src/index.ts exists', () => {
        expect(fs.existsSync(indexPath)).toBe(true);
    });
    it('src/index.ts contains an export for DurionSdkConfig', () => {
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = fs.readFileSync(indexPath, 'utf-8');
        expect(content).toMatch(/export\b.*\bDurionSdkConfig\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-5 — SdkHttpClient is exported from src/index.ts
// ---------------------------------------------------------------------------
describe('SDK-003 AC-5: SdkHttpClient exported from src/index.ts', () => {
    const indexPath = path.join(TRANSPORT_PKG, 'src', 'index.ts');
    it('src/index.ts contains an export for SdkHttpClient', () => {
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = fs.readFileSync(indexPath, 'utf-8');
        expect(content).toMatch(/export\b.*\bSdkHttpClient\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-10 — src/config.ts exists and exports DurionSdkConfig
// ---------------------------------------------------------------------------
describe('SDK-003 AC-10: packages/sdk-transport/src/config.ts', () => {
    const configPath = path.join(TRANSPORT_PKG, 'src', 'config.ts');
    it('src/config.ts exists', () => {
        expect(fs.existsSync(configPath)).toBe(true);
    });
    it('src/config.ts contains an export for DurionSdkConfig', () => {
        expect(fs.existsSync(configPath)).toBe(true);
        const content = fs.readFileSync(configPath, 'utf-8');
        expect(content).toMatch(/export\b.*\bDurionSdkConfig\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-11 — src/http-client.ts exists and exports SdkHttpClient
// ---------------------------------------------------------------------------
describe('SDK-003 AC-11: packages/sdk-transport/src/http-client.ts', () => {
    const httpClientPath = path.join(TRANSPORT_PKG, 'src', 'http-client.ts');
    it('src/http-client.ts exists', () => {
        expect(fs.existsSync(httpClientPath)).toBe(true);
    });
    it('src/http-client.ts contains an export for SdkHttpClient', () => {
        expect(fs.existsSync(httpClientPath)).toBe(true);
        const content = fs.readFileSync(httpClientPath, 'utf-8');
        expect(content).toMatch(/export\b.*\bSdkHttpClient\b/);
    });
});
// ---------------------------------------------------------------------------
// AC-6 through AC-9 — Behavioral tests: SdkHttpClient header injection
//
// The @durion-sdk/transport package does not exist yet. The dynamic import
// in beforeAll will throw MODULE_NOT_FOUND; SdkHttpClient is set to null.
// Every behavioral test checks expect(SdkHttpClient).not.toBeNull() first,
// causing all tests in this describe block to fail RED intentionally.
//
// In GREEN phase these tests exercise the real implementation through the
// tsconfig path alias: @durion-sdk/transport => packages/sdk-transport/src.
// ---------------------------------------------------------------------------
/**
 * Resolves a named header value from any HeadersInit shape (Headers instance,
 * plain record, or entries array).  Header name lookup is case-insensitive.
 */
function getHeader(headers, name) {
    var _a, _b;
    if (!headers)
        return null;
    if (headers instanceof Headers)
        return headers.get(name);
    if (Array.isArray(headers)) {
        const entry = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
        return entry ? ((_a = entry[1]) !== null && _a !== void 0 ? _a : null) : null;
    }
    const obj = headers;
    const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? null : ((_b = obj[key]) !== null && _b !== void 0 ? _b : null);
}
/**
 * TypeScript assertion function used as a RED guard in behavioral tests.
 * Throws when the transport module was not loaded (RED phase), which causes
 * the test to fail with a clear diagnostic message.  After this call TypeScript
 * narrows the type to non-null, so no casts or ! operators are required below.
 *
 * @param val   The value to assert as non-null.
 * @param label Human-readable label for the error message.
 */
function requireLoaded(val, label) {
    if (val === null) {
        throw new Error(`${label} is null — @durion-sdk/transport module not found (expected RED failure)`);
    }
}
describe('SDK-003 AC-6–9: SdkHttpClient header injection', () => {
    let SdkHttpClient;
    let mockFetch;
    let savedFetch;
    beforeAll(() => __awaiter(void 0, void 0, void 0, function* () {
        // Snapshot real fetch so afterAll can restore it cleanly.
        savedFetch = globalThis['fetch'];
        try {
            // Attempt to load via tsconfig path alias; fails RED until GREEN scaffold.
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore — module does not exist yet; resolves to null in RED phase
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const mod = yield Promise.resolve().then(() => __importStar(require('@durion-sdk/transport')));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            SdkHttpClient = mod.SdkHttpClient;
        }
        catch (_a) {
            SdkHttpClient = null;
        }
    }));
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
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // -------------------------------------------------------------------------
    // AC-6: Authorization header injection
    // -------------------------------------------------------------------------
    it('AC-6: injects Authorization: Bearer <token> when a token function is configured', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({
            baseUrl: 'https://gateway.example.com',
            token: () => 'test-token',
        });
        yield client.request('GET', '/v1/test');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'Authorization')).toBe('Bearer test-token');
    }));
    it('AC-6: omits Authorization header when no token is configured', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('GET', '/v1/test');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'Authorization')).toBeNull();
    }));
    // -------------------------------------------------------------------------
    // AC-7: X-API-Version header injection
    // -------------------------------------------------------------------------
    it('AC-7: injects X-API-Version defaulting to "1" when apiVersion is not in config', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('GET', '/v1/test');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'X-API-Version')).toBe('1');
    }));
    it('AC-7: injects X-API-Version with the configured apiVersion value', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({
            baseUrl: 'https://gateway.example.com',
            apiVersion: '2',
        });
        yield client.request('GET', '/v1/test');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'X-API-Version')).toBe('2');
    }));
    // -------------------------------------------------------------------------
    // AC-8: X-Correlation-Id header injection
    // -------------------------------------------------------------------------
    it('AC-8: injects X-Correlation-Id as a UUID-format value on every request', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('GET', '/v1/test');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'X-Correlation-Id')).toMatch(UUID_PATTERN);
    }));
    it('AC-8: generates a unique X-Correlation-Id per request', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('GET', '/v1/first');
        yield client.request('GET', '/v1/second');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [, init1] = mockFetch.mock.calls[0];
        const [, init2] = mockFetch.mock.calls[1];
        const id1 = getHeader(init1.headers, 'X-Correlation-Id');
        const id2 = getHeader(init2.headers, 'X-Correlation-Id');
        expect(id1).toMatch(UUID_PATTERN);
        expect(id2).toMatch(UUID_PATTERN);
        expect(id1).not.toBe(id2);
    }));
    // -------------------------------------------------------------------------
    // AC-9: Idempotency-Key header injection (mutating requests only)
    // -------------------------------------------------------------------------
    it('AC-9: injects Idempotency-Key on POST requests when caller provides one', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('POST', '/v1/test', { idempotencyKey: 'key-abc-123' });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'Idempotency-Key')).toBe('key-abc-123');
    }));
    it('AC-9: does NOT inject Idempotency-Key on GET requests even when caller provides one', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient'); // RED: @durion-sdk/transport not found
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('GET', '/v1/test', { idempotencyKey: 'key-abc-123' });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'Idempotency-Key')).toBeNull();
    }));
    // -------------------------------------------------------------------------
    // Body / Content-Type / absolute URL branch coverage
    // -------------------------------------------------------------------------
    it('sets Content-Type to application/json and serializes the body when body is provided', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient');
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        const payload = { orderId: 'abc-123', quantity: 2 };
        yield client.request('POST', '/v1/orders', { body: payload });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'Content-Type')).toBe('application/json');
        expect(init.body).toBe(JSON.stringify(payload));
    }));
    it('does NOT override Content-Type when caller already provides it alongside a body', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient');
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        yield client.request('POST', '/v1/orders', {
            headers: { 'Content-Type': 'application/merge-patch+json' },
            body: { status: 'cancelled' },
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [, init] = mockFetch.mock.calls[0];
        expect(getHeader(init.headers, 'Content-Type')).toBe('application/merge-patch+json');
    }));
    it('uses an absolute URL directly without prepending baseUrl', () => __awaiter(void 0, void 0, void 0, function* () {
        requireLoaded(SdkHttpClient, 'SdkHttpClient');
        const client = new SdkHttpClient({ baseUrl: 'https://gateway.example.com' });
        const absoluteUrl = 'https://other-service.internal/health';
        yield client.request('GET', absoluteUrl);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [calledUrl] = mockFetch.mock.calls[0];
        expect(calledUrl).toBe(absoluteUrl);
    }));
});
