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
  invoiceIds: string[];
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
   */
  static open(
    path: string,
    identity: { runId: string; realStart: Date; virtualStart: Date; scale: number },
  ): { journal: AcceleratedJournal; resumed: boolean } {
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
      parsed.updatedAt = now;
      return { journal: new AcceleratedJournal(path, parsed), resumed: parsed.days.length > 0 };
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

  recordWorkorder(workorderId: string): void {
    if (!this.state.workorderIds.includes(workorderId)) {
      this.state.workorderIds.push(workorderId);
    }
  }

  recordInvoice(invoiceId: string): void {
    if (!this.state.invoiceIds.includes(invoiceId)) {
      this.state.invoiceIds.push(invoiceId);
    }
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
