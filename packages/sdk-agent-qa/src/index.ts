/**
 * Agent QA harness — command line.
 *
 *   npm run qa -- plan                 what today looks like, and what is due now
 *   npm run qa -- tick                 run whatever is due, then exit   (for cron / Task Scheduler / CI)
 *   npm run qa -- daemon               stay up and run each scenario at its time of day
 *   npm run qa -- run <id> [<id>…]     run scenarios now, ignoring the schedule
 *   npm run qa -- coverage             this month's SDK coverage
 *   npm run qa -- catalog [words…]     search the tool catalog
 *   npm run qa -- doctor               check configuration, models and the backend
 *
 * `tick` and `daemon` share one state directory and one lock, so they can be
 * mixed freely: a tick that finds the daemon mid-run does nothing.
 *
 * Exit codes: 0 ok · 1 a scenario found a server error · 2 the backend did not
 * answer · 64 usage or configuration error.
 */
import { AiSdkModel, modelChainProblems, parseModelChain } from './agent/aiSdkModel';
import type { ModelPort } from './agent/loop';
import { BackendSession } from './backend/BackendSession';
import { buildCatalog } from './catalog/buildCatalog';
import { loadQaConfig, type QaConfig } from './config';
import { Harness, type TickResult } from './runner/Harness';
import { formatMinutes } from './schedule/planner';
import { SdkInvoker } from './sdk/SdkInvoker';

const log = (message: string): void => console.log(`[qa] ${message}`);

/** Stands in when no model is configured, so the model-free paths (backstop, plan, coverage) still work. */
const noModel: ModelPort = {
  generate: async () => {
    throw new Error('no model configured (set QA_MODELS)');
  },
};

function buildModel(config: QaConfig, required: boolean): ModelPort {
  const chain = parseModelChain(config.modelChain);
  const problems = modelChainProblems(chain, process.env);
  if (problems.length > 0) {
    if (required) {
      throw new Error(`Model configuration is invalid:\n  - ${problems.join('\n  - ')}`);
    }
    return noModel;
  }
  return new AiSdkModel({ chain, temperature: config.temperature, maxOutputTokens: config.maxOutputTokens, log });
}

