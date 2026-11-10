/**
 * Runs one scenario: builds its tools, drives the loop, judges the result from
 * the ledger and writes the artifacts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runLoop, type LoopEvent, type LoopLimits, type LoopResult, type ModelPort } from '../agent/loop';
import type { Catalog } from '../catalog/types';
import type { CoverageStore } from '../sdk-coverage/CoverageStore';
import type { CallLedger, CallRecord } from '../ledger/CallLedger';
import { judge, type ExpectationResult, type Verdict } from '../scenarios/oracle';
import type { Scenario } from '../scenarios/types';
import type { SdkInvoker } from '../sdk/SdkInvoker';
import { ToolRuntime, type FinishReport, type SafetyPolicy } from '../tools/toolkit';
import { systemPrompt, taskPrompt, type PromptContext } from './prompt';

export interface ScenarioResult {
  scenarioId: string;
  title: string;
  cadence: Scenario['cadence'];
  kind: Scenario['kind'];
  persona: string;
  startedAt: string;
  finishedAt: string;
  verdict: Verdict;
  reasons: string[];
  expectations: Array<Pick<ExpectationResult, 'met' | 'detail'>>;
  loop?: Pick<LoopResult, 'status' | 'detail' | 'steps' | 'toolCalls' | 'usage' | 'models'>;
  finish?: FinishReport;
  /** HTTP status (or outcome kind when no response arrived) → number of calls. */
  callsByStatus: Record<string, number>;
  packages: string[];
  serverErrors: Array<Pick<CallRecord, 'operationId' | 'status' | 'errorCode' | 'correlationId' | 'requestPath'>>;
}

export interface ScenarioDeps {
  catalog: Catalog;
  invoker: SdkInvoker;
  ledger: CallLedger;
  coverage: CoverageStore;
  policy: SafetyPolicy;
  model: ModelPort;
  limits: LoopLimits & { maxCalls: number };
  personas: readonly string[];
  roleMode: boolean;
  runId: string;
  prompt: Omit<PromptContext, 'personas' | 'roleMode'>;
  /** Directory for this scenario's transcript, or undefined to write none. */
  artifactsDir?: string;
  log(message: string): void;
  now?: () => Date;
  /** Runs after the agent, with the same tool runtime — the coverage backstop hooks in here. */
  afterAgent?(runtime: ToolRuntime): Promise<void>;
}

function summarize(calls: readonly CallRecord[]): Pick<ScenarioResult, 'callsByStatus' | 'packages'> {
  const callsByStatus: Record<string, number> = {};
  for (const call of calls) {
    const key = call.kind === 'decode-error' ? `${call.status} undecodable` : call.status !== undefined ? String(call.status) : call.kind;
    callsByStatus[key] = (callsByStatus[key] ?? 0) + 1;
  }
  return { callsByStatus, packages: [...new Set(calls.map((call) => call.pkg))].sort() };
}

export async function runScenario(scenario: Scenario, deps: ScenarioDeps): Promise<ScenarioResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const base = {
    scenarioId: scenario.id,
    title: scenario.title,
    cadence: scenario.cadence,
    kind: scenario.kind,
    persona: scenario.persona,
    startedAt: startedAt.toISOString(),
  };

  if (scenario.requiresRoleMode && !deps.roleMode) {
    return {
      ...base,
      finishedAt: now().toISOString(),
      verdict: 'skipped',
      reasons: ['needs per-persona logins (ITEST_<PERSONA>_USERNAME/_PASSWORD); every persona currently shares the admin login'],
      expectations: [],
      callsByStatus: {},
      packages: [],
      serverErrors: [],
    };
  }

  const runtime = new ToolRuntime({
    catalog: deps.catalog,
    invoker: deps.invoker,
    ledger: deps.ledger,
    coverage: deps.coverage,
    policy: deps.policy,
    runId: deps.runId,
    scenarioId: scenario.id,
    persona: scenario.persona,
    personas: deps.personas,
    pinned: scenario.operations,
    allowUnvalidated: scenario.kind === 'error',
    maxCalls: scenario.limits.maxCalls ?? deps.limits.maxCalls,
    now,
  });

  const stamp = startedAt.toISOString().slice(11, 16).replace(':', '');
  const transcript = deps.artifactsDir ? path.join(deps.artifactsDir, `${stamp}-${scenario.id}.transcript.jsonl`) : undefined;
  if (deps.artifactsDir) {
    fs.mkdirSync(deps.artifactsDir, { recursive: true });
  }
  const onEvent = (event: LoopEvent): void => {
    if (transcript) {
      fs.appendFileSync(transcript, `${JSON.stringify(event)}\n`, 'utf8');
    }
    if (event.type === 'tool') {
      const output = event.output as { outcome?: string; status?: number; errorCode?: string } | undefined;
      const result = [output?.outcome, output?.status, output?.errorCode].filter((part) => part !== undefined).join(' ');
      deps.log(`  ${event.name}${result ? ` → ${result}` : ''}`);
    }
  };

  const loop = await runLoop({
    model: deps.model,
    system: systemPrompt(scenario, { ...deps.prompt, personas: deps.personas, roleMode: deps.roleMode }),
    prompt: taskPrompt(scenario),
    tools: runtime.tools(),
    finishTool: 'finish',
    limits: {
      maxSteps: scenario.limits.maxSteps ?? deps.limits.maxSteps,
      timeoutMs: scenario.limits.timeoutMs ?? deps.limits.timeoutMs,
      maxTokens: deps.limits.maxTokens,
    },
    onEvent,
  });

  if (deps.afterAgent) {
    await deps.afterAgent(runtime);
  }

  const calls = deps.ledger.forScenario(scenario.id).filter((call) => call.runId === deps.runId);
  const judgement = judge(scenario, calls, loop, runtime.finishReport);
  const result: ScenarioResult = {
    ...base,
    finishedAt: now().toISOString(),
    verdict: judgement.verdict,
    reasons: judgement.reasons,
    expectations: judgement.expectations.map(({ met, detail }) => ({ met, detail })),
    loop: {
      status: loop.status,
      detail: loop.detail,
      steps: loop.steps,
      toolCalls: loop.toolCalls,
      usage: loop.usage,
      models: loop.models,
    },
    finish: runtime.finishReport,
    ...summarize(calls),
    serverErrors: judgement.serverErrors.map(({ operationId, status, errorCode, correlationId, requestPath }) => ({
      operationId,
      status,
      errorCode,
      correlationId,
      requestPath,
    })),
  };
  if (deps.artifactsDir) {
    fs.writeFileSync(path.join(deps.artifactsDir, `${stamp}-${scenario.id}.json`), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}
