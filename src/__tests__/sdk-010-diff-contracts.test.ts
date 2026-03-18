/**
 * SDK-010 Diff-Contracts Script Tests — intentionally RED phase.
 *
 * ALL tests in this file are expected to FAIL until the GREEN implementation
 * creates the scripts/diff-contracts.sh script.
 *
 * The script compares operationId references between a "previous" snapshot
 * directory and a "current" packages directory, printing ADDED/REMOVED lines.
 *
 * Test categories
 * ---------------
 * 1. Existence test    — verify scripts/diff-contracts.sh exists on disk.
 *    Fail RED: the script file is absent.
 *
 * 2. Argument errors   — verify the script exits 1 when required CLI
 *    arguments are missing.
 *    Fail RED: script is absent.
 *
 * 3. ADDED detection   — verify operations in current but not in previous
 *    are printed as "ADDED: <operationId>".
 *    Fail RED: script is absent.
 *
 * 4. REMOVED detection — verify operations in previous but not in current
 *    are printed as "REMOVED: <operationId>".
 *    Fail RED: script is absent.
 *
 * 5. Stable operations — verify operations present in both dirs are NOT
 *    printed as ADDED or REMOVED.
 *    Fail RED: script is absent.
 *
 * 6. No-op on inputs   — verify the script does not mutate fixture files.
 *    Fail RED: script is absent.
 *
 * 7. Graceful absent   — verify that when --previous directory does not exist
 *    the script exits 0 and treats all current operations as ADDED.
 *    Fail RED: script is absent.
 *
 * Issue: SDK-010
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root of the monorepo — src/__tests__ is two directories below the root. */
const REPO_ROOT = path.resolve(__dirname, '../..');

const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'diff-contracts.sh');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fake generated API file under `<baseDir>/src/apis/TaxApi.ts`
 * containing the given operationId references (one per line, in comment form
 * that the script can grep for).
 */
function writeFakeApiFile(baseDir: string, operationIds: string[]): void {
  const apisDir = path.join(baseDir, 'src', 'apis');
  fs.mkdirSync(apisDir, { recursive: true });

  const body = operationIds.map(id => `  // operationId: ${id}\n  ${id}() {}`).join('\n');
  const lines = ['class TaxApi {', body, '}'];

  fs.writeFileSync(path.join(apisDir, 'TaxApi.ts'), lines.join('\n') + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Test fixtures — created once, cleaned up in afterAll
// ---------------------------------------------------------------------------

let tmpRoot: string;
let prevDir: string;
let currDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-010-'));

  // The script expects directories that contain packages each with src/apis/*.ts
  // We simulate a single-module snapshot layout: prevDir/<pkg>/src/apis/TaxApi.ts
  prevDir = path.join(tmpRoot, 'prev');
  currDir = path.join(tmpRoot, 'curr');

  // Previous snapshot: has calculateTax, getMode, oldOperation
  writeFakeApiFile(prevDir, ['calculateTax', 'getMode', 'oldOperation']);

  // Current packages: has calculateTax, getMode, newOperation (oldOperation removed)
  writeFakeApiFile(currDir, ['calculateTax', 'getMode', 'newOperation']);
});

afterAll(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ===========================================================================
// 1. EXISTENCE TEST — script file on disk
//    Fails RED: scripts/diff-contracts.sh does not exist yet.
// ===========================================================================

describe('SDK-010 DiffContracts: script exists', () => {
  it('scripts/diff-contracts.sh exists', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });
});

// ===========================================================================
// 2. ARGUMENT ERROR TEST — exits 1 when --previous argument is omitted
//    Fails RED: script is absent; spawnSync returns status null/non-zero.
// ===========================================================================

describe('SDK-010 DiffContracts: argument validation', () => {
  it('when_missing_previous_argument_then_exits_1', () => {
    const result = spawnSync('bash', [SCRIPT_PATH, '--current', currDir], {
      encoding: 'utf-8',
    });
    // Missing required --previous argument must be treated as an argument error
    expect(result.status).toBe(1);
  });

  it('when_missing_current_argument_then_exits_1', () => {
    const result = spawnSync('bash', [SCRIPT_PATH, '--previous', prevDir], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(1);
  });
});

// ===========================================================================
// 3. ADDED DETECTION — operations in current but not in previous
//    Fails RED: script is absent.
// ===========================================================================

describe('SDK-010 DiffContracts: ADDED operations are reported', () => {
  it('when_newOperation_in_current_only_then_stdout_contains_ADDED_newOperation', () => {
    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--previous', prevDir, '--current', currDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ADDED: newOperation');
  });
});

