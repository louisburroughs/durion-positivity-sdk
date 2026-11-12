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
import { carriedVisits } from '../day/carryOver';
import { DayPlanStore } from '../day/DayPlanStore';
import { surveySites } from '../day/sites';
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
    const slots = planDay([...this.scenariosFor(day), SWEEP_SCHEDULE, ...stages], clock, lastRuns, {
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

  /** Today's plan — the tenant's sites and their customers — once it has been made. */
  private dayStore(clock: LocalClock): DayPlanStore | undefined {
    if (!this.options.config.runDays.includes(clock.weekday)) {
      return undefined;
    }
    return DayPlanStore.load(this.dayDir(clock), clock.date);
  }

  /**
   * Makes today's plan if there is none yet: asks the tenant which shops are
   * open for work and gives each its roster. This is the one step that needs
   * the backend before anything is scheduled, because the day's shape is the
   * tenant's, not the harness's.
   */
  async prepareDay(): Promise<DayPlanStore | undefined> {
    const { config, catalog, invoker, backend } = this.options;
    const clock = this.clock();
    if (!config.runDays.includes(clock.weekday)) {
      return undefined;
    }
    const existing = this.dayStore(clock);
    if (existing) {
      return existing;
    }
    await backend.preflight(this.log);
    const sites = await surveySites(invoker, catalog, 'admin');
    const carried = carriedVisits(path.join(config.stateDir, 'runs'), clock.date, config.day);
    const day = DayPlanStore.create(this.dayDir(clock), clock.date, sites, config.day, carried);
    if (carried.length > 0) {
      this.log(`${clock.date}: ${carried.length} job(s) carried over, waiting on a part delivery today`);
    }
    this.log(
      `${clock.date}: ${sites.length} site(s) — ` +
        (sites.map((site) => `${site.name} (${day.plan.visits.filter((visit) => visit.site.id === site.id && !visit.carriedFrom).length} new visits)`).join(', ') ||
          'no active location has a bay or mobile unit'),
    );
    return day;
  }

  /**
   * The staff routines as they run today: a routine every shop does for itself
   * becomes one task per site, each told where it is. Until the day's sites are
   * known, per-site routines are simply not there yet.
   */
  private scenariosFor(day: DayPlanStore | undefined): Scenario[] {
    // Settings a routine's brief quotes are filled in here, so the library stays plain text.
    const fill = (goal: string): string =>
      goal.replace(/\{\{bankOpeningBalance\}\}/g, this.options.config.bankOpeningBalance.toFixed(2));
    return this.scenarios.flatMap((entry) => {
      const scenario = { ...entry, goal: fill(entry.goal) };
      if (!scenario.perSite) {
        return [scenario];
      }
      return (day?.plan.sites ?? []).map((site) => ({
        ...scenario,
        id: `${scenario.id}-${site.slug}`,
        title: `${scenario.title} — ${site.name}`,
        goal:
          `You work at the ${site.name} shop (location id ${site.id}, code ${site.code}). Everything in this task is about ` +
          `that location; do not pick another.\n\n${scenario.goal}`,
      }));
    });
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
      // One of each for the whole pass: tasks running side by side must write through the same
      // objects, or the last to save would erase what the others recorded.
      const coverage = CoverageStore.open(config.stateDir, this.now());
      const day = this.dayStore(clock);
      const scenarios = this.scenariosFor(day);
      let backendDown = false;

      const runOne = async (id: string): Promise<void> => {
        if (backendDown) {
          return;
        }
        let scenario = scenarios.find((entry) => entry.id === id);
        let backstop = false;
        if (id === SWEEP_SCENARIO_ID) {
          ({ scenario, backstop } = this.buildSweep(coverage, clock));
          if (!scenario && !backstop) {
            this.log(`${id}: nothing left to cover this month`);
            this.state.markRun(id, { date: clock.date, week: clock.week, month: clock.month, at: this.now().toISOString(), verdict: 'passed' });
            return;
          }
          // Backstop days with an empty agent quota still need a scenario to hang the probes on.
          scenario ??= sweepScenario(
            sweepTargets({ catalog, coverage, invoker, policy: config.policy, level: config.coverageLevel, quota: 1, writes: false }),
          );
        }
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
          return;
        }
        const task = scenario;

        this.log(`▶ ${task.id} (${task.cadence}, as ${task.persona})`);
        const result = await runScenario(task, {
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
          // Tasks run side by side, so every line says whose it is.
          log: (message) => this.log(`${task.id} ${message.trimStart()}`),
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
                this.log(`${task.id} backstop: probed ${probed.length}, could not probe ${unreachable.length}`);
              }
            : undefined,
        });
        coverage.save();
        day?.save();
        results.push(result);
        this.log(`■ ${task.id}: ${result.verdict}${result.reasons.length > 0 ? ` — ${result.reasons[0]}` : ''}`);

        // An infra verdict means nothing answered; leave the slot unmarked so it is retried once the backend is back.
        if (result.verdict === 'infra') {
          if (!backendDown) {
            this.log('backend not answering; starting nothing more this pass');
          }
          backendDown = true;
        } else {
          this.state.markRun(task.id, {
            date: clock.date,
            week: clock.week,
            month: clock.month,
            at: result.finishedAt,
            verdict: result.verdict,
          });
        }
        this.writeReport(clock);
      };

      // A tenant's shops work at the same time, so tasks do too: up to `concurrency` at once.
      const queue = [...ids];
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          await runOne(id);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(config.concurrency, ids.length)) }, worker));
    } finally {
      environmentLock.release();
    }
    return results.sort((a, b) => ids.indexOf(a.scenarioId) - ids.indexOf(b.scenarioId));
  }

  private writeReport(clock: LocalClock): string {
    const dayDir = this.dayDir(clock);
    const file = path.join(dayDir, 'report.md');
    fs.mkdirSync(dayDir, { recursive: true });
    const plan = this.dayStore(clock)?.plan;
    fs.writeFileSync(
      file,
      renderReport(clock.date, readDayResults(dayDir), this.coverageSummary(), plan?.visits ?? [], plan?.sites ?? []),
      'utf8',
    );
    return file;
  }

  reportPath(): string {
    return path.join(this.dayDir(this.clock()), 'report.md');
  }

  /** Runs every scenario whose time has come and that has not run. Safe to call as often as you like. */
  async tick(): Promise<TickResult> {
    const { config } = this.options;
    await this.prepareDay();
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
    await this.prepareDay();
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
    const day = this.dayStore(this.clock());
    const stages = (day?.plan.visits ?? []).flatMap((visit) => visit.stages.map((stage) => stage.id));
    return [...this.scenariosFor(day).map((scenario) => scenario.id), SWEEP_SCENARIO_ID, ...stages];
  }
}
