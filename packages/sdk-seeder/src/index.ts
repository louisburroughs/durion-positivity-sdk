import { SeederAuth } from './SeederAuth';
import { SeederConfig } from './SeederConfig';
import { SecurityBootstrap } from './bootstrap/SecurityBootstrap';
import { BootstrapOrchestrator } from './bootstrap/BootstrapOrchestrator';
import { DailyLoopRunner } from './loop/DailyLoopRunner';

const ts = (): string => new Date().toISOString();
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...args: unknown[]) => _log(`[${ts()}]`, ...args);
console.error = (...args: unknown[]) => _err(`[${ts()}]`, ...args);

async function main(): Promise<void> {
  const config = SeederConfig.fromEnv();
  const auth = new SeederAuth(config);

  console.log(`[Seeder] Starting - baseUrl=${config.baseUrl} days=${config.days} scale=${config.scale}`);

  await new SecurityBootstrap(config).run();

  await auth.login();

  const refs = await new BootstrapOrchestrator(config, auth).run();
  await new DailyLoopRunner(config, auth, refs).run();
}

main().catch((err: unknown) => {
  console.error('[Seeder] Fatal error:', err);
  process.exit(1);
});
