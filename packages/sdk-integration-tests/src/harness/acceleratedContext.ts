/**
 * The accelerated run's half of the shared context.
 *
 * ItestContext already carries the runId, the mode and the reference cache across
 * the process boundary between Jest's globalSetup and its workers. The accelerated
 * suites need three more things — the clock anchors, the feasibility verdict and
 * the journal path — and they travel the same way, through a JSON file named by an
 * environment variable.
 *
 * Kept separate from ItestContext rather than bolted onto it so the
 * non-accelerated suites' serialization is untouched: they have no clock, and a
 * field they never set is a field someone eventually reads by accident.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Feasibility } from './acceleratedConfig';

export const ACCEL_CONTEXT_FILE_ENV = 'ITEST_ACCEL_CONTEXT_FILE';

export interface AcceleratedContext {
  /** The clock as global setup observed it — the run's identity. */
  clock: {
    virtualTime: string;
    realStart: string;
    virtualStart: string;
    scale: number;
    zone: string;
  };
  feasibility: Feasibility;
  journalPath: string;
  /** Sites whose operating hours and closures this run published. */
  calendarPublishedTo: string[];
  /** True when the journal already held worked days and this process resumed it. */
  resumed: boolean;
}

export function saveAcceleratedContext(context: AcceleratedContext): string {
  const file = join(mkdtempSync(join(tmpdir(), 'durion-accel-')), 'context.json');
  writeFileSync(file, JSON.stringify(context, null, 2), 'utf8');
  process.env[ACCEL_CONTEXT_FILE_ENV] = file;
  return file;
}

export function loadAcceleratedContext(): AcceleratedContext {
  const file = process.env[ACCEL_CONTEXT_FILE_ENV];
  if (!file) {
    throw new Error(
      `${ACCEL_CONTEXT_FILE_ENV} is not set — the accelerated globalSetup did not run. ` +
        'Run the accelerated suites through jest.accelerated.config.js (npm run test:accelerated), ' +
        'never the integration or unit config.',
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as AcceleratedContext;
}
