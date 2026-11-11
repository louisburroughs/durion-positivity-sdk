/**
 * Decides what a scenario run means, from the calls it made.
 *
 * The verdict separates three things a single pass/fail would blur:
 *
 * - `failed` — something is broken: a 5xx on any call (other than the
 *   backend's documented "still replicating, retry" 503s), or a 2xx whose body the
 *   SDK could not decode (the backend and the generated client disagree about
 *   the contract). This is the only verdict that says "there is a defect to
 *   look at".
 * - `inconclusive` — the agent did not get far enough to tell: it ran out of
 *   steps, the model errored, or an expected call was never made or never
 *   answered as expected. This is a harness or model problem until shown
 *   otherwise, and must not page anyone as a backend failure.
 * - `infra` — nothing answered: no route to the backend, or the stack is stopped.
 *
 * A scenario of kind `error` treats 4xx as the goal, and both kinds treat 4xx
 * as information: a 409 on a workorder that is already complete is the system
 * working. Only the expectations say which statuses a scenario needed to see.
 */
import type { LoopResult } from '../agent/loop';
import { reachedBackend, type CallRecord } from '../ledger/CallLedger';
import type { FinishReport } from '../tools/toolkit';
import type { Expectation, Scenario } from './types';

/**
 * 503s the backend uses to say "not yet", not "broken": a read model that has
 * not caught up with a record created moments ago. The integration suites
 * retry through exactly these (see retryWhileReplicating and
 * promoteWhenPromotable there), so the harness must not report them as defects.
 */
const TRANSIENT_CODE = /(_REPLICATION_PENDING|^CUSTOMER_REQUIREMENTS_UNAVAILABLE)$/;

export function isTransientUnavailable(call: Pick<CallRecord, 'status' | 'errorCode'>): boolean {
  return call.status === 503 && call.errorCode !== undefined && TRANSIENT_CODE.test(call.errorCode);
}

export type Verdict = 'passed' | 'failed' | 'inconclusive' | 'infra' | 'skipped';

export interface ExpectationResult {
  expectation: Expectation;
  met: boolean;
  detail: string;
}

export interface Judgement {
  verdict: Verdict;
  reasons: string[];
  expectations: ExpectationResult[];
  serverErrors: CallRecord[];
}

const isSuccess = (call: CallRecord): boolean => call.kind === 'success';

export function checkExpectation(expectation: Expectation, calls: readonly CallRecord[]): ExpectationResult {
  const answered = calls.filter(reachedBackend);
  switch (expectation.kind) {
    case 'call': {
      const matching = answered.filter((call) => call.operationId === expectation.operation);
      const met = expectation.outcome === 'success' ? matching.some(isSuccess) : matching.length > 0;
      const seen = matching.map((call) => call.status).join(', ') || 'never called';
      return { expectation, met, detail: `${expectation.operation} (${expectation.outcome}): ${seen}` };
    }
    case 'http': {
      const matching = answered.filter(
        (call) =>
          call.status !== undefined &&
          expectation.statuses.includes(call.status) &&
          (!expectation.operations || expectation.operations.includes(call.operationId)),
      );
      return {
        expectation,
        met: matching.length >= expectation.min,
        detail: `${matching.length}/${expectation.min} calls answered ${expectation.statuses.join('|')}`,
      };
    }
    case 'calls':
      return { expectation, met: answered.length >= expectation.min, detail: `${answered.length}/${expectation.min} calls answered` };
    case 'reach': {
      const called = new Set(answered.map((call) => call.operationId));
      const reached = expectation.operations.filter((operation) => called.has(operation)).length;
      const needed = Math.ceil(expectation.operations.length * expectation.ratio);
      return { expectation, met: reached >= needed, detail: `${reached}/${expectation.operations.length} target operations called (need ${needed})` };
    }
    default:
      return { expectation, met: false, detail: 'unknown expectation' };
  }
}

export function judge(
  scenario: Pick<Scenario, 'expect'>,
  calls: readonly CallRecord[],
  loop: Pick<LoopResult, 'status' | 'detail'>,
  finish: FinishReport | undefined,
): Judgement {
  const expectations = scenario.expect.map((expectation) => checkExpectation(expectation, calls));
  const serverErrors = calls.filter(
    (call) =>
      (call.status !== undefined && call.status >= 500 && !isTransientUnavailable(call)) || call.kind === 'decode-error',
  );
  const reasons: string[] = [];

  if (serverErrors.length > 0) {
    for (const call of serverErrors.slice(0, 10)) {
      reasons.push(
        (call.kind === 'decode-error'
          ? `${call.operationId} answered ${call.status} with a body the SDK could not decode`
          : `${call.operationId} answered ${call.status}${call.errorCode ? ` ${call.errorCode}` : ''}`) +
          (call.correlationId ? ` (correlation ${call.correlationId})` : ''),
      );
    }
    return { verdict: 'failed', reasons, expectations, serverErrors };
  }

  const answered = calls.filter(reachedBackend);
  if (calls.length > 0 && answered.length === 0) {
    reasons.push(`none of ${calls.length} calls reached the backend — is it reachable from here and is the stack running?`);
    return { verdict: 'infra', reasons, expectations, serverErrors };
  }

  if (loop.status !== 'finished') {
    reasons.push(`the agent did not finish: ${loop.status}${loop.detail ? ` (${loop.detail})` : ''}`);
  }
  for (const result of expectations.filter((entry) => !entry.met)) {
    reasons.push(`expectation not met — ${result.detail}`);
  }
  if (reasons.length === 0 && finish && finish.verdict !== 'completed') {
    // Every checkable fact holds, so the run counts; the agent's reservation is kept for the reader.
    reasons.push(`agent reported "${finish.verdict}": ${finish.summary}`);
    return { verdict: 'passed', reasons, expectations, serverErrors };
  }
  return { verdict: reasons.length === 0 ? 'passed' : 'inconclusive', reasons, expectations, serverErrors };
}
