/**
 * Month-end close for the accelerated year.
 *
 * A real shop closes its books once a month: after the last postings for the month
 * have landed, the controller closes the accounting period, and anything dated inside
 * it is refused from then on (PERIOD_CLOSED) unless someone with the override posts it.
 * The year run does the same — every month the virtual calendar finishes is closed by
 * the controller before the next day's work begins.
 *
 * Periods are tenant-wide, not per run, and every accelerated dispatch replays roughly
 * the same virtual year a year behind wall time. A month one run closed would refuse
 * every posting the next run makes into it. So global setup reopens the closed periods
 * inside this run's timeline first — with a justification naming the run — and the run
 * closes them again as it finishes each one. The audit trail keeps both halves.
 */
import { formatError, isHttpStatus } from './http';

/**
 * The slice of the accounting client month end uses. Structural rather than the
 * generated class: global setup loads the client with a dynamic import, which resolves
 * to the built package, and the generated classes' private members make that type
 * incompatible with the one a static import resolves from source.
 */
interface AccountingPeriods {
  accountingPeriodsApi: {
    listAccountingPeriods(): Promise<Array<{ periodCode?: string; status?: string }>>;
    closeAccountingPeriod(request: { periodCode: string }): Promise<unknown>;
    reopenAccountingPeriod(request: {
      periodCode: string;
      accountingPeriodReopenRequest: { justification: string };
    }): Promise<unknown>;
  };
}

/** The period code the backend keys months by: `YYYY-MM`, in UTC. */
export const periodCode = (at: Date): string => at.toISOString().slice(0, 7);

/** Every period code from `from` to `to`, both included. Empty when `to` is earlier. */
export function periodCodesBetween(from: string, to: string): string[] {
  const codes: string[] = [];
  let [year, month] = from.split('-').map(Number);
  for (;;) {
    const code = `${year}-${String(month).padStart(2, '0')}`;
    if (code > to) {
      return codes;
    }
    codes.push(code);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

/**
 * The months that have fully ended by `today` and are the run's to close: from the
 * month the timeline starts in up to, but not including, today's month.
 */
export function monthsToClose(virtualStart: Date, today: Date, closed: readonly string[]): string[] {
  const current = periodCode(today);
  return periodCodesBetween(periodCode(virtualStart), current)
    .filter((code) => code < current)
    .filter((code) => !closed.includes(code));
}

export interface PeriodPort {
  list(): Promise<Array<{ periodCode?: string; status?: string }>>;
  close(periodCode: string): Promise<void>;
  reopen(periodCode: string, justification: string): Promise<void>;
}

export function createPeriodPort(accounting: AccountingPeriods): PeriodPort {
  const api = accounting.accountingPeriodsApi;
  return {
    list: () => api.listAccountingPeriods(),
    close: async (code) => {
      await api.closeAccountingPeriod({ periodCode: code });
    },
    reopen: async (code, justification) => {
      await api.reopenAccountingPeriod({ periodCode: code, accountingPeriodReopenRequest: { justification } });
    },
  };
}

/**
 * Reopens every CLOSED period between `from` and `to` (period codes, inclusive), except
 * the ones in `keep` — a resumed run's own closes, which belong to this timeline.
 */
export async function reopenClosedPeriods(
  port: PeriodPort,
  options: { from: string; to: string; runId: string; keep?: readonly string[] },
): Promise<string[]> {
  const inTimeline = new Set(periodCodesBetween(options.from, options.to));
  const keep = new Set(options.keep ?? []);
  const reopened: string[] = [];
  for (const period of await port.list()) {
    const code = period.periodCode;
    if (!code || period.status !== 'CLOSED' || !inTimeline.has(code) || keep.has(code)) {
      continue;
    }
    await port.reopen(
      code,
      `Reopened by accelerated run ${options.runId}: it replays ${code} on a new timeline and closes it again at month end`,
    );
    reopened.push(code);
  }
  return reopened.sort();
}

export type CloseOutcome = { code: string; result: 'closed' | 'already-closed' } | { code: string; result: 'refused'; detail: string };

/**
 * Closes one month. Already closed counts as closed: a resumed day, or a close that
 * landed before an interrupted process could journal it. Any other refusal — draft
 * entries still inside the month (422 PERIOD_HAS_DRAFT_ENTRIES), say — is returned
 * rather than thrown, so the day reports it and the next day tries again.
 */
export async function closeMonth(port: PeriodPort, code: string): Promise<CloseOutcome> {
  try {
    await port.close(code);
    return { code, result: 'closed' };
  } catch (error) {
    if (isHttpStatus(error, 409)) {
      const detail = await formatError(error);
      if (detail.includes('PERIOD_ALREADY_CLOSED')) {
        return { code, result: 'already-closed' };
      }
      return { code, result: 'refused', detail };
    }
    return { code, result: 'refused', detail: await formatError(error) };
  }
}
