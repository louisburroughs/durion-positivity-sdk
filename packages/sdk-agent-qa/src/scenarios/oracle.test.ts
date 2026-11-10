import type { CallRecord } from '../ledger/CallLedger';
import { judge } from './oracle';
import { expectationSchema, type ExpectationInput } from './types';

const record = (operationId: string, status: number | undefined, kind?: CallRecord['kind']): CallRecord => ({
  at: '2026-03-10T15:00:00Z',
  runId: 'r',
  scenarioId: 's',
  operationId,
  pkg: operationId.split('.')[0],
  persona: 'advisor',
  kind: kind ?? (status === undefined ? 'transport-error' : status < 400 ? 'success' : 'http-error'),
  status,
  httpMethod: 'GET',
  durationMs: 5,
  source: 'agent',
});

const scenario = (...expect: ExpectationInput[]) => ({ expect: expect.map((entry) => expectationSchema.parse(entry)) });
const FINISHED = { status: 'finished' as const };
const COMPLETED = { verdict: 'completed' as const, summary: 'ok', findings: [] };

describe('judge', () => {
  it('passes when the loop finished and every expectation is visible in the ledger', () => {
    const judgement = judge(
      scenario({ kind: 'call', operation: 'a.Api.list', outcome: 'success' }, { kind: 'http', statuses: [404], min: 2 }, { kind: 'calls', min: 3 }),
      [record('a.Api.list', 200), record('a.Api.get', 404), record('b.Api.get', 404)],
      FINISHED,
      COMPLETED,
    );
    expect(judgement).toMatchObject({ verdict: 'passed', reasons: [] });
  });

  it('fails on any 5xx, whatever else is true, and names the call', () => {
    const failing = { ...record('a.Api.create', 500), errorCode: 'INTERNAL_ERROR', correlationId: 'corr-1' };
    const judgement = judge(scenario({ kind: 'calls', min: 1 }), [record('a.Api.list', 200), failing], FINISHED, COMPLETED);
    expect(judgement.verdict).toBe('failed');
    expect(judgement.reasons).toEqual(['a.Api.create answered 500 INTERNAL_ERROR (correlation corr-1)']);
    expect(judgement.serverErrors).toHaveLength(1);
  });

  it('fails when the SDK could not decode a successful response: the contract has drifted', () => {
    const judgement = judge(scenario(), [record('a.Api.list', 200, 'decode-error')], FINISHED, COMPLETED);
    expect(judgement).toMatchObject({ verdict: 'failed', reasons: ['a.Api.list answered 200 with a body the SDK could not decode'] });
  });

  it('does not treat a 4xx as a failure: it is the system answering', () => {
    expect(judge(scenario({ kind: 'call', operation: 'a.Api.close' }), [record('a.Api.close', 409)], FINISHED, COMPLETED).verdict).toBe('passed');
  });

  it('is inconclusive, not failed, when an expected call was never made or never succeeded', () => {
    const never = judge(scenario({ kind: 'call', operation: 'a.Api.create' }), [record('a.Api.list', 200)], FINISHED, COMPLETED);
    expect(never).toMatchObject({ verdict: 'inconclusive', reasons: ['expectation not met — a.Api.create (any): never called'] });
    const refused = judge(scenario({ kind: 'call', operation: 'a.Api.create', outcome: 'success' }), [record('a.Api.create', 422)], FINISHED, COMPLETED);
    expect(refused.verdict).toBe('inconclusive');
  });

  it('is inconclusive when the agent did not finish', () => {
    const judgement = judge(scenario(), [record('a.Api.list', 200)], { status: 'max-steps', detail: 'reached 30 steps' }, undefined);
    expect(judgement).toMatchObject({ verdict: 'inconclusive', reasons: ['the agent did not finish: max-steps (reached 30 steps)'] });
  });

  it('reports infra when calls were made and none reached the backend', () => {
    const judgement = judge(scenario({ kind: 'calls', min: 1 }), [record('a.Api.list', undefined), record('a.Api.get', undefined)], FINISHED, COMPLETED);
    expect(judgement.verdict).toBe('infra');
  });

  it('does not count a transport error or a client-side refusal as a call', () => {
    const judgement = judge(
      scenario({ kind: 'call', operation: 'a.Api.list' }),
      [record('a.Api.list', undefined, 'client-error'), record('b.Api.list', 200)],
      FINISHED,
      COMPLETED,
    );
    expect(judgement.verdict).toBe('inconclusive');
  });

  it('checks the sweep by how many of its targets were reached', () => {
    const reach = scenario({ kind: 'reach', operations: ['a.A.x', 'a.A.y', 'b.B.z', 'c.C.w', 'd.D.v'], ratio: 0.6 });
    expect(judge(reach, [record('a.A.x', 200), record('a.A.y', 404), record('b.B.z', 403)], FINISHED, COMPLETED).verdict).toBe('passed');
    expect(judge(reach, [record('a.A.x', 200), record('a.A.y', 404)], FINISHED, COMPLETED).verdict).toBe('inconclusive');
  });

  it('keeps the verdict from the ledger when the agent itself is unsure, and records its reservation', () => {
    const judgement = judge(scenario({ kind: 'calls', min: 1 }), [record('a.Api.list', 200)], FINISHED, { verdict: 'blocked', summary: 'no open session', findings: [] });
    expect(judgement).toMatchObject({ verdict: 'passed', reasons: ['agent reported "blocked": no open session'] });
  });
});
