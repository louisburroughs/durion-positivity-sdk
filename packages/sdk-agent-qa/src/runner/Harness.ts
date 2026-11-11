/**
 * Wires the pieces together and exposes the three things a launcher needs:
 * what is planned ({@link Harness.plan}), run what is due ({@link Harness.tick})
 * and run something now ({@link Harness.runNow}).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ModelPort } from '../agent/loop';
import type { Catalog } from '../catalog/types';
import type { QaConfig } from '../config';
import { describeVisit } from '../day/dayPlan';
import { DayPlanStore } from '../day/DayPlanStore';
import { harvestFacts, missingPrerequisite, stageScenario } from '../day/visitScenarios';
import { CoverageStore, sweepQuota, type CoverageSummary } from '../sdk-coverage/CoverageStore';
import { CallLedger } from '../ledger/CallLedger';
import { SCENARIOS, SWEEP_SCENARIO_ID, SWEEP_SLOT } from '../scenarios/library';
import type { Scenario } from '../scenarios/types';
import { formatMinutes, localClock, planDay, runDaysLeftInMonth, type LocalClock, type PlannedSlot, type Schedulable } from '../schedule/planner';
import { RunLock, RunState } from '../schedule/state';
import type { SdkInvoker } from '../sdk/SdkInvoker';
import { readDayResults, renderReport } from './report';
import { runScenario, type ScenarioResult } from './runScenario';
import { runBackstop, sweepScenario, sweepTargets } from './sweep';

/** The part of the backend session the harness needs; narrowed so tests can supply a fake. */
export interface BackendPort {
  readonly roleMode: boolean;
  readonly personas: readonly string[];
  readonly tenantSlug: string;
  preflight(log: (message: string) => void): Promise<void>;
  holdEnvironmentLock(runId: string): { release(): void };
}

export interface HarnessOptions {
  config: QaConfig;
  catalog: Catalog;
  invoker: SdkInvoker;
  backend: BackendPort;
  model: ModelPort;
  scenarios?: readonly Scenario[];
  log?(message: string): void;
  now?: () => Date;
  /** Pause used by the agent's `wait` tool; tests replace it. */
  sleep?(ms: number): Promise<void>;
}

const SWEEP_SCHEDULE: Schedulable = {
  id: SWEEP_SCENARIO_ID,
  title: 'Coverage sweep: operations not yet called this month',
  cadence: 'daily',
  at: SWEEP_SLOT,
};

export interface TickResult {
  /**
   * `idle`: nothing was due. `spacing`: something is due but the last scenario
   * ended too recently. `busy`: another process holds the run lock. `closed`:
   * not a run day.
   */
  status: 'ran' | 'idle' | 'spacing' | 'busy' | 'closed';
  results: ScenarioResult[];
}

