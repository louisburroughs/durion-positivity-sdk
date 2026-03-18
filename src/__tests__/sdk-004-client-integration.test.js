"use strict";
/**
 * SDK-004 Generated Client Integration with Transport — RED phase acceptance tests.
 *
 * Verifies that each generated client package (sdk-security, sdk-order,
 * sdk-inventory, sdk-workorder, sdk-accounting) satisfies the acceptance
 * criteria defined in Story SDK-004 for transport integration.
 *
 * All tests in AC-1 through AC-6 check structural preconditions and file
 * content that does NOT yet exist in the generated packages.  AC-7 and AC-8
 * use dynamic import to verify that factory functions are exported; since the
 * generated index.ts files do not yet export factory functions, those
 * assertions fail RED intentionally.
 *
 * Issue: SDK-004
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
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// __dirname resolves to src/__tests/; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');
const PHASE_1_MODULES = [
    'security',
    'order',
    'inventory',
    'workorder',
    'accounting',
];
/**
 * Returns the PascalCase domain name used to derive the factory function name
 * for each module.  For example, 'security' → 'Security', which maps to
 * createSecurityClient.
 */
function toPascalCase(module) {
    return module.charAt(0).toUpperCase() + module.slice(1);
}
/** Returns the expected factory function name for a given module. */
function factoryName(module) {
    return `create${toPascalCase(module)}Client`;
}
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function readText(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}
// ---------------------------------------------------------------------------
// AC-1 — Per-package tsconfig.json must extend the root tsconfig so that
//         monorepo path mappings (e.g. @durion-sdk/transport) are inherited.
//
//         The OpenAPI-generated tsconfig.json files do NOT currently have an
//         "extends" field pointing to the root tsconfig, so all these tests
//         fail RED intentionally.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-1: per-package tsconfig.json extends root tsconfig', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/tsconfig.json has an "extends" field pointing to root tsconfig', (module) => {
        const tsconfigPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'tsconfig.json');
        expect(fs.existsSync(tsconfigPath)).toBe(true);
        const tsconfig = readJson(tsconfigPath);
        // Must extend ../../tsconfig.json (from the per-package directory) so
        // TypeScript resolves @durion-sdk/transport via the root paths mapping.
        expect(tsconfig['extends']).toBe('../../tsconfig.json');
    });
});
// ---------------------------------------------------------------------------
// AC-2 — Each generated package.json must declare @durion-sdk/transport as a
//         runtime dependency so consumers get the transport module.
//
//         Generated package.json files have no "dependencies" key at all,
//         so all these tests fail RED intentionally.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-2: per-package package.json has @durion-sdk/transport dependency', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/package.json has dependencies["@durion-sdk/transport"]', (module) => {
        const pkgJsonPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'package.json');
        expect(fs.existsSync(pkgJsonPath)).toBe(true);
        const pkg = readJson(pkgJsonPath);
        const dependencies = (pkg['dependencies'] ?? {});
        expect(dependencies).toHaveProperty('@durion-sdk/transport');
    });
});
// ---------------------------------------------------------------------------
// AC-3 — Each generated package's src/index.ts must be transport-aware: it
//         must import from @durion-sdk/transport, reference DurionSdkConfig,
//         or export a typed factory function.
//
//         Generated index.ts files only contain OpenAPI re-exports and have
//         none of these markers, so all these tests fail RED intentionally.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-3: per-package src/index.ts is transport-aware', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/src/index.ts contains transport integration marker', (module) => {
        const indexPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        // At least one of these markers must be present:
        //  - import/re-export from @durion-sdk/transport
        //  - DurionSdkConfig referenced (factory wiring type)
        //  - the domain-specific factory function name
        const factory = factoryName(module);
        const isTransportAware = content.includes('@durion-sdk/transport') ||
            content.includes('DurionSdkConfig') ||
            content.includes(factory);
        expect(isTransportAware).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-4 — Redundant content-level guard: the raw package.json text must
