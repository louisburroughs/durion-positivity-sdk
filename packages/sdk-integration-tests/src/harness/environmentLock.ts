/**
 * The accelerated run's lock, taken by the daily populate runs too.
 *
 * The accelerated year and the daily floor/appointment runs write to the same
 * alpha, and a daily run must never land inside a year that is still being built
 * — nor an accelerated run start under a daily run halfway through. A
 * point-in-time check (the accelerated run's pid file, or one /system/time read)
 * cannot see a run that starts a second later. Taking the *same* lock file the
 * accelerated global setup takes, and holding it for the whole run, can: each
 * side's create-or-fail refuses while the other holds it (see AcceleratedLock).
 *
 * The path is the accelerated run's own: `ITEST_ACCEL_LOCK_FILE`, else
 * `${ITEST_ACCEL_JOURNAL ?? '.itest-accel-journal.json'}.lock`. The accelerated
 * suite runs from the repository root, so a relative path is resolved against the
 * root here too — an npm workspace script runs from the package directory, and
 * resolving against that would put the two runs on different files.
 */
import { isAbsolute, resolve } from 'path';
import { AcceleratedLock } from './acceleratedLock';

/** packages/sdk-integration-tests/src/harness → repository root. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

export function environmentLockPath(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): string {
  const configured = env['ITEST_ACCEL_LOCK_FILE'] || `${env['ITEST_ACCEL_JOURNAL'] || '.itest-accel-journal.json'}.lock`;
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

/**
 * Takes the lock for `runId`, or throws naming the holder. It is released when
 * the process exits (including SIGINT/SIGTERM), so a run holds it end to end
 * without a caller-side finally.
 */
export function holdEnvironmentLock(runId: string): AcceleratedLock {
  const lock = new AcceleratedLock(environmentLockPath(), { runId, realStart: new Date() });
  lock.acquire();
  return lock;
}
