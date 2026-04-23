/**
 * SDK-005 Phase 2 Public Module Packages — RED phase acceptance tests.
 *
 * Verifies that each of the 11 new public gateway client packages satisfies
 * the acceptance criteria defined in Story SDK-005.
 *
 * All tests are structural (file/content probes via fs) and all fail RED
 * intentionally because the Phase 2 packages do not yet exist.
 *
 * Issue: SDK-005
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// __dirname resolves to src/__tests__; repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/**
 * Phase 2 module definitions as [slug, factory-function-name] tuples.
 *
 * The slug is used to derive:
 *   - the package directory:  packages/sdk-{slug}/
 *   - the npm scope name:     @durion-sdk/{slug}
 *   - the generator key:      sdk-{slug}
 *
 * Factory names follow camelCase conversion for multi-word slugs:
 *   shop-manager     → createShopManagerClient
 *   event-receiver   → createEventReceiverClient
 *   vehicle-fitment  → createVehicleFitmentClient
 *   vehicle-inventory → createVehicleInventoryClient
 */
const PHASE_2_MODULES = [
  ['catalog', 'createCatalogClient'],
  ['customer', 'createCustomerClient'],
  ['invoice', 'createInvoiceClient'],
  ['location', 'createLocationClient'],
  ['people', 'createPeopleClient'],
  ['price', 'createPriceClient'],
  ['shop-manager', 'createShopManagerClient'],
  ['image', 'createImageClient'],
  ['event-receiver', 'createEventReceiverClient'],
  ['vehicle-fitment', 'createVehicleFitmentClient'],
  ['vehicle-inventory', 'createVehicleInventoryClient'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

/**
 * Minimum set of API instance property names expected on the object returned
 * by each module's factory function.  Derived from backend OpenAPI specs and
 * the domain structure of each module.  Checked as string literals in the
 * module's compiled src/index.ts.
 */
const PHASE_2_API_PROPS: Readonly<Record<string, readonly string[]>> = {
  'catalog': ['catalogApi', 'catalogItemsApi'],
  'customer': ['crmAccountsApi', 'crmPersonsApi'],
  'invoice': ['billingRulesApi', 'invoiceApi'],
  'location': ['bayApi', 'locationApi', 'mobileUnitApi', 'serviceAreaApi'],
  'people': ['employeeApi', 'peopleApi'],
  'price': ['priceQuotesApi', 'priceRestrictionsApi'],
  'shop-manager': ['appointmentsApi', 'shopApi'],
  'image': ['imageApi'],
  'event-receiver': ['eventEmissionApi', 'eventTypesApi'],
  'vehicle-fitment': ['vehicleFitmentApi'],
  'vehicle-inventory': ['vehicleApi', 'vehicleRegistryApi'],
};

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// ---------------------------------------------------------------------------
// AC-1 — Each Phase 2 module has a packages/sdk-{module}/ directory.
//
//         None of the 11 directories exist yet, so all tests fail RED.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-1: packages/sdk-{module}/ directory exists', () => {
  it.each(PHASE_2_MODULES)(
    'packages/sdk-%s/ directory exists',
    (module) => {
      const dirPath = path.join(PACKAGES_DIR, `sdk-${module}`);
      expect(fs.existsSync(dirPath)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// AC-2 — Each module has packages/sdk-{module}/src/index.ts that contains
//         an export for the factory function create{PascalModule}Client.
//
//         Files do not exist yet, so all tests fail RED.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-2: packages/sdk-{module}/src/index.ts exports factory function', () => {
  it.each(PHASE_2_MODULES)(
    'packages/sdk-%s/src/index.ts exists and exports %s',
    (module, factory) => {
      const indexPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'src', 'index.ts');
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = readText(indexPath);
      expect(content).toMatch(new RegExp(`export function ${factory}`));
    },
  );
});

// ---------------------------------------------------------------------------
// AC-3 — Each module's package.json has the correct @durion-sdk/{module} name.
//
//         package.json files do not exist yet, so all tests fail RED.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-3: packages/sdk-{module}/package.json has correct @durion-sdk name', () => {
  it.each(PHASE_2_MODULES)(
    'packages/sdk-%s/package.json name is "@durion-sdk/{module-slug}"',
    (module) => {
      const pkgJsonPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'package.json');
      expect(fs.existsSync(pkgJsonPath)).toBe(true);
      const pkg = readJson(pkgJsonPath);
      expect(pkg['name']).toBe(`@durion-sdk/${module}`);
    },
  );
});

