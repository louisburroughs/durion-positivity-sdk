/**
 * GET /system/time only exists under the backend's `accelerated` profile.
 * 404 (or any non-200) means the normal clock — proceed. A 200 means alpha
 * is mid-accelerated-run: abort before writing anything (spec: Environment
 * Contract).
 *
 * Shared by the integration globalSetup and the standalone runs under `runs/`:
 * both write records against a real backend, and neither may do it while the
 * seeder is driving a year-scale run on the same database.
 *
 * An accelerated stack does not leave the profile when its run ends: the clock
 * converges on wall time and then ticks at scale 1 (`converged: true`) until
 * the next deploy. `allowConverged` lets a caller that only needs wall time —
 * the daily shop-floor runs — write against that stack. The suites keep the
 * strict default.
 */
export interface BackendClockOptions {
  allowConverged?: boolean;
}

/** True when a /system/time body reports a clock that has caught up with wall time. */
export function isConvergedClock(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && (parsed as { converged?: unknown }).converged === true;
  } catch {
    return false;
  }
}

export async function assertNonAcceleratedBackend(
  baseUrl: string,
  options: BackendClockOptions = {},
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/system/time`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[itest] cannot reach the backend at ${baseUrl} (${message}). ` +
        'Is the tunnel up / the local stack running?',
    );
  }

  if (response.status === 200) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '(unreadable body)';
    }
    if (options.allowConverged && isConvergedClock(body)) {
      return;
    }
    throw new Error(
      `[itest] ${baseUrl}/system/time returned 200 — the backend is running the accelerated ` +
        `clock profile (${body.slice(0, 200)}). Refusing to write test records mid-accelerated-run.`,
    );
  }
}
