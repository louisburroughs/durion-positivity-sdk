import {
  auditInvoiceViews,
  laborSpanViolations,
  timeEntryViolations,
  type InvoiceView,
  type LaborEntryView,
  type TimeEntryView,
} from './acceleratedAudit';
import { ShopCalendar, type CalendarSpec } from './shopCalendar';

const spec = (overrides: Partial<CalendarSpec> = {}): CalendarSpec => ({
  weekday: { openMinutes: 8 * 60, closeMinutes: 18 * 60 },
  saturday: { openMinutes: 9 * 60, closeMinutes: 13 * 60 },
  sunday: null,
  holidays: new Set(['2025-12-25']),
  graceMinutes: 90,
  mobileAfterHours: true,
  ...overrides,
});

const calendar = new ShopCalendar(spec());

const entry = (overrides: Partial<TimeEntryView> = {}): TimeEntryView => ({
  timeEntryId: 'te-1',
  employeeId: 'emp-1',
  startAtUtc: new Date('2025-11-03T08:05:00Z'),
  endAtUtc: new Date('2025-11-03T17:55:00Z'),
  status: 'APPROVED',
  ...overrides,
});

describe('timeEntryViolations', () => {
  it('passes a shift inside the window', () => {
    expect(timeEntryViolations([entry()], calendar)).toEqual([]);
  });

  it('passes a shift that ended inside the overrun grace', () => {
    expect(timeEntryViolations([entry({ endAtUtc: new Date('2025-11-03T19:00:00Z') })], calendar)).toEqual([]);
  });

  it('reports a shift that started before opening', () => {
    const [violation] = timeEntryViolations([entry({ startAtUtc: new Date('2025-11-03T06:00:00Z') })], calendar);
    expect(violation.reason).toMatch(/started outside the open window/);
    expect(violation.at).toBe('2025-11-03T06:00:00.000Z');
  });

  it('reports a shift that ran past the grace', () => {
    const [violation] = timeEntryViolations([entry({ endAtUtc: new Date('2025-11-03T21:00:00Z') })], calendar);
    expect(violation.reason).toMatch(/more than 90 minutes after close/);
  });

  it('reports a shift on a Sunday', () => {
    const [violation] = timeEntryViolations(
      [entry({ startAtUtc: new Date('2025-11-09T10:00:00Z'), endAtUtc: new Date('2025-11-09T14:00:00Z') })],
      calendar,
    );
    expect(violation.reason).toMatch(/a day the shop does not open/);
  });

  it('names a holiday as a holiday, not as a closed weekday', () => {
    const [violation] = timeEntryViolations(
      [entry({ startAtUtc: new Date('2025-12-25T10:00:00Z'), endAtUtc: new Date('2025-12-25T12:00:00Z') })],
      calendar,
    );
    expect(violation.reason).toMatch(/holiday closure/);
  });

  it('reports an entry with no start rather than passing it', () => {
    const [violation] = timeEntryViolations([entry({ startAtUtc: undefined })], calendar);
    expect(violation.reason).toMatch(/no start time/);
    expect(violation.at).toBe('(none)');
  });

  it('passes an open entry that has not been closed yet', () => {
    expect(timeEntryViolations([entry({ endAtUtc: undefined })], calendar)).toEqual([]);
  });

  it('judges a Saturday against its own shorter window', () => {
    expect(
      timeEntryViolations(
        [entry({ startAtUtc: new Date('2025-11-08T09:30:00Z'), endAtUtc: new Date('2025-11-08T12:30:00Z') })],
        calendar,
      ),
    ).toEqual([]);
    const [violation] = timeEntryViolations(
      [entry({ startAtUtc: new Date('2025-11-08T15:00:00Z'), endAtUtc: new Date('2025-11-08T16:00:00Z') })],
      calendar,
    );
    expect(violation.reason).toMatch(/outside the open window/);
  });
});

describe('auditInvoiceViews', () => {
  const view = (overrides: Partial<InvoiceView> = {}): InvoiceView => ({
    invoiceId: 'inv-1',
    workorderId: 'wo-1',
    status: 'PAID',
    total: 250.5,
    finalizedAt: new Date('2025-11-03T17:00:00Z'),
    ...overrides,
  });

  it('counts a paid invoice as both finalized and paid', () => {
    const audit = auditInvoiceViews([view()]);
    expect(audit).toMatchObject({ finalized: 1, paid: 1, problems: [] });
    expect(audit.months).toEqual(['2025-11']);
  });

  it('counts a finalized but unpaid invoice as finalized only', () => {
    const audit = auditInvoiceViews([view({ status: 'FINALIZED' })]);
    expect(audit.finalized).toBe(1);
    expect(audit.paid).toBe(0);
    expect(audit.problems).toEqual([]);
  });

  it('reports a draft invoice as a problem', () => {
    const audit = auditInvoiceViews([view({ status: 'DRAFT' })]);
    expect(audit.finalized).toBe(0);
    expect(audit.problems[0]).toMatch(/not finalized — status DRAFT/);
  });

  it('reports a zero or missing total — a completed job is worth something', () => {
    expect(auditInvoiceViews([view({ total: 0 })]).problems[0]).toMatch(/total of 0/);
    expect(auditInvoiceViews([view({ total: undefined })]).problems[0]).toMatch(/total of undefined/);
  });

  it('collects the distinct months invoices were finalized in', () => {
    const audit = auditInvoiceViews([
      view({ invoiceId: 'a', finalizedAt: new Date('2025-11-03T17:00:00Z') }),
      view({ invoiceId: 'b', finalizedAt: new Date('2025-12-03T17:00:00Z') }),
      view({ invoiceId: 'c', finalizedAt: new Date('2025-11-20T17:00:00Z') }),
      view({ invoiceId: 'd', finalizedAt: undefined }),
    ]);
    expect(audit.months).toEqual(['2025-11', '2025-12']);
  });

  it('matches on substrings, because the status vocabulary is not pinned by contract', () => {
    expect(auditInvoiceViews([view({ status: 'PARTIALLY_PAID' })]).finalized).toBe(1);
    expect(auditInvoiceViews([view({ status: 'invoice_issued' })]).finalized).toBe(1);
    expect(auditInvoiceViews([view({ status: 'VOID' })]).problems).toHaveLength(1);
  });
});

