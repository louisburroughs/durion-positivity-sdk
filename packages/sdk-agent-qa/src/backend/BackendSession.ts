/**
 * The backend the harness talks to: who it logs in as, and the checks that
 * must pass before it writes anything.
 *
 * All of it is the integration suite's own machinery, imported rather than
 * copied — the `ITEST_*` environment contract, the `.env.itest` loader, starter
 * password activation, the tenant-binding preflight, the accelerated-clock
 * guard and the environment lock. The harness is one more client of alpha and
 * has to follow the same rules as the suites and the daily populate runs, so
 * it uses the same code to follow them.
 */
import { SeederAuth, SeederConfig } from '@durion-sdk/seeder';
import { assertNonAcceleratedBackend } from '../../../sdk-integration-tests/src/harness/acceleratedClock';
import { holdEnvironmentLock } from '../../../sdk-integration-tests/src/harness/environmentLock';
import { ItestConfig, type PersonaName } from '../../../sdk-integration-tests/src/harness/ItestConfig';
import { loadEnvFile } from '../../../sdk-integration-tests/src/harness/loadEnvFile';
import {
  createStarterActivationPort,
  StarterActivation,
} from '../../../sdk-integration-tests/src/harness/StarterActivation';
import { createTenantPort, TenantPreflight } from '../../../sdk-integration-tests/src/harness/TenantPreflight';
import { PERSONAS, type Persona } from '../scenarios/types';

export interface EnvironmentLockHandle {
  release(): void;
}

export class BackendSession {
  private readonly auths = new Map<string, SeederAuth>();
  private readonly logins = new Map<string, Promise<void>>();
  private preflighted = false;

  private constructor(readonly config: ItestConfig) {}

  /** Loads `.env.itest` (shell values win) and validates the `ITEST_*` contract. */
  static fromEnvironment(log: (message: string) => void = () => undefined): BackendSession {
    const envFile = loadEnvFile();
    if (envFile.file !== null) {
      log(`loaded ${envFile.applied.length} vars from ${envFile.file}`);
    }
    return new BackendSession(ItestConfig.fromEnv());
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** True when at least one persona has its own login, so authorization can actually be refused. */
  get roleMode(): boolean {
    return this.config.mode === 'role';
  }

  get personas(): readonly Persona[] {
    return PERSONAS;
  }

  get tenantSlug(): string {
    return this.config.tenant.slug;
  }

  /**
   * Refuses a backend that is mid-accelerated-run (a converged accelerated
   * clock is fine, as for the daily populate runs), then — once per process —
   * activates starter passwords and proves every login is bound to the tenant
   * under test.
   */
  async preflight(log: (message: string) => void): Promise<void> {
    await assertNonAcceleratedBackend(this.config.baseUrl, { allowConverged: true });
    if (this.preflighted) {
      return;
    }
    const activation = new StarterActivation(this.config, createStarterActivationPort(this.config));
    if (activation.applies) {
      const { activated } = await activation.run();
      if (activated.length > 0) {
        log(`starter activation: ${activated.join(', ')}`);
      }
    }
    const bound = await new TenantPreflight(this.config, createTenantPort(this.config)).run();
    log(`tenant ${this.config.tenant.slug} verified for ${bound.join(', ')}`);
    this.preflighted = true;
  }

  /**
   * Takes the lock the accelerated year and the daily populate runs take, so
   * the harness never writes into a timeline that is still being built.
   */
  holdEnvironmentLock(runId: string): EnvironmentLockHandle {
    return holdEnvironmentLock(runId);
  }

  private authFor(persona: Persona): SeederAuth {
    const credentials = this.config.credentialsFor(persona as PersonaName);
    let auth = this.auths.get(credentials.username);
    if (!auth) {
      auth = new SeederAuth(
        SeederConfig.fromValues({
          baseUrl: this.config.baseUrl,
          securityServiceUrl: this.config.securityServiceUrl,
          username: credentials.username,
          password: credentials.password,
          seed: this.config.seed,
          tenantSlug: this.config.tenant.slug,
          tenantId: this.config.tenant.id,
        }),
      );
      this.auths.set(credentials.username, auth);
    }
    return auth;
  }

  /** A current bearer token for the persona, logging in on first use and renewing as needed. */
  async tokenFor(persona: string): Promise<string> {
    const auth = this.authFor(persona as Persona);
    const username = this.config.credentialsFor(persona as PersonaName).username;
    let login = this.logins.get(username);
    if (!login) {
      login = auth.login();
      this.logins.set(username, login);
      login.catch(() => this.logins.delete(username));
    }
    await login;
    return auth.supplyToken();
  }
}