// ===========================================================================
// 4. REMOVED DETECTION — operations in previous but not in current
//    Fails RED: script is absent.
// ===========================================================================

describe('SDK-010 DiffContracts: REMOVED operations are reported', () => {
  it('when_oldOperation_in_previous_only_then_stdout_contains_REMOVED_oldOperation', () => {
    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--previous', prevDir, '--current', currDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REMOVED: oldOperation');
  });
});

// ===========================================================================
// 5. STABLE OPERATIONS — present in both; must NOT appear as ADDED or REMOVED
//    Fails RED: script is absent.
// ===========================================================================

describe('SDK-010 DiffContracts: unchanged operations are not reported', () => {
  it('when_calculateTax_in_both_dirs_then_not_reported_as_ADDED_or_REMOVED', () => {
    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--previous', prevDir, '--current', currDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('ADDED: calculateTax');
    expect(result.stdout).not.toContain('REMOVED: calculateTax');
  });

  it('when_getMode_in_both_dirs_then_not_reported_as_ADDED_or_REMOVED', () => {
    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--previous', prevDir, '--current', currDir],
      { encoding: 'utf-8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('ADDED: getMode');
    expect(result.stdout).not.toContain('REMOVED: getMode');
  });
});

// ===========================================================================
// 6. NO-OP ON INPUTS — script must not mutate fixture files
//    Fails RED: script is absent.
// ===========================================================================

describe('SDK-010 DiffContracts: script does not modify input files', () => {
  it('when_script_runs_then_fixture_files_are_unmodified', () => {
    const prevApiFile = path.join(prevDir, 'src', 'apis', 'TaxApi.ts');
    const currApiFile = path.join(currDir, 'src', 'apis', 'TaxApi.ts');

    const prevBefore = fs.readFileSync(prevApiFile, 'utf-8');
    const currBefore = fs.readFileSync(currApiFile, 'utf-8');
    const prevMtimeBefore = fs.statSync(prevApiFile).mtimeMs;
    const currMtimeBefore = fs.statSync(currApiFile).mtimeMs;

    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--previous', prevDir, '--current', currDir],
      { encoding: 'utf-8' },
    );

    // Script must exit cleanly (exit 0) — fails RED when script is absent (exit 127)
    expect(result.status).toBe(0);
    expect(fs.readFileSync(prevApiFile, 'utf-8')).toBe(prevBefore);
    expect(fs.readFileSync(currApiFile, 'utf-8')).toBe(currBefore);
    expect(fs.statSync(prevApiFile).mtimeMs).toBe(prevMtimeBefore);
    expect(fs.statSync(currApiFile).mtimeMs).toBe(currMtimeBefore);
  });
});

// ===========================================================================
// 7. GRACEFUL ABSENT — --previous directory does not exist on disk
//    Script should exit 0 and treat all current operations as ADDED.
//    Fails RED: script is absent.
// ===========================================================================

describe('SDK-010 DiffContracts: graceful handling when --previous directory is absent', () => {
  it('when_previous_dir_does_not_exist_then_exits_0_and_all_current_ops_are_ADDED', () => {
    const nonexistentPrev = path.join(tmpRoot, 'no-such-snapshot');

    const result = spawnSync(
      'bash',
      [SCRIPT_PATH, '--previous', nonexistentPrev, '--current', currDir],
      { encoding: 'utf-8' },
    );

    // Graceful: directory absence is not an argument error, so exit code is 0
    expect(result.status).toBe(0);
    // All current operations should appear as ADDED since there's nothing to compare
    expect(result.stdout).toContain('ADDED: calculateTax');
    expect(result.stdout).toContain('ADDED: getMode');
    expect(result.stdout).toContain('ADDED: newOperation');
  });
});
