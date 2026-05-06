import { SeederAuth } from './SeederAuth';
import { SeederConfig } from './SeederConfig';
import { SecurityBootstrap } from './bootstrap/SecurityBootstrap';
import { BootstrapOrchestrator } from './bootstrap/BootstrapOrchestrator';
import { DailyLoopRunner } from './loop/DailyLoopRunner';

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
