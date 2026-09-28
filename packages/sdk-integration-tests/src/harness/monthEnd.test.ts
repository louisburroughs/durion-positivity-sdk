import { closeMonth, monthsToClose, periodCode, periodCodesBetween, reopenClosedPeriods, type PeriodPort } from './monthEnd';

const refusal = (status: number, code: string): Error =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: new Response(JSON.stringify({ code, status }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

const port = (periods: Array<{ periodCode: string; status: string }>, closeThrows?: Error) => {
  const reopened: Array<{ code: string; justification: string }> = [];
  const closed: string[] = [];
  const periodPort: PeriodPort = {
    list: async () => periods,
    close: async (code) => {
      if (closeThrows) {
        throw closeThrows;
      }
      closed.push(code);
    },
    reopen: async (code, justification) => {
      reopened.push({ code, justification });
    },
  };
  return { periodPort, reopened, closed };
};

describe('month-end periods', () => {
  it('keys months as YYYY-MM in UTC', () => {
    expect(periodCode(new Date('2025-10-31T23:59:59.999Z'))).toBe('2025-10');
    expect(periodCode(new Date('2025-11-01T00:00:00.000Z'))).toBe('2025-11');
  });

  it('walks months across a year end', () => {
    expect(periodCodesBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(periodCodesBetween('2026-02', '2025-11')).toEqual([]);
  });

  it('closes every month that has ended since the timeline began, and not the current one', () => {
    const start = new Date('2025-09-27T23:20:54Z');

    expect(monthsToClose(start, new Date('2025-09-30T08:00:00Z'), [])).toEqual([]);
    expect(monthsToClose(start, new Date('2025-12-01T07:00:00Z'), ['2025-09'])).toEqual(['2025-10', '2025-11']);
  });
});

describe('reopenClosedPeriods', () => {
  it('reopens only the closed months inside the timeline, naming the run', async () => {
    const { periodPort, reopened } = port([
      { periodCode: '2025-08', status: 'CLOSED' },
      { periodCode: '2025-10', status: 'CLOSED' },
      { periodCode: '2025-11', status: 'OPEN' },
      { periodCode: '2026-03', status: 'CLOSED' },
      { periodCode: '2026-10', status: 'CLOSED' },
    ]);

    const result = await reopenClosedPeriods(periodPort, { from: '2025-09', to: '2026-09', runId: 'accel-9' });

    expect(result).toEqual(['2025-10', '2026-03']);
    expect(reopened.map((entry) => entry.code)).toEqual(['2025-10', '2026-03']);
    expect(reopened[0].justification).toContain('accel-9');
  });

  it("leaves a resumed run's own closes closed", async () => {
    const { periodPort, reopened } = port([
      { periodCode: '2025-10', status: 'CLOSED' },
      { periodCode: '2025-11', status: 'CLOSED' },
    ]);

    await reopenClosedPeriods(periodPort, { from: '2025-09', to: '2026-09', runId: 'accel-9', keep: ['2025-10'] });

    expect(reopened.map((entry) => entry.code)).toEqual(['2025-11']);
  });
});

describe('closeMonth', () => {
  it('closes an open month', async () => {
    const { periodPort, closed } = port([]);

    expect(await closeMonth(periodPort, '2025-10')).toEqual({ code: '2025-10', result: 'closed' });
    expect(closed).toEqual(['2025-10']);
  });

  it('counts a month that is already closed as closed', async () => {
    const { periodPort } = port([], refusal(409, 'PERIOD_ALREADY_CLOSED'));

    expect(await closeMonth(periodPort, '2025-10')).toEqual({ code: '2025-10', result: 'already-closed' });
  });

  it('returns a refusal rather than throwing, so the day can retry tomorrow', async () => {
    const { periodPort } = port([], refusal(422, 'PERIOD_HAS_DRAFT_ENTRIES'));

    const outcome = await closeMonth(periodPort, '2025-10');

    expect(outcome.result).toBe('refused');
    expect(outcome.result === 'refused' && outcome.detail).toContain('PERIOD_HAS_DRAFT_ENTRIES');
  });

  it('does not mistake another conflict for an already-closed month', async () => {
    const { periodPort } = port([], refusal(409, 'CONCURRENT_MODIFICATION'));

    expect((await closeMonth(periodPort, '2025-10')).result).toBe('refused');
  });
});
