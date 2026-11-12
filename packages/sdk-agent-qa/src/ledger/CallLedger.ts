/**
 * Every SDK call a run makes, in order.
 *
 * The ledger is the run's evidence. The model's own account of what it did is
 * never trusted: scenario verdicts (oracle.ts) and monthly coverage
 * (CoverageStore.ts) are both computed from these records, which are written by
 * the tool layer at the moment a call returns.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OutcomeKind } from '../sdk/SdkInvoker';

export interface CallRecord {
  at: string;
  runId: string;
  scenarioId: string;
  operationId: string;
  pkg: string;
  persona: string;
  kind: OutcomeKind;
  status?: number;
  errorCode?: string;
  httpMethod: string;
  requestPath?: string;
  correlationId?: string;
  durationMs: number;
  /** True when the call was sent without client-side validation, to provoke an error. */
  unvalidated?: boolean;
  /** Who made the call: the model, or the deterministic coverage backstop. */
  source: 'agent' | 'backstop';
}

export class CallLedger {
  private readonly records: CallRecord[] = [];

  /** @param file JSONL file each record is appended to, or undefined to keep it in memory only. */
  constructor(private readonly file?: string) {
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
  }

  record(record: CallRecord): void {
    this.records.push(record);
    if (this.file) {
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    }
  }

  all(): readonly CallRecord[] {
    return this.records;
  }

  forScenario(scenarioId: string): CallRecord[] {
    return this.records.filter((record) => record.scenarioId === scenarioId);
  }
}

/** True when the call left the machine and a backend answered — the bar for "this SDK method was called". */
export function reachedBackend(record: Pick<CallRecord, 'kind'>): boolean {
  return record.kind === 'success' || record.kind === 'http-error' || record.kind === 'decode-error';
}
