import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ReferenceCache } from '@durion-sdk/seeder';
import type { ItestMode } from './ItestConfig';

/**
 * State produced once by globalSetup and rehydrated by every suite file.
 *
 * Jest's globalSetup runs in a separate process from the test workers, so
 * the context crosses via a JSON file whose path is handed to workers
 * through ITEST_CONTEXT_FILE (globalSetup sets it on process.env; jest
 * workers inherit the environment). Deliberately NOT serialized: tokens or
 * passwords — suites log their personas in via beforeAll, so no credential
 * material ever lands in a temp file.
 */
export interface ItestContext {
  runId: string;
  mode: ItestMode;
  referenceCache: ReferenceCache;
}

interface SerializedContext {
  runId: string;
  mode: ItestMode;
  referenceCache: Omit<ReferenceCache, 'serviceNameById' | 'productNameById' | 'employeeNameById'> & {
    serviceNameById: Array<[string, string]>;
    productNameById: Array<[string, string]>;
    employeeNameById: Array<[string, string]>;
  };
}

export const CONTEXT_FILE_ENV = 'ITEST_CONTEXT_FILE';

export function serializeContext(context: ItestContext): string {
  const { referenceCache } = context;
  const serialized: SerializedContext = {
    runId: context.runId,
    mode: context.mode,
    referenceCache: {
      ...referenceCache,
      serviceNameById: [...referenceCache.serviceNameById.entries()],
      productNameById: [...referenceCache.productNameById.entries()],
      employeeNameById: [...referenceCache.employeeNameById.entries()],
    },
  };
  return JSON.stringify(serialized, null, 2);
}

export function deserializeContext(json: string): ItestContext {
  const parsed = JSON.parse(json) as SerializedContext;
  return {
    runId: parsed.runId,
    mode: parsed.mode,
    referenceCache: {
      ...parsed.referenceCache,
      serviceNameById: new Map(parsed.referenceCache.serviceNameById),
      productNameById: new Map(parsed.referenceCache.productNameById),
      employeeNameById: new Map(parsed.referenceCache.employeeNameById),
    },
  };
}

/** Called by globalSetup: writes the context and exports its path. */
export function saveContext(context: ItestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'durion-itest-'));
  const file = join(dir, 'context.json');
  writeFileSync(file, serializeContext(context), 'utf8');
  process.env[CONTEXT_FILE_ENV] = file;
  return file;
}

/** Called by suites in beforeAll. */
export function loadContext(): ItestContext {
  const file = process.env[CONTEXT_FILE_ENV];
  if (!file) {
    throw new Error(
      `${CONTEXT_FILE_ENV} is not set — the integration globalSetup did not run. ` +
        'Run suites through jest.integration.config.js, never the unit config.',
    );
  }
  return deserializeContext(readFileSync(file, 'utf8'));
}
