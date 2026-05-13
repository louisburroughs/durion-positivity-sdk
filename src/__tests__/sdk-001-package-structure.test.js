"use strict";
/**
 * SDK-001 Package Structure — RED phase acceptance tests.
 *
 * Verifies that the monorepo scaffold satisfies the acceptance criteria defined in Story SDK-001.
 * All tests must pass on the feature/backend-sdk-v1 branch.
 *
 * Issue: SDK-001
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
// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
// ---------------------------------------------------------------------------
// AC-1 & AC-2 — package.json workspaces
// ---------------------------------------------------------------------------
describe('SDK-001 AC-1: package.json workspaces', () => {
    let pkg;
    beforeAll(() => {
        pkg = readJson(path.resolve(REPO_ROOT, 'package.json'));
    });
    it('has a workspaces field', () => {
        expect(pkg).toHaveProperty('workspaces');
    });
    it('workspaces contains "packages/*"', () => {
        expect(pkg['workspaces']).toEqual(expect.arrayContaining(['packages/*']));
    });
});
// ---------------------------------------------------------------------------
// AC-2 — package.json scripts
// ---------------------------------------------------------------------------
describe('SDK-001 AC-2: package.json scripts', () => {
    let scripts;
    beforeAll(() => {
        const pkg = readJson(path.resolve(REPO_ROOT, 'package.json'));
        scripts = (pkg['scripts'] ?? {});
    });
    it.each(['build', 'test', 'lint', 'generate'])('has a "%s" script defined', (scriptName) => {
        expect(scripts).toHaveProperty(scriptName);
    });
});
// ---------------------------------------------------------------------------
// AC-3 — package.json devDependencies
// ---------------------------------------------------------------------------
describe('SDK-001 AC-3: package.json devDependencies', () => {
    const REQUIRED_DEV_DEPS = [
        'typescript',
        'jest',
        'ts-jest',
        '@types/jest',
        'eslint',
        '@typescript-eslint/parser',
        '@typescript-eslint/eslint-plugin',
        '@openapitools/openapi-generator-cli',
    ];
    let devDeps;
    beforeAll(() => {
        const pkg = readJson(path.resolve(REPO_ROOT, 'package.json'));
        devDeps = (pkg['devDependencies'] ?? {});
    });
    it.each(REQUIRED_DEV_DEPS)('devDependencies has "%s"', (dep) => {
        expect(devDeps).toHaveProperty(dep);
    });
});
// ---------------------------------------------------------------------------
// AC-4 — .eslintrc.js existence
// ---------------------------------------------------------------------------
describe('SDK-001 AC-4: .eslintrc.js file existence', () => {
    it('exists at repo root', () => {
        const eslintrcPath = path.resolve(REPO_ROOT, '.eslintrc.js');
        expect(fs.existsSync(eslintrcPath)).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-5 — .eslintrc.js content: TypeScript parser
// ---------------------------------------------------------------------------
describe('SDK-001 AC-5: .eslintrc.js TypeScript parser config', () => {
    it('exports an object with parser set to "@typescript-eslint/parser"', () => {
        const eslintrcPath = path.resolve(REPO_ROOT, '.eslintrc.js');
        let config;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            config = require(eslintrcPath);
        }
        catch {
            throw new Error(`.eslintrc.js does not exist or cannot be loaded from ${eslintrcPath}`);
        }
        expect(config.parser).toBe('@typescript-eslint/parser');
    });
});
// ---------------------------------------------------------------------------
// AC-6 — jest.config.js coverage threshold at 80%
// ---------------------------------------------------------------------------
describe('SDK-001 AC-6: jest.config.js coverage thresholds', () => {
    it('defines global coverageThreshold with all four metrics set to 80', () => {
        const jestConfigPath = path.resolve(REPO_ROOT, 'jest.config.js');
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const jestConfig = require(jestConfigPath);
        const globalThreshold = jestConfig.coverageThreshold?.['global'];
        expect(globalThreshold).toBeDefined();
        expect(globalThreshold?.['branches']).toBe(80);
        expect(globalThreshold?.['functions']).toBe(80);
        expect(globalThreshold?.['lines']).toBe(80);
        expect(globalThreshold?.['statements']).toBe(80);
    });
});
// ---------------------------------------------------------------------------
// AC-7 — tsconfig.json path aliases
// ---------------------------------------------------------------------------
describe('SDK-001 AC-7: tsconfig.json @durion-sdk/* path alias', () => {
    let compilerOptions;
    beforeAll(() => {
        const tsconfig = readJson(path.resolve(REPO_ROOT, 'tsconfig.json'));
        compilerOptions = (tsconfig['compilerOptions'] ?? {});
    });
    it('compilerOptions has a paths field', () => {
        expect(compilerOptions).toHaveProperty('paths');
    });
    it('paths contains an "@durion-sdk/*" entry', () => {
        const paths = compilerOptions['paths'];
        expect(paths).toHaveProperty('@durion-sdk/*');
    });
});
// ---------------------------------------------------------------------------
// AC-8 — packages/ directory existence
// ---------------------------------------------------------------------------
describe('SDK-001 AC-8: packages/ directory', () => {
    it('exists at repo root', () => {
        const packagesDir = path.resolve(REPO_ROOT, 'packages');
        expect(fs.existsSync(packagesDir)).toBe(true);
    });
    it('is a directory', () => {
        const packagesDir = path.resolve(REPO_ROOT, 'packages');
        // Will throw if doesn't exist; still counts as RED failure
        expect(fs.statSync(packagesDir).isDirectory()).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC-9 — scripts/generate-openapi.sh existence
// ---------------------------------------------------------------------------
describe('SDK-001 AC-9: scripts/generate-openapi.sh', () => {
    const generateSh = path.resolve(REPO_ROOT, 'scripts', 'generate-openapi.sh');
    it('exists at repo root under scripts/', () => {
        expect(fs.existsSync(generateSh)).toBe(true);
    });
    it('is executable', () => {
        const mode = fs.statSync(generateSh).mode;
        // At least one execute bit must be set (owner, group, or other)
        expect(mode & 0o111).not.toBe(0);
    });
});
