import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AcceleratedJournal, type JournalDay } from './acceleratedJournal';

const identity = {
  runId: 'accel-1',
  realStart: new Date('2026-09-17T12:00:00.000Z'),
  virtualStart: new Date('2025-09-17T12:00:00.000Z'),
  scale: 1460,
};

const day = (overrides: Partial<JournalDay> = {}): JournalDay => ({
  virtualDate: '2025-09-18',
  dayNumber: 1,
  workordersCompleted: 3,
  invoicesFinalized: 3,
  invoicesPaid: 3,
  estimatesDeclined: 1,
  appointmentsBooked: 2,
  carriedIn: 0,
  carriedOut: 1,
  ...overrides,
});

const freshPath = (): string => join(mkdtempSync(join(tmpdir(), 'accel-journal-')), 'journal.json');

describe('AcceleratedJournal', () => {
  it('starts fresh when no journal exists', () => {
    const { journal, resumed } = AcceleratedJournal.open(freshPath(), identity);

    expect(resumed).toBe(false);
    expect(journal.runId).toBe('accel-1');
    expect(journal.lastDayNumber()).toBe(0);
  });

  it('writes after every day, so a crash loses at most one', () => {
    const path = freshPath();
    const { journal } = AcceleratedJournal.open(path, identity);

    journal.recordDay(day({ dayNumber: 1 }));
    journal.recordDay(day({ dayNumber: 2, virtualDate: '2025-09-19' }));

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { days: JournalDay[] };
    expect(onDisk.days.map((d) => d.dayNumber)).toEqual([1, 2]);
  });

  it('resumes the same timeline, adopting its runId so the records stay one set', () => {
    const path = freshPath();
    const first = AcceleratedJournal.open(path, identity).journal;
    first.recordDay(day({ dayNumber: 1 }));
    first.recordDay(day({ dayNumber: 2, virtualDate: '2025-09-19' }));

    const { journal, resumed } = AcceleratedJournal.open(path, { ...identity, runId: 'accel-2' });

    expect(resumed).toBe(true);
    expect(journal.runId).toBe('accel-1');
    expect(journal.lastDayNumber()).toBe(2);
    expect(journal.hasDay(2)).toBe(true);
    expect(journal.hasDay(3)).toBe(false);
  });

  it('drops the runId of a journal that recorded nothing, so a dead attempt is not re-worn', () => {
    // The failure this exists for: an attempt died before its first day, having
    // already created the suites' runId-named fixtures on the backend. The next
    // attempt inherited the runId, regenerated the same names and VINs, and every
    // suite failed on DUPLICATE_NAME / CONFLICT / VEHICLE_VIN_CONFLICT.
    const path = freshPath();
    AcceleratedJournal.open(path, identity).journal.flush();

    const { journal, resumed, replacedRunId } = AcceleratedJournal.open(path, {
      ...identity,
      runId: 'accel-2',
    });

    expect(resumed).toBe(false);
    expect(journal.runId).toBe('accel-2');
    expect(replacedRunId).toBe('accel-1');
    expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe('accel-1');
    journal.flush();
    expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe('accel-2');
  });

  it('keeps the runId of a journal that recorded a workorder before its first day ended', () => {
    // A workorder id is recorded when the record exists rather than when the day
    // closes, so a journal can carry work under its runId with no day in it — and
    // that runId is what a later by-runId query needs. `flush` here is what
    // `recordDay` would have done on the first day boundary.
    const path = freshPath();
    const first = AcceleratedJournal.open(path, identity).journal;
    first.recordWorkorder('wo-1');
    first.flush();

    const { journal, resumed, replacedRunId } = AcceleratedJournal.open(path, {
      ...identity,
      runId: 'accel-2',
    });

    expect(resumed).toBe(true);
    expect(journal.runId).toBe('accel-1');
    expect(replacedRunId).toBeUndefined();
  });

  it('refuses a journal from a different timeline instead of merging two years', () => {
    const path = freshPath();
    AcceleratedJournal.open(path, identity).journal.recordDay(day());

    expect(() =>
      AcceleratedJournal.open(path, { ...identity, realStart: new Date('2026-10-01T00:00:00.000Z') }),
    ).rejects;
    expect(() => AcceleratedJournal.open(path, { ...identity, realStart: new Date('2026-10-01T00:00:00.000Z') })).toThrow(
      /belongs to a different timeline.*Move the journal aside/s,
    );
  });

  it('refuses a corrupt journal rather than overwriting someone\'s six-hour record', () => {
    const path = freshPath();
    writeFileSync(path, '{ not json', 'utf8');

    expect(() => AcceleratedJournal.open(path, identity)).toThrow(/not readable JSON.*Move it aside/s);
  });

  it('refuses a journal missing the fields a resume needs', () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ runId: 'x' }), 'utf8');

    expect(() => AcceleratedJournal.open(path, identity)).toThrow(/missing realStart or days/);
  });

  it('replaces a re-recorded day rather than double-counting it', () => {
    const { journal } = AcceleratedJournal.open(freshPath(), identity);

    journal.recordDay(day({ dayNumber: 1, workordersCompleted: 3 }));
    journal.recordDay(day({ dayNumber: 1, workordersCompleted: 5 }));

    expect(journal.days).toHaveLength(1);
    expect(journal.totals().workorders).toBe(5);
  });

  it('totals only the days that were worked', () => {
    const { journal } = AcceleratedJournal.open(freshPath(), identity);

    journal.recordDay(day({ dayNumber: 1, workordersCompleted: 3, invoicesFinalized: 3, invoicesPaid: 2 }));
    journal.recordDay(
      day({ dayNumber: 2, skipped: 'closed', workordersCompleted: 0, invoicesFinalized: 0, invoicesPaid: 0, appointmentsBooked: 0, estimatesDeclined: 0 }),
    );
    journal.recordDay(day({ dayNumber: 3, workordersCompleted: 4, invoicesFinalized: 4, invoicesPaid: 4 }));

    expect(journal.totals()).toMatchObject({ workorders: 7, invoices: 7, paid: 6, openDays: 2 });
  });

  it('keeps created ids unique, for the by-runId retrieval afterwards', () => {
    const { journal } = AcceleratedJournal.open(freshPath(), identity);

    journal.recordWorkorder('wo-1');
    journal.recordWorkorder('wo-1');
    journal.recordInvoice('inv-1');
    journal.recordOpenClaims([{ positionId: 'bay-1', technicianId: 'tech-a', workorderId: 'wo-1' }]);
    journal.flush();

    const snapshot = journal.snapshot();
    expect(snapshot.workorderIds).toEqual(['wo-1']);
    expect(snapshot.invoiceIds).toEqual(['inv-1']);
    expect(snapshot.openClaims).toHaveLength(1);
  });

  it('never lets a caller mutate its state through the snapshot', () => {
    const { journal } = AcceleratedJournal.open(freshPath(), identity);
    journal.recordDay(day());

    journal.snapshot().days.push(day({ dayNumber: 99 }));

    expect(journal.days).toHaveLength(1);
  });
});
