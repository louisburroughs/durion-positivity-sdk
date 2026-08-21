import { BootstrapOrchestrator, SecurityBootstrap, SeederAuth, SeederConfig } from '@durion-sdk/seeder';
import { ItestConfig } from './ItestConfig';
import { saveContext } from './ItestContext';

/**
 * Runs once, before any suite: validates configuration, refuses to touch a
 * backend that is mid-accelerated-run, reuses the seeder's idempotent
 * bootstrap as the shared fixture, and hands the ReferenceCache to the
 * suites via ITEST_CONTEXT_FILE. Suites log their personas in themselves —
 * no tokens are serialized.
 */
export default async function globalSetup(): Promise<void> {
  const config = ItestConfig.fromEnv();

  await assertNonAcceleratedBackend(config.baseUrl);

  const adminConfig = SeederConfig.fromValues({
    baseUrl: config.baseUrl,
    securityServiceUrl: config.securityServiceUrl,
    username: config.admin.username,
    password: config.admin.password,
    seed: config.seed,
  });

  console.log(`[itest] mode=${config.mode} baseUrl=${config.baseUrl}`);
  await stage('security bootstrap', () => new SecurityBootstrap(adminConfig).run());

  const auth = new SeederAuth(adminConfig);
  await stage('admin login', () => auth.login());

  const refs = await stage('reference bootstrap', () =>
    new BootstrapOrchestrator(adminConfig, auth).run(),
  );

  const runId = `itest-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  const file = saveContext({ runId, mode: config.mode, referenceCache: refs });
  console.log(`[itest] runId=${runId} context=${file}`);
}

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[itest] global setup failed during ${name}: ${message}`);
  }
}

/**
 * GET /system/time only exists under the backend's `accelerated` profile.
 * 404 (or any non-200) means the normal clock — proceed. A 200 means alpha
 * is mid-accelerated-run: abort before writing anything (spec: Environment
 * Contract).
 */
async function assertNonAcceleratedBackend(baseUrl: string): Promise<void> {
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
    throw new Error(
      `[itest] ${baseUrl}/system/time returned 200 — the backend is running the accelerated ` +
        `clock profile (${body.slice(0, 200)}). Refusing to write test records mid-accelerated-run.`,
    );
  }
}