function build(options: { modelRequired: boolean }): { harness: Harness; config: QaConfig; backend: BackendSession } {
  const backend = BackendSession.fromEnvironment(log);
  const config = loadQaConfig(process.env, backend.baseUrl);
  const catalog = buildCatalog();
  const invoker = new SdkInvoker({
    baseUrlFor: (pkg) => config.baseUrlFor(pkg),
    tokenFor: (persona) => backend.tokenFor(persona),
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const harness = new Harness({ config, catalog, invoker, backend, model: buildModel(config, options.modelRequired), log });
  return { harness, config, backend };
}

function exitCodeFor(result: TickResult): number {
  if (result.results.some((entry) => entry.verdict === 'failed')) {
    return 1;
  }
  return result.results.some((entry) => entry.verdict === 'infra') ? 2 : 0;
}

function printPlan(harness: Harness): void {
  const { clock, slots } = harness.plan();
  console.log(`${clock.date} (ISO weekday ${clock.weekday}, week ${clock.week}) — now ${formatMinutes(clock.minutes)} shop time`);
  for (const slot of slots.filter((entry) => entry.status !== 'not-today')) {
    const detail = /-v\d+-/.test(slot.scenario.id) ? `  (${slot.scenario.title})` : '';
    console.log(`  ${formatMinutes(slot.minutes)}  ${slot.status.padEnd(8)}  ${slot.scenario.cadence.padEnd(7)}  ${slot.scenario.id}${detail}`);
  }
}

function printCoverage(harness: Harness): void {
  const summary = harness.coverageSummary();
  console.log(`${summary.month}: ${summary.unitsCalled}/${summary.unitsTotal} ${summary.level}s called`);
  for (const pkg of summary.packages) {
    const note = pkg.reachable ? '' : '  (not routed; set QA_SERVICE_URL_… to reach it)';
    console.log(`  ${pkg.pkg.padEnd(18)} ${String(pkg.operationsCalled).padStart(4)}/${String(pkg.operations).padEnd(4)} operations  ${pkg.apisCalled}/${pkg.apis} APIs${note}`);
  }
  if (summary.missing.length > 0) {
    console.log(`not yet called: ${summary.missing.slice(0, 30).join(', ')}${summary.missing.length > 30 ? ', …' : ''}`);
  }
}

async function daemon(harness: Harness, config: QaConfig): Promise<number> {
  log(`daemon started; checking every ${config.pollSeconds}s (${config.timezone}). Ctrl-C to stop.`);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    log('stopping after the current scenario…');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let announced = '';
  while (!stopping) {
    try {
      const { clock, slots } = harness.plan();
      const next = slots.find((slot) => slot.status === 'upcoming');
      const banner = `${clock.date}:${next?.scenario.id ?? 'none'}`;
      if (banner !== announced) {
        log(next ? `next: ${next.scenario.id} at ${formatMinutes(next.minutes)}` : `nothing more scheduled for ${clock.date}`);
        announced = banner;
      }
      const result = await harness.tick();
      if (result.status === 'ran') {
        log(`report: ${harness.reportPath()}`);
      }
    } catch (error) {
      // A daemon outlives a dropped connection or a restarted stack: say what happened and try again next poll.
      log(`pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (let waited = 0; waited < config.pollSeconds && !stopping; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return 0;
}

async function doctor(): Promise<number> {
  let failures = 0;
  const check = async (name: string, action: () => Promise<string> | string): Promise<void> => {
    try {
      console.log(`ok    ${name}: ${await action()}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let backend: BackendSession | undefined;
  let config: QaConfig | undefined;
  await check('catalog', () => {
    const catalog = buildCatalog();
    return `${catalog.operations.length} operations in ${catalog.packages.length} packages`;
  });
  await check('backend credentials (ITEST_*)', () => {
    backend = BackendSession.fromEnvironment();
    return `${backend.roleMode ? 'role mode' : 'single-credential mode'}, tenant ${backend.tenantSlug}, ${backend.baseUrl}`;
  });
  await check('harness settings (QA_*)', () => {
    config = loadQaConfig(process.env, backend?.baseUrl ?? 'http://localhost:8080');
    return `${config.policy.mode}, coverage per ${config.coverageLevel}, ${config.timezone}, state in ${config.stateDir}`;
  });
  await check('models (QA_MODELS)', () => {
    const chain = parseModelChain(config?.modelChain ?? process.env['QA_MODELS'] ?? '');
    const problems = modelChainProblems(chain, process.env);
    if (problems.length > 0) {
      throw new Error(problems.join('; '));
    }
    return chain.map((ref) => `${ref.provider}:${ref.model}`).join(' → ');
  });
  await check('model answers', async () => {
    if (!config) {
      throw new Error('skipped: settings invalid');
    }
    const turn = await buildModel(config, true).generate({
      system: 'Reply with the single word: ready',
      messages: [{ role: 'user', content: 'Are you there?' }],
      tools: [],
      abortSignal: AbortSignal.timeout(60_000),
    });
    return `${turn.model} replied "${turn.text.trim().slice(0, 40)}"`;
  });
  await check('backend reachable and tenant bound', async () => {
    if (!backend) {
      throw new Error('skipped: credentials invalid');
    }
    const lines: string[] = [];
    await backend.preflight((message) => lines.push(message));
    return lines.join('; ') || 'ok';
  });
  return failures === 0 ? 0 : 64;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'plan': {
      const { harness } = build({ modelRequired: false });
      try {
        await harness.prepareDay();
      } catch (error) {
        // The day's shape comes from the tenant. Without it, show what can be known.
        log(`could not ask the tenant for its sites (${error instanceof Error ? error.message : String(error)}); showing tenant-wide tasks only`);
      }
      printPlan(harness);
      return 0;
    }
    case 'coverage':
      printCoverage(build({ modelRequired: false }).harness);
      return 0;
    case 'catalog': {
      const terms = rest.map((term) => term.toLowerCase());
      const matches = buildCatalog().operations.filter((operation) =>
        terms.every((term) => `${operation.id} ${operation.summary} ${operation.path}`.toLowerCase().includes(term)),
      );
      for (const operation of matches.slice(0, 200)) {
        console.log(`${operation.risk.padEnd(11)} ${operation.id}  —  ${operation.http} ${operation.path}`);
      }
      console.log(`${matches.length} operations`);
      return 0;
    }
    case 'tick': {
      const { harness } = build({ modelRequired: false });
      const result = await harness.tick();
      log(result.status === 'ran' ? `ran ${result.results.length} scenario(s); report: ${harness.reportPath()}` : `nothing run (${result.status})`);
      return exitCodeFor(result);
    }
    case 'run': {
      if (rest.length === 0) {
        console.error('usage: qa run <scenario-id> [<scenario-id>…]');
        return 64;
      }
      const { harness } = build({ modelRequired: true });
      const unknown = rest.filter((id) => !harness.scenarioIds().includes(id));
      if (unknown.length > 0) {
        console.error(`unknown scenario(s): ${unknown.join(', ')}\navailable: ${harness.scenarioIds().join(', ')}`);
        return 64;
      }
      const result = await harness.runNow(rest);
      log(result.status === 'ran' ? `report: ${harness.reportPath()}` : 'another run is in progress');
      return exitCodeFor(result);
    }
    case 'daemon': {
      const { harness, config } = build({ modelRequired: true });
      return daemon(harness, config);
    }
    case 'doctor':
      return doctor();
    default:
      console.error('usage: qa <plan | tick | daemon | run <id>… | coverage | catalog [words…] | doctor>');
      return 64;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    // The preflight's "cannot reach the backend" is the backend not answering, not a usage error.
    process.exitCode = /cannot reach the backend/.test(message) ? 2 : 64;
  },
);