const labor = (overrides: Partial<LaborEntryView> = {}): LaborEntryView => ({
  entryId: 'le-1',
  workorderId: 'wo-1',
  technicianId: 'tech-a',
  startTime: new Date('2025-11-03T09:00:00Z'),
  endTime: new Date('2025-11-03T11:30:00Z'),
  hoursWorked: 2.5,
  kind: 'BAY',
  ...overrides,
});

describe('laborSpanViolations', () => {
  it('passes a bay span inside the window', () => {
    expect(laborSpanViolations([labor()], calendar)).toEqual([]);
  });

  it('passes a bay span that ended inside the overrun grace', () => {
    expect(
      laborSpanViolations([labor({ endTime: new Date('2025-11-03T19:00:00Z'), hoursWorked: 10 })], calendar),
    ).toEqual([]);
  });

  it('reports a span nobody stopped', () => {
    // The leak the closing-time suspend and the failure path exist to prevent: an entry
    // with no end runs until something else closes it, and the audit is the only place
    // that ever looks.
    const [violation] = laborSpanViolations([labor({ endTime: undefined, hoursWorked: undefined })], calendar);
    expect(violation.reason).toMatch(/never stopped/);
    expect(violation.entryId).toBe('le-1');
    expect(violation.technicianId).toBe('tech-a');
  });

  it('reports a span that crosses a night', () => {
    // calculateHours is a plain subtraction, so an overnight span books the closed hours
    // as worked. This is the check that a missed suspend fails.
    const [violation] = laborSpanViolations(
      [labor({ endTime: new Date('2025-11-04T09:30:00Z'), hoursWorked: 24.5 })],
      calendar,
    );
    expect(violation.reason).toMatch(/2025-11-03 into 2025-11-04/);
  });

  it('reports an overnight span for a mobile unit too', () => {
    // Mobile units work any hour, not every hour. Without the suspend at the end of the
    // after-hours stretch this is exactly what a mobile job records.
    const [violation] = laborSpanViolations(
      [labor({ kind: 'MOBILE_UNIT', endTime: new Date('2025-11-04T09:30:00Z'), hoursWorked: 24.5 })],
      calendar,
    );
    expect(violation.reason).toMatch(/never suspended at the end of its day/);
  });

  it('reports a zero-hour span', () => {
    // The backend rounds to two decimals, so a session reopened only to be closed again
    // lands as 0.00 — the shape the labor-close reopen guard prevents.
    const [violation] = laborSpanViolations(
      [labor({ endTime: new Date('2025-11-03T09:00:02Z'), hoursWorked: 0 })],
      calendar,
    );
    expect(violation.reason).toMatch(/0 hours/);
  });

  it('reports a bay span that started before opening', () => {
    const [violation] = laborSpanViolations(
      [labor({ startTime: new Date('2025-11-03T06:00:00Z'), endTime: new Date('2025-11-03T07:00:00Z') })],
      calendar,
    );
    expect(violation.reason).toMatch(/outside the open window/);
  });

  it('reports a bay span that ran past the grace', () => {
    const [violation] = laborSpanViolations(
      [labor({ endTime: new Date('2025-11-03T20:00:00Z'), hoursWorked: 11 })],
      calendar,
    );
    expect(violation.reason).toMatch(/more than 90 minutes after close/);
  });

  it('reports a bay span on a day the shop does not open', () => {
    const [violation] = laborSpanViolations(
      [
        labor({
          startTime: new Date('2025-12-25T09:00:00Z'),
          endTime: new Date('2025-12-25T10:00:00Z'),
        }),
      ],
      calendar,
    );
    expect(violation.reason).toMatch(/holiday closure/);
  });

  it('leaves a mobile span outside the window alone', () => {
    // The false positive that would make the whole check unreadable: every mobile job in
    // the year is worked outside the bay window by design.
    expect(
      laborSpanViolations(
        [
          labor({
            kind: 'MOBILE_UNIT',
            startTime: new Date('2025-11-03T22:00:00Z'),
            endTime: new Date('2025-11-03T23:30:00Z'),
          }),
        ],
        calendar,
      ),
    ).toEqual([]);
  });

  it('reports a span that ends before it starts', () => {
    const [violation] = laborSpanViolations(
      [labor({ startTime: new Date('2025-11-03T11:00:00Z'), endTime: new Date('2025-11-03T09:00:00Z') })],
      calendar,
    );
    expect(violation.reason).toMatch(/ends before it starts/);
  });
});
