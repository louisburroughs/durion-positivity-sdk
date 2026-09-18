import {
  auditInvoiceViews,
  timeEntryViolations,
  type InvoiceView,
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