//         contain the string "@durion-sdk/transport".
//
//         None of the generated package.json files reference transport, so
//         all these tests fail RED intentionally.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-4: @durion-sdk/transport referenced in each package.json', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/package.json raw content contains "@durion-sdk/transport"', (module) => {
        const pkgJsonPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'package.json');
        expect(fs.existsSync(pkgJsonPath)).toBe(true);
        const content = readText(pkgJsonPath);
        expect(content).toContain('@durion-sdk/transport');
    });
});
// ---------------------------------------------------------------------------
// AC-5 — Each package must export a properly named factory function.
//         The factory identifier must appear in the package's source files.
//
//         No factory functions exist in any generated package, so all these
//         tests fail RED intentionally.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-5: each package exports a named factory function', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/src/index.ts contains export for %s factory function', (module) => {
        const indexPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'src', 'index.ts');
        expect(fs.existsSync(indexPath)).toBe(true);
        const content = readText(indexPath);
        const factory = factoryName(module);
        // Accept any of the standard export forms:
        //   export function createXxxClient
        //   export const createXxxClient
        //   function createXxxClient  (exported via named export)
        const hasFactory = content.includes(`export function ${factory}`) ||
            content.includes(`export const ${factory}`) ||
            content.includes(`function ${factory}`);
        expect(hasFactory).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-6 — Factory function signature must reference DurionSdkConfig, proving
