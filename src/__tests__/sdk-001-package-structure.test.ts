/**
 * SDK-001 Package Structure — RED phase acceptance tests.
 *
 * Verifies that the monorepo scaffold satisfies the acceptance criteria defined in Story SDK-001.
 * All tests must pass on the feature/backend-sdk-v1 branch.
 *
 * Issue: SDK-001
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AC-1 & AC-2 — package.json workspaces
// ---------------------------------------------------------------------------

describe('SDK-001 AC-1: package.json workspaces', () => {
  let pkg: Record<string, unknown>;

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
  let scripts: Record<string, unknown>;

  beforeAll(() => {
    const pkg = readJson(path.resolve(REPO_ROOT, 'package.json'));
    scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>;
  });

  it.each(['build', 'test', 'lint', 'generate'])(
    'has a "%s" script defined',
    (scriptName) => {
      expect(scripts).toHaveProperty(scriptName);
    },
  );
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

  let devDeps: Record<string, unknown>;

  beforeAll(() => {
    const pkg = readJson(path.resolve(REPO_ROOT, 'package.json'));
    devDeps = (pkg['devDependencies'] ?? {}) as Record<string, unknown>;
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
    let config: Record<string, unknown>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      config = require(eslintrcPath) as Record<string, unknown>;
    } catch {
      throw new Error(
        `.eslintrc.js does not exist or cannot be loaded from ${eslintrcPath}`,
      );
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
    const jestConfig = require(jestConfigPath) as {
      coverageThreshold?: { global?: Record<string, number> };
    };
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
  let compilerOptions: Record<string, unknown>;

  beforeAll(() => {
    const tsconfig = readJson(path.resolve(REPO_ROOT, 'tsconfig.json'));
    compilerOptions = (tsconfig['compilerOptions'] ?? {}) as Record<string, unknown>;
  });

  it('compilerOptions has a paths field', () => {
    expect(compilerOptions).toHaveProperty('paths');
  });

  it('paths contains an "@durion-sdk/*" entry', () => {
    const paths = compilerOptions['paths'] as Record<string, unknown> | undefined;
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
// AC-9 — scripts/generate.sh existence
// ---------------------------------------------------------------------------

describe('SDK-001 AC-9: scripts/generate.sh', () => {
  const generateSh = path.resolve(REPO_ROOT, 'scripts', 'generate.sh');

  it('exists at repo root under scripts/', () => {
    expect(fs.existsSync(generateSh)).toBe(true);
  });

  it('is executable', () => {
    const mode = fs.statSync(generateSh).mode;
    // At least one execute bit must be set (owner, group, or other)
    expect(mode & 0o111).not.toBe(0);
  });
});
