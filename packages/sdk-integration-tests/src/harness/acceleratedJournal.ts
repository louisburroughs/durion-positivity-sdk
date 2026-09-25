/**
 * What a run has already done, so a restart does not do it twice.
 *
 * A six-hour run against a shared alpha will sometimes be interrupted — a
 * dropped tunnel, a laptop lid, a failed assertion on virtual day 200. The
 * journal is what makes the next process continue the year instead of starting a
 * second one: it records the timeline's identity, which virtual days are done,
 * and what is still held.
 *
 * Deliberately append-only and written after every virtual day, not at the end:
 * a crash must lose at most one day. Nothing secret goes in it — ids and counts
 * only, never a token or a password, the same rule ItestContext keeps.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { PositionKind } from '../runs/shopFloorPlan';

export interface JournalDay {
  /** Virtual date worked, `YYYY-MM-DD`. */
  virtualDate: string;
  /** Sequential virtual day number within the run, 1-based. */
  dayNumber: number;
  /**
   * Why nothing was worked, when nothing was: the shop was shut, the run is thinning
   * its intake, or the open window had already passed by the time the clock got here.
   */
  skipped?: 'closed' | 'sampled-out' | 'window-missed';
  workordersCompleted: number;
  invoicesFinalized: number;
  invoicesPaid: number;
  estimatesDeclined: number;
  appointmentsBooked: number;
  carriedIn: number;
  carriedOut: number;
  cycleCount?: boolean;
  restock?: boolean;
  /** Optional so a journal written before write-offs were run still loads. */
  scrap?: boolean;
}

export interface JournalState {
  runId: string;
  /** The timeline's identity: two runs with the same realStart are the same year. */
  realStart: string;
  virtualStart: string;
  scale: number;
  startedAt: string;
  updatedAt: string;
  days: JournalDay[];
  /** Workorder ids the run created, for the by-runId retrieval afterwards. */
  workorderIds: string[];
  /**
   * How each of those workorders was worked, for the end-of-run labor audit.
   *
   * Persisted rather than derived from the ledger because the ledger only knows
   * this process's claims. A resumed run audits the whole year's workorders, and
   * without this every one from an earlier process would classify as a bay — which
   * reads every legitimate mobile-unit span as a violation. Optional so a journal
   * written before this field still loads.
   */
  workorderKinds?: Record<string, PositionKind>;
  invoiceIds: string[];
  /**
   * Cycle-count adjustments the run approved, for the year-end reconciliation of
   * the GL against the inventory ledger. Persisted for the reason workorder kinds
   * are: a resumed run reconciles the whole year, not just its own process's days.
   * Optional so a journal written before this field still loads.
   */
  cycleCountAdjustmentIds?: string[];
  /** Claims still held when the journal was last written, for reporting a crash. */
  openClaims: Array<{ positionId: string; technicianId: string; workorderId?: string }>;
}

export class AcceleratedJournal {
  private constructor(
    readonly path: string,
    private state: JournalState,
  ) {}

