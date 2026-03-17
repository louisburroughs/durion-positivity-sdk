/**
 * SDK-002 Generation Pipeline — RED phase acceptance tests.
 *
 * Verifies that the OpenAPI generation pipeline satisfies the acceptance
 * criteria defined in Story SDK-002.  These are fast structural tests;
 * they do NOT invoke {@code scripts/generate.sh} at runtime.
 *
 * Issue: SDK-002
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// __dirname resolves to src/__tests__; repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');

const PHASE_1_MODULES = [
  'security',
  'order',
  'inventory',
  'workorder',
  'accounting',
] as const;

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function readText(filePath: string): string {
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
    const generatorsCli = config['generator-cli'] as Record<string, unknown> | undefined;
    const generators = generatorsCli?.['generators'] as Record<string, unknown> | undefined;
    expect(generators).toBeDefined();
    const entries = Object.values(generators ?? {}) as Array<Record<string, unknown>>;
    const hasFetchGenerator = entries.some(
      (entry) => entry['generatorName'] === 'typescript-fetch',
    );
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
  it.each(PHASE_1_MODULES)(
    'packages/sdk-%s/package.json has name "@durion-sdk/%s"',
    (module) => {
      const pkgJsonPath = path.join(REPO_ROOT, 'packages', `sdk-${module}`, 'package.json');
      expect(fs.existsSync(pkgJsonPath)).toBe(true);
      const pkg = readJson(pkgJsonPath);
      expect(pkg['name']).toBe(`@durion-sdk/${module}`);
    },
  );
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
