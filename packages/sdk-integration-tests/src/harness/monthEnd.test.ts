import {
  bankRecExceptionJustification,
  closeMonth,
  createPeriodPort,
  monthsToClose, periodCode, periodCodesBetween,
  reopenClosedPeriods,
  type PeriodPort,
} from './monthEnd';

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
  const exceptions: string[] = [];
  const periodPort: PeriodPort = {
    list: async () => periods,
    close: async (code, bankRecException) => {
      if (closeThrows) {
        throw closeThrows;
      }
      closed.push(code);
      exceptions.push(bankRecException);
    },
    reopen: async (code, justification) => {
      reopened.push({ code, justification });
    },
  };
  return { periodPort, reopened, closed, exceptions };
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

const RUN = 'accel-1-test';

describe('closeMonth', () => {
  it('closes on a bank reconciliation exception naming the run, since the run has no bank', async () => {
    const { periodPort, exceptions } = port([]);

    await closeMonth(periodPort, '2025-10', RUN);

    expect(exceptions).toEqual([bankRecExceptionJustification(RUN, '2025-10')]);
    expect(exceptions[0]).toContain(RUN);
    expect(exceptions[0].length).toBeGreaterThanOrEqual(10);
  });

  it('sends the exception in the close request body', async () => {
    const requests: unknown[] = [];
    const periods = createPeriodPort({
      accountingPeriodsApi: {
        listAccountingPeriods: async () => [],
        closeAccountingPeriod: async (request) => {
          requests.push(request);
          return {};
        },
        reopenAccountingPeriod: async () => ({}),
      },
    });

    await periods.close('2025-10', 'why it closes');

    expect(requests).toEqual([
      { periodCode: '2025-10', periodCloseRequest: { bankReconciliationException: { justification: 'why it closes' } } },
    ]);
  });

  it('closes an open month', async () => {
    const { periodPort, closed } = port([]);

    expect(await closeMonth(periodPort, '2025-10', RUN)).toEqual({ code: '2025-10', result: 'closed' });
    expect(closed).toEqual(['2025-10']);
  });

  it('counts a month that is already closed as closed', async () => {
    const { periodPort } = port([], refusal(409, 'PERIOD_ALREADY_CLOSED'));

    expect(await closeMonth(periodPort, '2025-10', RUN)).toEqual({ code: '2025-10', result: 'already-closed' });
  });

  it('returns a refusal rather than throwing, so the day can retry tomorrow', async () => {
    const { periodPort } = port([], refusal(422, 'PERIOD_HAS_DRAFT_ENTRIES'));

    const outcome = await closeMonth(periodPort, '2025-10', RUN);

    expect(outcome.result).toBe('refused');
    expect(outcome.result === 'refused' && outcome.detail).toContain('PERIOD_HAS_DRAFT_ENTRIES');
  });

  it('retries a 5xx tomorrow rather than stopping the year', async () => {
    const { periodPort } = port([], refusal(503, 'SERVICE_UNAVAILABLE'));

    expect((await closeMonth(periodPort, '2025-10', RUN)).result).toBe('refused');
  });

  it.each([401, 403])('throws on %i, which is wiring rather than month end', async (status) => {
    const { periodPort } = port([], refusal(status, 'FORBIDDEN'));

    await expect(closeMonth(periodPort, '2025-10', RUN)).rejects.toThrow(`HTTP ${status}`);
  });

  it('throws when there was no response at all', async () => {
    const { periodPort } = port([], new TypeError('fetch failed'));

    await expect(closeMonth(periodPort, '2025-10', RUN)).rejects.toThrow('fetch failed');
  });

  it('does not mistake another conflict for an already-closed month', async () => {
    const { periodPort } = port([], refusal(409, 'CONCURRENT_MODIFICATION'));

    expect((await closeMonth(periodPort, '2025-10', RUN)).result).toBe('refused');
  });
});