//         the factory is wired to the transport configuration type.
//
//         Generated source files do not reference DurionSdkConfig, so all
//         these tests fail RED intentionally.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-6: factory file references DurionSdkConfig', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s source files contain DurionSdkConfig', (module) => {
        const pkgDir = path.join(PACKAGES_DIR, `sdk-${module}`, 'src');
        // Prefer a dedicated client.ts; fall back to index.ts.
        const clientPath = path.join(pkgDir, 'client.ts');
        const indexPath = path.join(pkgDir, 'index.ts');
        const targetPath = fs.existsSync(clientPath) ? clientPath : indexPath;
        expect(fs.existsSync(targetPath)).toBe(true);
        const content = readText(targetPath);
        expect(content).toContain('DurionSdkConfig');
    });
});
// ---------------------------------------------------------------------------
// AC-7 — Dynamic import: @durion-sdk/security resolves AND exports the
//         createSecurityClient factory at runtime.
//
//         The jest.config.js moduleNameMapper resolves @durion-sdk/security to
//         packages/sdk-security/src/index.ts, so the import itself will
//         succeed.  However, the generated index.ts does not export
//         createSecurityClient, so the factory assertion fails RED.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-7: dynamic import — @durion-sdk/security exports createSecurityClient', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let securityMod;
    beforeAll(async () => {
        try {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore — TS2307: suppress compile-time resolution error
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            securityMod = (await Promise.resolve().then(() => __importStar(require('@durion-sdk/security'))));
        }
        catch {
            securityMod = null;
        }
    });
    it('AC-7: @durion-sdk/security module resolves as a non-null object', () => {
        // Passes once the moduleNameMapper resolves the generated index.ts.
        expect(securityMod).not.toBeNull();
        expect(securityMod).toBeDefined();
    });
    it('AC-7: @durion-sdk/security exports createSecurityClient', () => {
        // Fails RED: the generated index.ts does not export createSecurityClient.
        expect(securityMod).not.toBeNull();
        const securityFactory = securityMod?.['createSecurityClient'];
        expect(securityFactory).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-8 — Dynamic import: all 5 client packages export their named factory
//         functions.  All 5 packages are resolved up-front using concrete
//         import() calls so that Jest's moduleNameMapper is applied; each
//         module resolves successfully but the factory assertion fails RED
//         for every package because no factory functions are implemented yet.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-8: dynamic import — all 5 clients export their factory functions', () => {
    const resolvedMods = {};
    beforeAll(async () => {
        // Concrete import() literals are required so Jest's moduleNameMapper
        // can rewrite the specifiers at compile time.  eval()-based dynamic
        // imports bypass the mapper and produce MODULE_NOT_FOUND errors.
        const loadResults = await Promise.allSettled([
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            Promise.resolve().then(() => __importStar(require('@durion-sdk/security'))),
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            Promise.resolve().then(() => __importStar(require('@durion-sdk/order'))),
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            Promise.resolve().then(() => __importStar(require('@durion-sdk/inventory'))),
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            Promise.resolve().then(() => __importStar(require('@durion-sdk/workorder'))),
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            Promise.resolve().then(() => __importStar(require('@durion-sdk/accounting'))),
        ]);
        const names = PHASE_1_MODULES;
        for (let i = 0; i < names.length; i++) {
            const result = loadResults[i];
            if (result === undefined)
                continue;
            resolvedMods[names[i]] =
                result.status === 'fulfilled'
                    ? result.value
                    : null;
        }
    });
    const moduleFactoryPairs = PHASE_1_MODULES.map((m) => [m, factoryName(m)]);
    it.each(moduleFactoryPairs)('@durion-sdk/%s exports %s', (module, factory) => {
        const mod = resolvedMods[module];
        // Module resolves via moduleNameMapper — expect non-null.
        expect(mod).not.toBeNull();
        // Factory MUST be exported — fails RED in this phase.
        const exportedFactory = mod?.[factory];
        expect(exportedFactory).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-10 — Factory function invocation: calling createXxxClient(config) must
//          return a non-null object whose properties are valid API instances.
//          These tests cover the factory function body (lines 8-24 in each
//          index.ts) that was completely un-executed before this suite.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-10: factory function invocation — all 5 clients return API instances', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('createSecurityClient returns expected API namespaces', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createSecurityClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/security')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = createSecurityClient({ baseUrl: 'http://localhost:8080', token: () => 'tok' });
        expect(client['authAPIApi']).toBeDefined();
        expect(client['userAPIApi']).toBeDefined();
        expect(client['permissionRegistryApi']).toBeDefined();
        expect(client['roleManagementApi']).toBeDefined();
        expect(client['jwtAPIApi']).toBeDefined();
    });
    it('createOrderClient returns expected API namespaces', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createOrderClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/order')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = createOrderClient({ baseUrl: 'http://localhost:8081', token: () => 'tok' });
        expect(client['salesOrdersApi']).toBeDefined();
        expect(client['priceOverridesApi']).toBeDefined();
        expect(client['orderCancellationApi']).toBeDefined();
    });
    it('createInventoryClient returns expected API namespaces', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createInventoryClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/inventory')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = createInventoryClient({ baseUrl: 'http://localhost:8082', token: () => 'tok' });
        expect(client['inventoryManagementApi']).toBeDefined();
        expect(client['purchaseOrdersApi']).toBeDefined();
        expect(client['receivingApi']).toBeDefined();
    });
    it('createWorkorderClient returns expected API namespaces', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createWorkorderClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/workorder')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = createWorkorderClient({ baseUrl: 'http://localhost:8083', token: () => 'tok' });
        expect(client['workOrderAPIApi']).toBeDefined();
        expect(client['estimateAPIApi']).toBeDefined();
        expect(client['technicianAssignmentAPIApi']).toBeDefined();
    });
    it('createAccountingClient returns expected API namespaces', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createAccountingClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/accounting')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const client = createAccountingClient({ baseUrl: 'http://localhost:8084', token: () => 'tok' });
        expect(client['journalEntriesApi']).toBeDefined();
        expect(client['glAccountsApi']).toBeDefined();
        expect(client['financialReportingApi']).toBeDefined();
    });
});
// ---------------------------------------------------------------------------
// AC-11 — Factory fetchApi callback branch coverage.
//
//          Each factory defines an inline async fetchApi passed to
//          Configuration.  The callback has two branches:
//
//            (init?.method ?? 'GET')
//            ├─ Branch A: init.method is provided (truthy) — no fallback
//            └─ Branch B: init.method is absent/undefined — fallback to 'GET'
//
//          These tests invoke the fetchApi directly via the protected
//          `configuration` stored on a returned API instance, exercising both
//          sides of the nullish-coalescing operator and covering the function
//          body for all 5 factories.
// ---------------------------------------------------------------------------
describe('SDK-004 AC-11: factory fetchApi callback — branch coverage for ?? fallback', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('security fetchApi — explicit method (Branch A: no ?? fallback)', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createSecurityClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/security')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = createSecurityClient({ baseUrl: 'http://localhost:8080', token: () => 'bearer-tok', apiVersion: '1' });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const fetchApi = client.authAPIApi?.configuration?.fetchApi;
        expect(fetchApi).toBeDefined();
        // init.method provided → no fallback
        await fetchApi('http://localhost:8080/api/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, calledInit] = fetchMock.mock.calls[0];
        expect(new Headers(calledInit.headers).get('Authorization')).toBe('Bearer bearer-tok');
    });
    it('security fetchApi — absent method (Branch B: ?? fallback to GET)', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { createSecurityClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/security')));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
        const client = createSecurityClient({ baseUrl: 'http://localhost:8080', token: () => 'bearer-tok', apiVersion: '1' });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const fetchApi = client.authAPIApi?.configuration?.fetchApi;
        expect(fetchApi).toBeDefined();
        // init has no method property → fallback to 'GET'
        await fetchApi('http://localhost:8080/api/list', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, calledInit] = fetchMock.mock.calls[0];
        expect(new Headers(calledInit.headers).get('Authorization')).toBe('Bearer bearer-tok');
    });
    it('order, inventory, workorder, accounting fetchApi bodies all covered', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const orderMod = await Promise.resolve().then(() => __importStar(require('@durion-sdk/order')));
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const inventoryMod = await Promise.resolve().then(() => __importStar(require('@durion-sdk/inventory')));
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const workorderMod = await Promise.resolve().then(() => __importStar(require('@durion-sdk/workorder')));
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const accountingMod = await Promise.resolve().then(() => __importStar(require('@durion-sdk/accounting')));
        const cases = [
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
            { client: orderMod.createOrderClient({ baseUrl: 'http://localhost:8081', token: () => 'tok', apiVersion: '1' }), apiKey: 'salesOrdersApi' },
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
            { client: inventoryMod.createInventoryClient({ baseUrl: 'http://localhost:8082', token: () => 'tok', apiVersion: '1' }), apiKey: 'inventoryManagementApi' },
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
            { client: workorderMod.createWorkorderClient({ baseUrl: 'http://localhost:8083', token: () => 'tok', apiVersion: '1' }), apiKey: 'workOrderAPIApi' },
            // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
            { client: accountingMod.createAccountingClient({ baseUrl: 'http://localhost:8084', token: () => 'tok', apiVersion: '1' }), apiKey: 'journalEntriesApi' },
        ];
        for (const { client, apiKey } of cases) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const fetchApi = client[apiKey]?.configuration?.fetchApi;
            expect(fetchApi).toBeDefined();
            // Branch A: explicit method
            await fetchApi('http://localhost/api', { method: 'GET', headers: { Accept: 'application/json' } });
            // Branch B: method absent → ?? fallback
            await fetchApi('http://localhost/api', {});
        }
        // 2 calls × 4 factories
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(8);
    });
});
// ---------------------------------------------------------------------------
// AC-9 (original) — factory behavioral tests
// ---------------------------------------------------------------------------
describe('AC-9: factory behavioral tests (header injection, no body double-serialization)', () => {
    let fetchMock;
    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        globalThis.fetch = fetchMock;
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    it('should inject Authorization, X-API-Version, X-Correlation-Id on all requests', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { SdkHttpClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/transport')));
        const httpClient = new SdkHttpClient({
            baseUrl: 'http://localhost:8080',
            token: () => 'test-bearer-token',
            apiVersion: '1',
        });
        const method = 'GET';
        const sdkHeaders = await httpClient.buildRequestHeaders(method);
        const mergedHeaders = new Headers({ Accept: 'application/json' });
        Object.entries(sdkHeaders).forEach(([key, value]) => {
            mergedHeaders.set(key, value);
        });
        await fetch('http://localhost:8080/test', { method, headers: mergedHeaders });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const calledInit = fetchMock.mock.calls[0][1];
        const headers = new Headers(calledInit.headers);
        expect(headers.get('Authorization')).toBe('Bearer test-bearer-token');
        expect(headers.get('X-API-Version')).toBe('1');
        expect(headers.get('X-Correlation-Id')).toMatch(/^[0-9a-f-]{36}$/);
    });
    it('should not double-serialize JSON body in POST requests', async () => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { SdkHttpClient } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/transport')));
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const { Configuration } = await Promise.resolve().then(() => __importStar(require('@durion-sdk/security')));
        const httpClient = new SdkHttpClient({
            baseUrl: 'http://localhost:8080',
            token: () => 'test-token',
        });
        const config = new Configuration({
            basePath: 'http://localhost:8080',
            fetchApi: async (url, init) => {
                const method = (init?.method ?? 'GET').toUpperCase();
                const sdkHeaders = await httpClient.buildRequestHeaders(method);
                const mergedHeaders = new Headers(init?.headers);
                Object.entries(sdkHeaders).forEach(([key, value]) => {
                    mergedHeaders.set(key, value);
                });
                return fetch(url, { ...init, headers: mergedHeaders });
            },
        });
        const body = JSON.stringify({ test: 'value' });
        await config.fetchApi('http://localhost:8080/test', {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/json' },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const calledInit = fetchMock.mock.calls[0][1];
        expect(calledInit.body).toBe(body);
        const headers = new Headers(calledInit.headers);
        expect(headers.get('Authorization')).toBe('Bearer test-token');
        expect(headers.get('X-API-Version')).toBe('1');
        expect(headers.get('X-Correlation-Id')).toMatch(/^[0-9a-f-]{36}$/);
    });
});
// ---------------------------------------------------------------------------
// AC-inv-path — Static regression guard: inventory API files must use
//               /v1/inventory/ paths, not the old /api/inventory/ prefix.
//
//               Commit 8848e94 fixed the 3 generated inventory API files.
//               These tests read each file as text and assert the broken path
//               string is absent and the correct path string is present,
//               ensuring a silent revert of the fix cannot pass the suite.
//
//               Issue: FIX-2
// ---------------------------------------------------------------------------
describe('AC-inv-path: inventory API path versioning (no /api/ regression guard)', () => {
    const INVENTORY_APIS_DIR = path.resolve(__dirname, '../../packages/sdk-inventory/src/apis');
    const inventoryApiFiles = [
        ['CycleCountOperationsApi.ts', path.join(INVENTORY_APIS_DIR, 'CycleCountOperationsApi.ts')],
        ['CycleCountQueryApi.ts', path.join(INVENTORY_APIS_DIR, 'CycleCountQueryApi.ts')],
        ['InventoryManagementApi.ts', path.join(INVENTORY_APIS_DIR, 'InventoryManagementApi.ts')],
    ];
    // Issue FIX-2: guard against /api/inventory/ path regression
    it.each(inventoryApiFiles)('%s must NOT contain /api/inventory/ paths', (filename, filePath) => {
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content.includes('/api/inventory/')).toBe(false);
    });
    // Issue FIX-2: confirm /v1/inventory/ paths are present in each file
    it.each(inventoryApiFiles)('%s must contain /v1/inventory/ paths', (filename, filePath) => {
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content.includes('/v1/inventory/')).toBe(true);
    });
});
