/**
 * SDK-010 Internal Profile Tests — intentionally RED phase.
 *
 * ALL tests in this file are expected to FAIL until the GREEN implementation
 * creates the sdk-internal package at packages/sdk-internal/.
 *
 * Test categories
 * ---------------
 * 1. Structural tests  — verify the sdk-internal package directories and
 *    files exist on disk.
 *    Fail RED: the entire packages/sdk-internal/ tree is absent.
 *
 * 2. Manifest tests    — verify packages/sdk-internal/package.json has the
 *    correct name and is marked private.
 *    Fail RED: package.json is absent.
 *
 * 3. README tests      — verify packages/sdk-internal/README.md contains
 *    required documentation strings (internal-only, ADR-0021).
 *    Fail RED: README.md is absent.
 *
 * 4. Isolation tests   — verify createTaxClient is NOT re-exported from any
 *    public sdk-* package index.ts.
 *    These PASS in RED phase (public packages already don't expose
 *    createTaxClient) and serve as safety guards that must never regress.
 *    The structural test for packages/sdk-internal/src/index.ts also
 *    fails RED because the file is absent.
 *
 * 5. Behavioral test   — verify createTaxClient can be imported as a function
 *    from the direct file path packages/sdk-internal/src/index.ts.
 *    Fail RED: Cannot find module — the file does not exist.
 *
 * Issue: SDK-010
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Behavioral import — direct path (not @durion-sdk/internal) because sdk-internal
// is private and intentionally absent from jest moduleNameMapper.
// Resolves to `undefined` until GREEN implementation creates the file.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — intentional RED import; packages/sdk-internal/src/index.ts does not exist yet
import { createTaxClient } from '../../packages/sdk-internal/src/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Root of the monorepo — src/__tests__ is two directories below the root. */
const REPO_ROOT = path.resolve(__dirname, '../..');

function packagePath(...segments: string[]): string {
  return path.join(REPO_ROOT, 'packages', ...segments);
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

/** All public sdk-* package names (everything except sdk-internal). */
const PUBLIC_SDK_PACKAGES = [
  'sdk-accounting',
  'sdk-catalog',
  'sdk-customer',
  'sdk-event-receiver',
  'sdk-image',
  'sdk-inventory',
  'sdk-invoice',
  'sdk-location',
  'sdk-order',
  'sdk-people',
  'sdk-price',
  'sdk-security',
  'sdk-shop-manager',
  'sdk-transport',
  'sdk-vehicle-fitment',
  'sdk-vehicle-inventory',
  'sdk-workorder',
];

// ===========================================================================
// 1. STRUCTURAL TESTS — file-system existence checks
//    Fail RED: the packages/sdk-internal/ tree does not exist yet.
// ===========================================================================

describe('SDK-010 Structural: sdk-internal package tree exists', () => {
  it('packages/sdk-internal/ directory exists', () => {
    const target = packagePath('sdk-internal');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('packages/sdk-internal/package.json exists', () => {
    const target = packagePath('sdk-internal', 'package.json');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('packages/sdk-internal/src/index.ts exists', () => {
    const target = packagePath('sdk-internal', 'src', 'index.ts');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('packages/sdk-internal/README.md exists', () => {
    const target = packagePath('sdk-internal', 'README.md');
    expect(fs.existsSync(target)).toBe(true);
  });
});

// ===========================================================================
// 2. MANIFEST TESTS — package.json shape
//    Fail RED: package.json is absent; once it exists, these guard its shape.
// ===========================================================================

describe('SDK-010 Manifest: packages/sdk-internal/package.json has correct shape', () => {
  it('package.json name is "@durion-sdk/internal"', () => {
    const pkgPath = packagePath('sdk-internal', 'package.json');
    const pkg = JSON.parse(readText(pkgPath));
    expect(pkg.name).toBe('@durion-sdk/internal');
  });

  it('package.json has "private": true', () => {
    const pkgPath = packagePath('sdk-internal', 'package.json');
    const pkg = JSON.parse(readText(pkgPath));
    expect(pkg.private).toBe(true);
  });
});

// ===========================================================================
// 3. README TESTS — required documentation strings
//    Fail RED: README.md is absent; once it exists, these guard its content.
// ===========================================================================

describe('SDK-010 README: packages/sdk-internal/README.md contains required strings', () => {
  it('README.md contains "internal-only"', () => {
    const readmePath = packagePath('sdk-internal', 'README.md');
    const content = readText(readmePath);
    expect(content).toContain('internal-only');
  });

  it('README.md contains "ADR-0021"', () => {
    const readmePath = packagePath('sdk-internal', 'README.md');
    const content = readText(readmePath);
    expect(content).toContain('ADR-0021');
  });
});

// ===========================================================================
// 4a. ISOLATION STRUCTURAL TEST — sdk-internal/src/index.ts exports createTaxClient
//     Fail RED: the index.ts file does not exist yet.
// ===========================================================================

describe('SDK-010 Isolation Structural: sdk-internal index.ts exports createTaxClient', () => {
  it('packages/sdk-internal/src/index.ts contains "createTaxClient"', () => {
    const indexPath = packagePath('sdk-internal', 'src', 'index.ts');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = readText(indexPath);
    expect(content).toContain('createTaxClient');
  });
});

// ===========================================================================
// 4b. ISOLATION SAFETY TESTS — createTaxClient must NOT appear in any public
//     sdk-* package index.ts files.
//     These PASS during RED (and must never regress after GREEN).
// ===========================================================================

describe('SDK-010 Isolation Safety: createTaxClient is not leaked into public packages', () => {
  for (const pkgName of PUBLIC_SDK_PACKAGES) {
    it(`${pkgName}/src/index.ts does NOT export createTaxClient`, () => {
      const indexPath = packagePath(pkgName, 'src', 'index.ts');
      if (!fs.existsSync(indexPath)) {
        // Package index absent — no leakage possible; test passes.
        return;
      }
      const content = readText(indexPath);
      expect(content).not.toContain('createTaxClient');
    });
  }
});

// ===========================================================================
// 5. BEHAVIORAL TEST — createTaxClient is a function
//    Fail RED: "Cannot find module" because packages/sdk-internal/src/index.ts
//    does not exist yet.
// ===========================================================================

describe('SDK-010 Behavioral: createTaxClient factory', () => {
  it('createTaxClient is a function', () => {
    // Fails RED: the module cannot be resolved until GREEN implementation
    // creates packages/sdk-internal/src/index.ts and exports createTaxClient.
    expect(typeof createTaxClient).toBe('function');
  });
});
