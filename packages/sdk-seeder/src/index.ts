import { SeederAuth } from './SeederAuth';
import { SeederConfig } from './SeederConfig';
import { SecurityBootstrap } from './bootstrap/SecurityBootstrap';
import { BootstrapOrchestrator } from './bootstrap/BootstrapOrchestrator';
import { DailyLoopRunner } from './loop/DailyLoopRunner';
import { VirtualClock } from './support/VirtualClock';
import { Logger } from './support/Logger';

async function main(): Promise<void> {
  const config = SeederConfig.fromEnv();
  const logger = new Logger();
  const virtualClock = new VirtualClock(config.baseUrl, config.pollIntervalMs);

  logger.setPhase('STARTUP');
  logger.info(`Seeder starting — baseUrl=${config.baseUrl} days=${config.days} pollInterval=${config.pollIntervalMs}ms`);
  logger.info('Waiting for backend /system/time endpoint...');

  // Wait for backend to be fully up and serving virtual time
  const initialTime = await virtualClock.waitForBackend(180_000);
  logger.setVirtualTime(new Date(initialTime.virtualTime));
  logger.setScale(initialTime.scale);
  logger.info(`Backend ready — virtual time: ${initialTime.virtualTime}, scale: ${initialTime.scale}x, zone: ${initialTime.zone}`);

  logger.setPhase('BOOTSTRAP');
  logger.info('Running security bootstrap...');
  await new SecurityBootstrap(config).run();
  logger.info('Security bootstrap complete');

  const auth = new SeederAuth(config);
  await auth.login();
  logger.info('Authenticated successfully');

  // Refresh virtual time after bootstrap (time has advanced)
  const postBootstrapTime = await virtualClock.getCurrentVirtualTime();
  logger.setVirtualTime(postBootstrapTime);
  logger.info('Starting bootstrap orchestrator...');

  const refs = await new BootstrapOrchestrator(config, auth).run();
  logger.info('Bootstrap orchestrator complete — reference data loaded');

  // Refresh virtual time before entering daily loop
  const preLoopTime = await virtualClock.getCurrentVirtualTime();
  logger.setVirtualTime(preLoopTime);
  logger.info(`Entering daily loop — current virtual time: ${preLoopTime.toISOString()}`);

  await new DailyLoopRunner(config, auth, refs, virtualClock, logger).run();
}

main().catch((err: unknown) => {
  console.error(`[RT:${new Date().toISOString()} | FATAL]`, err);
  process.exit(1);
});
