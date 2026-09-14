// Imported by path, not by package name: Jest applies moduleNameMapper to the
// suites but NOT to globalSetup, so '@durion-sdk/seeder' here would resolve
// through node_modules to packages/sdk-seeder/dist - whatever was last built.
// The fixtures would then silently run stale bootstrap code while the suites
// run the current sources.
import {
  BootstrapOrchestrator,
  SecurityBootstrap,
  SeederAuth,
  SeederConfig,
} from '../../../sdk-seeder/src/lib';
import { ItestConfig } from './ItestConfig';
import { saveContext } from './ItestContext';
import { loadEnvFile } from './loadEnvFile';
import { createPersonaPorts, PersonaBootstrap } from './PersonaBootstrap';
import { createStarterActivationPort, StarterActivation } from './StarterActivation';
import { createTenantPort, TenantPreflight } from './TenantPreflight';

/**
 * Runs once, before any suite: validates configuration, refuses to touch a
 * backend that is mid-accelerated-run, reuses the seeder's idempotent
 * bootstrap as the shared fixture, and hands the ReferenceCache to the
 * suites via ITEST_CONTEXT_FILE. Suites log their personas in themselves —
 * no tokens are serialized.
 */
export default async function globalSetup(): Promise<void> {
  // Credentials may come from the shell or from a git-ignored .env.itest
  // (spec: Environment Contract). A non-empty shell value wins; a set-but-empty
  // one counts as unset and the file applies. See loadEnvFile.
  const envFile = loadEnvFile();
  if (envFile.file !== null) {
    const detail = envFile.skipped.length > 0 ? ` (shell overrides: ${envFile.skipped.join(', ')})` : '';
    console.log(`[itest] loaded ${envFile.applied.length} vars from ${envFile.file}${detail}`);
  }

  const config = ItestConfig.fromEnv();

  await assertNonAcceleratedBackend(config.baseUrl);

  const adminConfig = SeederConfig.fromValues({
    baseUrl: config.baseUrl,
    securityServiceUrl: config.securityServiceUrl,
    username: config.admin.username,
    password: config.admin.password,
    seed: config.seed,
    tenantSlug: config.tenant.slug,
    tenantId: config.tenant.id,
  });

  console.log(`[itest] mode=${config.mode} tenant=${config.tenant.slug} baseUrl=${config.baseUrl}`);
  // The security bootstrap runs before anything logs in. It uses header auth
  // against the security service, pinned to the suite tenant by X-Tenant-Id, so
  // it needs no token and cannot write into another tenant. Running it first is
  // what lets setup repair an admin with no role: such an account answers login
  // with 403 USER_HAS_NO_ROLES, which the activation and tenant probes below
  // would otherwise stop on before ensureSysAdminRole could assign one.
  await stage('security bootstrap', () => new SecurityBootstrap(adminConfig).run());

  // Tenant-aware backends load accounts with a shared starter password that
  // login refuses until it is exchanged. Runs before anything logs in, because
  // activation revokes every token the account already holds.
  const activation = new StarterActivation(config, createStarterActivationPort(config));
  if (activation.applies) {
    const { activated, alreadyActive } = await stage('starter activation', () => activation.run());
    console.log(
      `[itest] starter activation: activated ${activated.join(', ') || 'none'}; ` +
        `already active ${alreadyActive.join(', ') || 'none'}`,
    );
  }

  // Every login must land in the suite tenant before anything is written: a
  // token bound elsewhere would seed and assert against another tenant's rows
  // while every call still succeeds.
  const tenantPreflight = new TenantPreflight(config, createTenantPort(config));
  const bound = await stage('tenant preflight', () => tenantPreflight.run());
  console.log(`[itest] tenant binding verified: ${bound.join(', ')}`);

  const auth = new SeederAuth(adminConfig);
  await stage('admin login', () => auth.login());

  // Role mode only: prove every persona login resolves to an account with the
  // authorities its suite steps need, before the reference bootstrap spends
  // minutes seeding for a run that would 403 halfway through (spec: Task 8).
  const personaBootstrap = new PersonaBootstrap(config, ...personaPortsFor(auth, config.tenant.slug));
  if (personaBootstrap.applies) {
    const { verified, assignments } = await stage('persona preflight', () =>
      personaBootstrap.verifyAndProvision(),
    );
    console.log(`[itest] personas verified: ${verified.join(', ')}`);
    for (const assignment of assignments) {
      console.log(`[itest] role assigned: ${assignment}`);
    }
  }

  const refs = await stage('reference bootstrap', () =>
    new BootstrapOrchestrator(adminConfig, auth).run(),
  );

  // Step 3 runs here rather than with the rest of the preflight: the employees
  // it links to are what the reference bootstrap just created.
  if (personaBootstrap.applies) {
    const { links, limitations } = await stage('persona person-links', () =>
      personaBootstrap.linkPersons(refs.employees),
    );
    for (const link of links) {
      console.log(`[itest] linked ${link}`);
    }
    for (const limitation of limitations) {
      console.log(`[itest] role-mode limitation: ${limitation}`);
    }
  }

  const runId = `itest-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  const file = saveContext({ runId, mode: config.mode, referenceCache: refs });
  console.log(`[itest] runId=${runId} context=${file}`);
}

/** Spreads into the PersonaBootstrap constructor's (security, people) pair. */
function personaPortsFor(auth: SeederAuth, tenantSlug: string | undefined): [
  ReturnType<typeof createPersonaPorts>['security'],
  ReturnType<typeof createPersonaPorts>['people'],
] {
  const ports = createPersonaPorts(auth, tenantSlug);
  return [ports.security, ports.people];
}

async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[itest] global setup failed during ${name}: ${message}${await describeResponse(error)}`);
  }
}

/**
 * The generated clients throw a ResponseError whose message is always
 * "Response returned an error code" - useless on its own when a bootstrap stage
 * fails against a real backend. Pull the request and the server's own error
 * body out of the attached Response so the failure names the endpoint.
 */
async function describeResponse(error: unknown): Promise<string> {
  const response = (error as { response?: Response } | undefined)?.response;
  if (!response || typeof response.status !== 'number') {
    return '';
  }

  let body = '';
  try {
    body = (await response.clone().text()).slice(0, 300);
  } catch {
    body = '(unreadable body)';
  }
  return ` [${response.status} ${response.url}${body ? ` - ${body}` : ''}]`;
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
