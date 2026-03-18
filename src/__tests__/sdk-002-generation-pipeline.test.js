"use strict";
/**
 * SDK-002 Generation Pipeline — RED phase acceptance tests.
 *
 * Verifies that the OpenAPI generation pipeline satisfies the acceptance
 * criteria defined in Story SDK-002.  These are fast structural tests;
 * they do NOT invoke {@code scripts/generate.sh} at runtime.
 *
 * Issue: SDK-002
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
// __dirname resolves to src/__tests__; repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const PHASE_1_MODULES = [
    'security',
    'order',
    'inventory',
    'workorder',
    'accounting',
];
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function readText(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}
// ---------------------------------------------------------------------------
// AC-1 & AC-2 — openapitools.json config
// ---------------------------------------------------------------------------
describe('SDK-002 AC-1: openapitools.json exists at repo root', () => {
    it('openapitools.json file exists', () => {
        const configPath = path.join(REPO_ROOT, 'openapitools.json');
        expect(fs.existsSync(configPath)).toBe(true);
    });
});
describe('SDK-002 AC-2: openapitools.json has typescript-fetch generator configured', () => {
    it('contains at least one generator config with generatorName typescript-fetch', () => {
        const configPath = path.join(REPO_ROOT, 'openapitools.json');
        const config = readJson(configPath);
        // The openapi-generator-cli config format nests generator configs under a
        // "generator-cli" > "generators" map.  Flatten all values and check that
        // at least one entry specifies typescript-fetch.
        const generatorsCli = config['generator-cli'];
        const generators = generatorsCli === null || generatorsCli === void 0 ? void 0 : generatorsCli['generators'];
        expect(generators).toBeDefined();
        const entries = Object.values(generators !== null && generators !== void 0 ? generators : {});
        const hasFetchGenerator = entries.some((entry) => entry['generatorName'] === 'typescript-fetch');
        expect(hasFetchGenerator).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-3 — generate.sh invokes openapi-generator-cli
// ---------------------------------------------------------------------------
describe('SDK-002 AC-3: generate.sh invokes openapi-generator-cli', () => {
    it('scripts/generate.sh contains openapi-generator-cli generate', () => {
        const scriptPath = path.join(REPO_ROOT, 'scripts', 'generate.sh');
        const content = readText(scriptPath);
        expect(content).toContain('openapi-generator-cli generate');
    });
});
// ---------------------------------------------------------------------------
// AC-4 — generate.sh supports --module argument
// ---------------------------------------------------------------------------
describe('SDK-002 AC-4: generate.sh accepts --module argument', () => {
    it('scripts/generate.sh contains --module argument handling', () => {
        const scriptPath = path.join(REPO_ROOT, 'scripts', 'generate.sh');
        const content = readText(scriptPath);
        // Accept either explicit --module flag parsing or a $module variable reference.
        const hasModuleArg = content.includes('--module') || content.includes('$module');
        expect(hasModuleArg).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-5 through AC-9 — package directories exist after generation
// ---------------------------------------------------------------------------
describe('SDK-002 AC-5–9: generated package directories exist', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/ directory exists', (module) => {
        const pkgDir = path.join(REPO_ROOT, 'packages', `sdk-${module}`);
        expect(fs.existsSync(pkgDir)).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-8 — each generated package.json has correct @durion-sdk/<module> name
// ---------------------------------------------------------------------------
describe('SDK-002 AC-8: generated package.json name matches @durion-sdk/<module>', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/package.json has name "@durion-sdk/%s"', (module) => {
        const pkgJsonPath = path.join(REPO_ROOT, 'packages', `sdk-${module}`, 'package.json');
        expect(fs.existsSync(pkgJsonPath)).toBe(true);
        const pkg = readJson(pkgJsonPath);
        expect(pkg['name']).toBe(`@durion-sdk/${module}`);
    });
});
// ---------------------------------------------------------------------------
// AC-9 — each generated package has a src/ directory with TS API files
// ---------------------------------------------------------------------------
describe('SDK-002 AC-9: generated package has src/ directory', () => {
    it.each(PHASE_1_MODULES)('packages/sdk-%s/src/ directory exists', (module) => {
        const srcDir = path.join(REPO_ROOT, 'packages', `sdk-${module}`, 'src');
        expect(fs.existsSync(srcDir)).toBe(true);
    });
});