  /**
   * Opens the journal for this timeline, resuming an existing one or starting a
   * fresh one.
   *
   * A journal whose `realStart` differs from the clock's is refused rather than
   * overwritten: it is a record of a *different* year, and merging the two would
   * produce a day list that describes neither. The operator is told to move it
   * aside, because deleting someone's record of a six-hour run is not this code's
   * decision to make.
   *
   * A journal that recorded *nothing* is a different case, and inheriting its
   * runId was a trap. An attempt that died before its first day still created the
   * suites' fixtures on the backend — a bay, a bin, vehicles — all named or seeded
   * from the runId, none of them journaled. The next attempt reopened the empty
   * journal, took that same runId, regenerated the same names and the same VIN
   * stream, and collided with its predecessor: DUPLICATE_NAME, CONFLICT,
   * VEHICLE_VIN_CONFLICT, across every suite, while the run read as a first one
   * because `resumed` was false. An identity that has produced no retrievable
   * record is therefore dropped rather than adopted, and the caller is told whose
   * place it took.
   *
   * "Recorded nothing" means the whole file, not just its day list: a workorder or
   * an invoice id reaches the state as soon as the record exists, so a journal
   * carrying one has work under its runId with no day closed, and that runId has to
   * be kept for the by-runId retrieval to find it. Those ids reach *disk* at the
   * next flush, which is another reason an empty file cannot be read as an
   * untouched backend — only as an identity with nothing left to resume.
   */
  static open(
    path: string,
    identity: { runId: string; realStart: Date; virtualStart: Date; scale: number },
  ): { journal: AcceleratedJournal; resumed: boolean; replacedRunId?: string } {
    const now = new Date().toISOString();

    if (existsSync(path)) {
      let parsed: JournalState;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as JournalState;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[accel] the run journal at ${path} is not readable JSON (${message}). Move it aside to start a ` +
            'fresh run, or repair it to resume.',
        );
      }
      if (typeof parsed.realStart !== 'string' || !Array.isArray(parsed.days)) {
        throw new Error(`[accel] the run journal at ${path} is missing realStart or days — move it aside to start fresh.`);
      }
      if (parsed.realStart !== identity.realStart.toISOString()) {
        throw new Error(
          `[accel] the run journal at ${path} belongs to a different timeline (its realStart is ` +
            `${parsed.realStart}, the backend reports ${identity.realStart.toISOString()}). The backend has been ` +
            'redeployed with fresh anchors since that run, so its day list describes a year this one is not ' +
            'living. Move the journal aside, or point ITEST_ACCEL_JOURNAL somewhere else.',
        );
      }
      const recorded =
        parsed.days.length > 0 ||
        (parsed.workorderIds?.length ?? 0) > 0 ||
        (parsed.invoiceIds?.length ?? 0) > 0 ||
        (parsed.openClaims?.length ?? 0) > 0;

      parsed.updatedAt = now;
      if (recorded) {
        return { journal: new AcceleratedJournal(path, parsed), resumed: true };
      }

      // Nothing to resume, so nothing to inherit. The file is kept — it is already
      // this timeline's — but the identity written into it from here on is this
      // run's own.
      const replacedRunId = parsed.runId;
      parsed.runId = identity.runId;
      parsed.virtualStart = identity.virtualStart.toISOString();
      parsed.scale = identity.scale;
      parsed.startedAt = now;
      return {
        journal: new AcceleratedJournal(path, parsed),
        resumed: false,
        replacedRunId: replacedRunId === identity.runId ? undefined : replacedRunId,
      };
    }

    return {
      journal: new AcceleratedJournal(path, {
        runId: identity.runId,
        realStart: identity.realStart.toISOString(),
        virtualStart: identity.virtualStart.toISOString(),
        scale: identity.scale,
        startedAt: now,
        updatedAt: now,
        days: [],
        workorderIds: [],
        invoiceIds: [],
        openClaims: [],
      }),
      resumed: false,
    };
  }

  /** The runId of the timeline, which a resumed run adopts so its records stay one set. */
  get runId(): string {
    return this.state.runId;
  }

  get days(): readonly JournalDay[] {
    return this.state.days;
  }

  /** The highest day number recorded, so a resume knows where it stopped. */
  lastDayNumber(): number {
    return this.state.days.reduce((highest, day) => Math.max(highest, day.dayNumber), 0);
  }

  /** Whether a virtual day has already been worked, so a resume does not redo it. */
  hasDay(dayNumber: number): boolean {
    return this.state.days.some((day) => day.dayNumber === dayNumber);
  }

  totals(): { workorders: number; invoices: number; paid: number; declined: number; appointments: number; openDays: number } {
    return {
      workorders: this.state.days.reduce((sum, day) => sum + day.workordersCompleted, 0),
      invoices: this.state.days.reduce((sum, day) => sum + day.invoicesFinalized, 0),
      paid: this.state.days.reduce((sum, day) => sum + day.invoicesPaid, 0),
      declined: this.state.days.reduce((sum, day) => sum + day.estimatesDeclined, 0),
      appointments: this.state.days.reduce((sum, day) => sum + day.appointmentsBooked, 0),
      openDays: this.state.days.filter((day) => day.skipped === undefined).length,
    };
  }

  recordDay(day: JournalDay): void {
    const existing = this.state.days.findIndex((recorded) => recorded.dayNumber === day.dayNumber);
    if (existing >= 0) {
      this.state.days[existing] = day;
    } else {
      this.state.days.push(day);
    }
    this.flush();
  }

  recordWorkorder(workorderId: string, kind?: PositionKind): void {
    if (!this.state.workorderIds.includes(workorderId)) {
      this.state.workorderIds.push(workorderId);
    }
    if (kind) {
      this.state.workorderKinds = { ...(this.state.workorderKinds ?? {}), [workorderId]: kind };
    }
  }

  recordInvoice(invoiceId: string): void {
    if (!this.state.invoiceIds.includes(invoiceId)) {
      this.state.invoiceIds.push(invoiceId);
    }
  }

  recordCycleCountAdjustment(adjustmentId: string): void {
    const ids = (this.state.cycleCountAdjustmentIds ??= []);
    if (!ids.includes(adjustmentId)) {
      ids.push(adjustmentId);
    }
  }

  /** Every cycle-count adjustment the year approved, across every process that worked it. */
  get cycleCountAdjustmentIds(): readonly string[] {
    return this.state.cycleCountAdjustmentIds ?? [];
  }

  recordOpenClaims(claims: Array<{ positionId: string; technicianId: string; workorderId?: string }>): void {
    this.state.openClaims = claims;
  }

  snapshot(): JournalState {
    return JSON.parse(JSON.stringify(this.state)) as JournalState;
  }

  /**
   * Written via a temp file and a rename so a crash mid-write cannot leave the
   * journal truncated — the one file that must survive the crash it is recording.
   */
  flush(): void {
    this.state.updatedAt = new Date().toISOString();
    const directory = dirname(this.path);
    if (directory && directory !== '.' && !existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(temporary, this.path);
  }
}