// ---------------------------------------------------------------------------
// AC-4 — Each module's package.json declares @durion-sdk/transport as a
//         runtime dependency.
//
//         package.json files do not exist yet, so all tests fail RED.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-4: packages/sdk-{module}/package.json depends on @durion-sdk/transport', () => {
  it.each(PHASE_2_MODULES)(
    'packages/sdk-%s/package.json has dependencies["@durion-sdk/transport"]',
    (module) => {
      const pkgJsonPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'package.json');
      expect(fs.existsSync(pkgJsonPath)).toBe(true);
      const pkg = readJson(pkgJsonPath);
      const dependencies = (pkg['dependencies'] ?? {}) as Record<string, unknown>;
      expect(dependencies).toHaveProperty('@durion-sdk/transport');
    },
  );
});

// ---------------------------------------------------------------------------
// AC-5 — openapitools.json generator-cli.generators has a key for each of
//         the 11 Phase 2 modules (key format: sdk-{slug}).
//
//         The root openapitools.json only contains Phase 1 generator keys
//         (sdk-security, sdk-order, sdk-inventory, sdk-workorder,
//         sdk-accounting), so all 11 assertions fail RED.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-5: openapitools.json has generator keys for all Phase 2 modules', () => {
  const openApiToolsPath = path.join(REPO_ROOT, 'openapitools.json');

  it('openapitools.json exists', () => {
    expect(fs.existsSync(openApiToolsPath)).toBe(true);
  });

  it.each(PHASE_2_MODULES)(
    'openapitools.json generator-cli.generators has key "sdk-%s"',
    (module) => {
      expect(fs.existsSync(openApiToolsPath)).toBe(true);
      const config = readJson(openApiToolsPath);
      const generatorCli = (config['generator-cli'] ?? {}) as Record<string, unknown>;
      const generators = (generatorCli['generators'] ?? {}) as Record<string, unknown>;
      expect(generators).toHaveProperty(`sdk-${module}`);
    },
  );
});

// ---------------------------------------------------------------------------
// AC-6 — scripts/generate-openapi.sh MODULES array includes all Phase 2 slugs.
//
//         The existing generate-openapi.sh MODULES array is:
//           (security order inventory workorder accounting)
//         None of the 11 Phase 2 slugs appear, so all tests fail RED.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-6: scripts/generate-openapi.sh contains all Phase 2 module slugs', () => {
  const generateShPath = path.join(REPO_ROOT, 'scripts', 'generate-openapi.sh');

  it('scripts/generate-openapi.sh exists', () => {
    expect(fs.existsSync(generateShPath)).toBe(true);
  });

  it.each(PHASE_2_MODULES)(
    'scripts/generate-openapi.sh contains slug "%s"',
    (module) => {
      expect(fs.existsSync(generateShPath)).toBe(true);
      const content = readText(generateShPath);
      // The slug must appear in the MODULES array definition or as a valid
      // --module argument value within the script.
      expect(content).toContain(module);
    },
  );
});

// ---------------------------------------------------------------------------
// AC-7 — Each module's src/index.ts references the expected API instance
//         property names that the factory function exposes to consumers.
//
//         Files do not exist yet; the existsSync guard fails RED for every
//         module so the content checks are never reached.
// ---------------------------------------------------------------------------

describe('SDK-005 AC-7: src/index.ts contains expected API instance property references', () => {
  it.each(PHASE_2_MODULES)(
    'packages/sdk-%s/src/index.ts contains expected API property names',
    (module) => {
      const indexPath = path.join(PACKAGES_DIR, `sdk-${module}`, 'src', 'index.ts');
      // Fails RED: neither the directory nor index.ts exist for Phase 2 modules.
      expect(fs.existsSync(indexPath)).toBe(true);
      const content = readText(indexPath);
      const expectedProps = PHASE_2_API_PROPS[module] ?? [];
      for (const prop of expectedProps) {
        expect(content).toContain(prop);
      }
    },
  );
});