export class Harness {
  private readonly scenarios: readonly Scenario[];
  private readonly state: RunState;
  private readonly lock: RunLock;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: HarnessOptions) {
    this.scenarios = options.scenarios ?? SCENARIOS;
    this.state = new RunState(options.config.stateDir);
    this.lock = new RunLock(options.config.stateDir);
    this.log = options.log ?? ((message) => console.log(`[qa] ${message}`));
    this.now = options.now ?? (() => new Date());
  }

  private clock(): LocalClock {
    return localClock(this.now(), this.options.config.timezone);
  }

  plan(): { clock: LocalClock; slots: PlannedSlot[] } {
    const { config } = this.options;
    const clock = this.clock();
    this.state.reload();
    const lastRuns = this.state.lastRuns();
    const day = this.dayStore(clock);
    const stages: Schedulable[] = (day?.plan.visits ?? []).flatMap((visit) =>
      visit.stages.map((stage) => ({ id: stage.id, title: describeVisit(visit), cadence: 'daily' as const, at: stage.at })),
    );
    const slots = planDay([...this.scenarios, SWEEP_SCHEDULE, ...stages], clock, lastRuns, {
      runDays: config.runDays,
      jitterMinutes: config.jitterMinutes,
      maxLatenessMinutes: config.maxLatenessMinutes,
    });
    // A visit happens in order: the job cannot go on the floor before the customer has been seen.
    for (const slot of slots) {
      const found = day?.find(slot.scenario.id);
      if (found && found.index > 0 && slot.status === 'due') {
        const previous = found.visit.stages[found.index - 1];
        if (lastRuns[previous.id]?.date !== clock.date) {
          slot.status = 'upcoming';
        }
      }
    }
    return { clock, slots };
  }

  /** Today's customers, or undefined when the shop is closed or visits are turned off. */
  private dayStore(clock: LocalClock): DayPlanStore | undefined {
    const { config } = this.options;
    if (config.day.visitsMax === 0 || !config.runDays.includes(clock.weekday)) {
      return undefined;
    }
    return DayPlanStore.open(this.dayDir(clock), clock.date, config.day);
  }

  coverageSummary(): CoverageSummary {
    const { config, catalog, invoker } = this.options;
    return CoverageStore.open(config.stateDir, this.now()).summary(catalog, config.coverageLevel, (pkg) => invoker.isReachable(pkg));
  }

  private dayDir(clock: LocalClock): string {
    return path.join(this.options.config.stateDir, 'runs', clock.date);
  }

  /** Today's sweep, sized so the month finishes covered; with the backstop attached near month end. */
  private buildSweep(coverage: CoverageStore, clock: LocalClock): { scenario: Scenario | undefined; backstop: boolean } {
    const { config, catalog, invoker } = this.options;
    const summary = coverage.summary(catalog, config.coverageLevel, (pkg) => invoker.isReachable(pkg));
    const daysLeft = runDaysLeftInMonth(clock, config.runDays);
    const quota = sweepQuota(summary.missing.length, daysLeft, config.sweepMax);
    const targets = sweepTargets({
      catalog,
      coverage,
      invoker,
      policy: config.policy,
      level: config.coverageLevel,
      quota,
      writes: config.sweepWrites,
    });
    return { scenario: sweepScenario(targets), backstop: summary.missing.length > 0 && daysLeft <= config.backstopDays };
  }

  private async execute(ids: readonly string[], clock: LocalClock): Promise<ScenarioResult[]> {
    const { config, catalog, invoker, backend, model } = this.options;
    const runId = `qa-${clock.date}-${this.now().toISOString().slice(11, 19).replace(/:/g, '')}`;
    const dayDir = this.dayDir(clock);
    fs.mkdirSync(dayDir, { recursive: true });

    await backend.preflight(this.log);
    const environmentLock = backend.holdEnvironmentLock(runId);
    const results: ScenarioResult[] = [];
    try {
      const ledger = new CallLedger(path.join(dayDir, 'calls.jsonl'));
      for (const id of ids) {
        // Re-opened per scenario: the month can roll over mid-run, and another process may have written.
        const coverage = CoverageStore.open(config.stateDir, this.now());
        let scenario = this.scenarios.find((entry) => entry.id === id);
        let backstop = false;
        if (id === SWEEP_SCENARIO_ID) {
          ({ scenario, backstop } = this.buildSweep(coverage, clock));
          if (!scenario && !backstop) {
            this.log(`${id}: nothing left to cover this month`);
            this.state.markRun(id, { date: clock.date, week: clock.week, month: clock.month, at: this.now().toISOString(), verdict: 'passed' });
            continue;
          }
          // Backstop days with an empty agent quota still need a scenario to hang the probes on.
          scenario ??= sweepScenario(
            sweepTargets({ catalog, coverage, invoker, policy: config.policy, level: config.coverageLevel, quota: 1, writes: false }),
          );
        }
        const day = this.dayStore(clock);
        const stage = day?.find(id);
        let memory: Record<string, string> | undefined;
        let skipReason: string | undefined;
        if (day && stage) {
          memory = day.memoryOf(stage.visit.id);
          scenario = stageScenario(stage.visit, stage.stage, memory, { roleMode: backend.roleMode });
          skipReason = missingPrerequisite(stage.stage, memory);
        }
        if (!scenario) {
          this.log(`${id}: no such scenario`);
          continue;
        }

        this.log(`▶ ${scenario.id} (${scenario.cadence}, as ${scenario.persona})`);
        const result = await runScenario(scenario, {
          catalog,
          invoker,
          ledger,
          coverage,
          policy: config.policy,
          model,
          limits: config.limits,
          personas: backend.personas,
          roleMode: backend.roleMode,
          runId,
          prompt: {
            tenantSlug: backend.tenantSlug,
            date: clock.date,
            time: formatMinutes(this.clock().minutes),
            timeZone: config.timezone,
            runTag: runId,
          },
          artifactsDir: dayDir,
          log: this.log,
          now: this.now,
          memory,
          skipReason,
          sleep: this.options.sleep,
          // Ids are taken from the responses that create them, and saved at once: a stage that
          // dies halfway must still leave the next one what it had established.
          onCall: memory
            ? (operation, outcome) => {
                harvestFacts(operation, outcome, memory);
                day?.save();
              }
            : undefined,
          afterAgent: backstop
            ? async (runtime) => {
                const { probed, unreachable } = await runBackstop(runtime, {
                  catalog,
                  coverage,
                  invoker,
                  policy: config.policy,
                  level: config.coverageLevel,
                });
                this.log(`  backstop: probed ${probed.length}, could not probe ${unreachable.length}`);
              }
            : undefined,
        });
        coverage.save();
        day?.save();
        results.push(result);
        this.log(`■ ${scenario.id}: ${result.verdict}${result.reasons.length > 0 ? ` — ${result.reasons[0]}` : ''}`);

        // An infra verdict means nothing answered; leave the slot unmarked so it is retried once the backend is back.
        if (result.verdict !== 'infra') {
          this.state.markRun(scenario.id, {
            date: clock.date,
            week: clock.week,
            month: clock.month,
            at: result.finishedAt,
            verdict: result.verdict,
          });
        }
        this.writeReport(clock);
        if (result.verdict === 'infra') {
          this.log('backend not answering; stopping this pass');
          break;
        }
      }
    } finally {
      environmentLock.release();
    }
    return results;
  }

  private writeReport(clock: LocalClock): string {
    const dayDir = this.dayDir(clock);
    const file = path.join(dayDir, 'report.md');
    fs.mkdirSync(dayDir, { recursive: true });
    const visits = this.dayStore(clock)?.plan.visits ?? [];
    fs.writeFileSync(file, renderReport(clock.date, readDayResults(dayDir), this.coverageSummary(), visits), 'utf8');
    return file;
  }

  reportPath(): string {
    return path.join(this.dayDir(this.clock()), 'report.md');
  }

  /** Runs every scenario whose time has come and that has not run. Safe to call as often as you like. */
  async tick(): Promise<TickResult> {
    const { config } = this.options;
    const { clock, slots } = this.plan();
    if (!config.runDays.includes(clock.weekday)) {
      return { status: 'closed', results: [] };
    }
    // Time-of-day work first: a daily slot goes stale, a weekly or monthly one can wait for the next pass.
    const order = { daily: 0, weekly: 1, monthly: 2 } as const;
    const due = slots
      .filter((slot) => slot.status === 'due')
      .sort((a, b) => order[a.scenario.cadence] - order[b.scenario.cadence] || a.minutes - b.minutes)
      .slice(0, config.maxPerTick)
      .map((slot) => slot.scenario.id);
    if (due.length === 0) {
      return { status: 'idle', results: [] };
    }
    const lastFinished = Math.max(0, ...Object.values(this.state.lastRuns()).map((run) => (run ? Date.parse(run.at) : 0)));
    if (this.now().getTime() - lastFinished < config.minGapMinutes * 60_000) {
      return { status: 'spacing', results: [] };
    }
    if (!this.lock.tryAcquire(this.now())) {
      return { status: 'busy', results: [] };
    }
    try {
      return { status: 'ran', results: await this.execute(due, clock) };
    } finally {
      this.lock.release();
    }
  }

  /** Runs the named scenarios now, whatever the schedule says. */
  async runNow(ids: readonly string[]): Promise<TickResult> {
    if (!this.lock.tryAcquire(this.now())) {
      return { status: 'busy', results: [] };
    }
    try {
      return { status: 'ran', results: await this.execute(ids, this.clock()) };
    } finally {
      this.lock.release();
    }
  }

  scenarioIds(): string[] {
    const stages = (this.dayStore(this.clock())?.plan.visits ?? []).flatMap((visit) => visit.stages.map((stage) => stage.id));
    return [...this.scenarios.map((scenario) => scenario.id), SWEEP_SCENARIO_ID, ...stages];
  }
}
