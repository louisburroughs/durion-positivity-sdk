/**
 * Checking the year against what the backend actually stored.
 *
 * The day runner can say the run *intended* to keep every mechanic inside working
 * hours and every invoice paid. That is not evidence. These checks read the
 * records back — payroll time entries and invoices — and judge the timestamps the
 * backend wrote under its own accelerated clock.
 *
 * The predicates are pure and unit-tested; only the two `audit*` functions talk to
 * a backend. A compliance check that could only be exercised against a live
 * six-hour run would never be exercised.
 */
import type { ShopCalendar } from './shopCalendar';
import { utcDateKey } from './shopCalendar';
import { call } from './http';
import type { DomainClients } from './personas';
import type { PositionKind } from '../runs/shopFloorPlan';

/** The fields of `TimeEntrySummary` this audit reads. */
export interface TimeEntryView {
  timeEntryId: string;
  employeeId?: string;
  startAtUtc?: Date;
  endAtUtc?: Date;
  workDate?: Date;
  status?: string;
}

export interface TimeEntryViolation {
  timeEntryId: string;
  employeeId: string | undefined;
  reason: string;
  at: string;
}

/**
 * Payroll shifts that fall outside the shop's hours.
 *
 * A shift is a *bay-side* record — it is the person being in the building — so it
 * is judged against the bay calendar even for a mobile crew's mechanic, and the
 * overrun grace applies to its end for the same reason a job may finish past
 * close: the mechanic was still on the car.
 *
 * Entries with no timestamps are reported rather than skipped. A payroll row with
 * no start is not evidence of compliance; it is evidence of a shift nobody can
 * account for.
 */
export function timeEntryViolations(
  entries: readonly TimeEntryView[],
  calendar: ShopCalendar,
): TimeEntryViolation[] {
  const violations: TimeEntryViolation[] = [];

  for (const entry of entries) {
    if (!entry.startAtUtc) {
      violations.push({
        timeEntryId: entry.timeEntryId,
        employeeId: entry.employeeId,
        reason: 'the entry has no start time, so the shift cannot be shown to have happened in hours',
        at: '(none)',
      });
      continue;
    }

    if (!calendar.isWorkingDay(entry.startAtUtc)) {
      violations.push({
        timeEntryId: entry.timeEntryId,
        employeeId: entry.employeeId,
        reason: calendar.isHoliday(entry.startAtUtc)
          ? 'the shift started on a holiday closure'
          : 'the shift started on a day the shop does not open',
        at: entry.startAtUtc.toISOString(),
      });
      continue;
    }
    if (!calendar.isOpen(entry.startAtUtc, 'BAY')) {
      violations.push({
        timeEntryId: entry.timeEntryId,
        employeeId: entry.employeeId,
        reason: 'the shift started outside the open window',
        at: entry.startAtUtc.toISOString(),
      });
    }
    // The end may sit in the grace — a mechanic finishing the car they are on —
    // but not beyond it.
    if (entry.endAtUtc && !calendar.withinGrace(entry.endAtUtc, 'BAY')) {
      violations.push({
        timeEntryId: entry.timeEntryId,
        employeeId: entry.employeeId,
        reason: `the shift ended more than ${calendar.graceMinutes} minutes after close`,
        at: entry.endAtUtc.toISOString(),
      });
    }
  }
  return violations;
}

/** The fields of `WorkorderLaborEntryResponse` this audit reads, plus the job's kind. */
export interface LaborEntryView {
  entryId: string;
  workorderId: string;
  technicianId?: string;
  startTime?: Date;
  endTime?: Date;
  hoursWorked?: number;
  /**
   * Which kind of position the job was worked from.
   *
   * Load-bearing, not decoration. A bay's labor must sit inside the shop's hours; a
   * mobile unit's legitimately does not, because ShopCalendar lets mobile work any
   * hour. Judging both against the bay window would report every mobile job in the
   * year as a violation, which is how a check like this stops being read.
   */
  kind: PositionKind;
}

export interface LaborSpanViolation {
  entryId: string;
  workorderId: string;
  technicianId: string | undefined;
  reason: string;
  at: string;
}

/**
 * Labor spans that describe something the shop did not do.
 *
 * Each of these has a defect behind it that a passing unit suite cannot see, because
 * only a real backend stamps the two ends:
 *
 *   - **no end** — a session nobody stopped. The entry runs until something else
 *     closes it, and a mechanic reads as still on the job a virtual year later. This
 *     is what the day runner's closing-time suspend and AcceleratedJob's failure path
 *     exist to prevent, and the only way to know they fired is to look.
 *   - **crossing a night** — `WorkorderLaborEntry.calculateHours` is a plain
 *     subtraction with no notion of opening hours, so a span left open overnight
 *     books the night as worked. A bay span must open and close on one virtual date.
 *   - **zero hours** — the backend rounds to two decimals, so a span of seconds lands
 *     as `0.00`. That is the shape of a session reopened only to be closed again,
 *     which the `labor-close` reopen guard is there to avoid.
 *   - **out of hours** — a bay job worked before opening or past the grace.
 *
 * Pure, so every branch is exercised without a six-hour run behind it.
 */
export function laborSpanViolations(
  entries: readonly LaborEntryView[],
  calendar: ShopCalendar,
): LaborSpanViolation[] {
  const violations: LaborSpanViolation[] = [];
  const violation = (entry: LaborEntryView, reason: string, at: Date | undefined): LaborSpanViolation => ({
    entryId: entry.entryId,
    workorderId: entry.workorderId,
    technicianId: entry.technicianId,
    reason,
    at: at ? at.toISOString() : '(none)',
  });

  for (const entry of entries) {
    if (!entry.startTime) {
      violations.push(violation(entry, 'the labor entry has no start time, so its span cannot be judged', undefined));
      continue;
    }
    if (!entry.endTime) {
      violations.push(
        violation(entry, 'the labor entry was never stopped — the mechanic is still on this job', entry.startTime),
      );
      continue;
    }

    if (entry.endTime.getTime() < entry.startTime.getTime()) {
      violations.push(violation(entry, 'the labor entry ends before it starts', entry.startTime));
      continue;
    }

    if (entry.hoursWorked !== undefined && entry.hoursWorked <= 0) {
      violations.push(
        violation(entry, `the labor entry records ${entry.hoursWorked} hours — a span nobody worked`, entry.startTime),
      );
    }

    // A span may not cross midnight whatever the kind. For a bay that is the closed
    // night; for a mobile unit it is still a single shift rather than a day of standing
    // time, and the suspend at the end of the after-hours stretch is what keeps it so.
    if (utcDateKey(entry.startTime) !== utcDateKey(entry.endTime)) {
      violations.push(
        violation(
          entry,
          `the labor entry runs from ${utcDateKey(entry.startTime)} into ${utcDateKey(entry.endTime)} — ` +
            'a span that was never suspended at the end of its day',
          entry.startTime,
        ),
      );
      continue;
    }

    // Mobile units take work at any hour, so only a bay's span is judged against the
    // window. See ShopCalendar and ITEST_ACCEL_MOBILE_AFTER_HOURS.
    if (entry.kind !== 'BAY') {
      continue;
    }

    if (!calendar.isWorkingDay(entry.startTime)) {
      violations.push(
        violation(
          entry,
          calendar.isHoliday(entry.startTime)
            ? 'the bay labor started on a holiday closure'
            : 'the bay labor started on a day the shop does not open',
          entry.startTime,
        ),
      );
      continue;
    }
    if (!calendar.isOpen(entry.startTime, 'BAY')) {
      violations.push(violation(entry, 'the bay labor started outside the open window', entry.startTime));
    }
    // The end may sit in the grace — the mechanic was still on the car — but no further.
    if (!calendar.withinGrace(entry.endTime, 'BAY')) {
      violations.push(
        violation(entry, `the bay labor ended more than ${calendar.graceMinutes} minutes after close`, entry.endTime),
      );
    }
  }
  return violations;
}

/** The fields of `InvoiceDetailsResponse` this audit reads. */
export interface InvoiceView {
  invoiceId?: string;
  workorderId?: string;
  status?: string;
  total?: number;
  finalizedAt?: Date;
}

export interface InvoiceAudit {
  /** Invoices the backend confirms are finalized. */
  finalized: number;
  /** Of those, the ones the backend shows as paid. */
  paid: number;
  /** Distinct `YYYY-MM` the invoices were finalized in, by the virtual clock. */
  months: string[];
  problems: string[];
}

const PAID_MARKERS = ['PAID', 'SETTLED', 'CLOSED'];
const FINALIZED_MARKERS = ['FINAL', 'ISSUED', 'SENT', 'PAID', 'SETTLED', 'CLOSED', 'PARTIAL'];

const matches = (status: string | undefined, markers: string[]): boolean =>
  status !== undefined && markers.some((marker) => status.toUpperCase().includes(marker));

/**
 * What the invoices say about themselves.
 *
 * Status vocabularies are the backend's to choose and are not pinned by contract,
 * so this matches on substrings and reports what it saw rather than asserting an
 * exact enum. A zero or negative total is a hard problem either way: a completed
 * job is worth something.
 */
export function auditInvoiceViews(views: readonly InvoiceView[]): InvoiceAudit {
  const problems: string[] = [];
  const months = new Set<string>();
  let finalized = 0;
  let paid = 0;

  for (const view of views) {
    const id = view.invoiceId ?? '(no id)';
    if (!matches(view.status, FINALIZED_MARKERS)) {
      problems.push(`invoice ${id} is not finalized — status ${view.status ?? '(none)'}`);
    } else {
      finalized += 1;
    }
    if (matches(view.status, PAID_MARKERS)) {
      paid += 1;
    }
    if (view.total === undefined || view.total <= 0) {
      problems.push(`invoice ${id} has a total of ${String(view.total)} — a completed job is worth something`);
    }
    if (view.finalizedAt) {
      months.add(utcDateKey(view.finalizedAt).slice(0, 7));
    }
  }

  return { finalized, paid, months: [...months].sort(), problems };
}

/**
 * Reads back every payroll entry for the virtual dates the run worked.
 *
 * Queried per work date rather than in one sweep: `listTimeEntries` filters by
 * `workDate`, and the run's dates are exactly the ones it should be judged on —
 * a year of somebody else's history is not this run's to assert about.
 */
export async function auditTimeEntries(
  as: DomainClients,
  calendar: ShopCalendar,
  workDates: readonly string[],
  locationId: string,
): Promise<{ checked: number; violations: TimeEntryViolation[] }> {
  const entries: TimeEntryView[] = [];

  for (const workDate of workDates) {
    const page = await call(`listTimeEntries ${workDate}`, () =>
      as.people.timeEntryApprovalAPIApi.listTimeEntries({
        workDate: new Date(`${workDate}T00:00:00.000Z`),
        locationId,
        size: 200,
      }),
    );
    // `items`, not `content`: this endpoint's paged wrapper is the repo's own
    // PagedResponse shape rather than a Spring Page.
    for (const entry of page.items ?? []) {
      entries.push({
        timeEntryId: entry.timeEntryId,
        employeeId: entry.employeeId,
        startAtUtc: entry.startAtUtc,
        endAtUtc: entry.endAtUtc,
        workDate: entry.workDate,
        status: String(entry.status),
      });
    }
  }

  return { checked: entries.length, violations: timeEntryViolations(entries, calendar) };
}

/**
 * Reads back every labor entry the run's workorders carry.
 *
 * `kindByWorkorderId` comes from the ledger's own holds: the run knows which claim
 * worked each workorder and therefore whether its hours are allowed outside the
 * shop's window. A workorder the caller cannot classify is judged as a bay, which is
 * the stricter of the two — an unclassified job silently exempted from the window
 * would be a check that passes by forgetting.
 */
export async function auditLaborSpans(
  as: DomainClients,
  calendar: ShopCalendar,
  workorderIds: readonly string[],
  kindByWorkorderId: ReadonlyMap<string, PositionKind>,
): Promise<{ checked: number; violations: LaborSpanViolation[] }> {
  const entries: LaborEntryView[] = [];

  for (const workorderId of workorderIds) {
    const history = await call(`getLaborHistory ${workorderId}`, () =>
      as.workorder.workorderLaborAPIApi.getLaborHistory({ workorderId }),
    );
    for (const entry of history) {
      entries.push({
        entryId: entry.id,
        workorderId: entry.workorderId ?? workorderId,
        technicianId: entry.technicianId,
        startTime: entry.startTime,
        endTime: entry.endTime,
        hoursWorked: entry.hoursWorked,
        kind: kindByWorkorderId.get(workorderId) ?? 'BAY',
      });
    }
  }

  return { checked: entries.length, violations: laborSpanViolations(entries, calendar) };
}

/** Reads back every invoice the run finalized. */
export async function auditInvoices(as: DomainClients, invoiceIds: readonly string[]): Promise<InvoiceAudit> {
  const views: InvoiceView[] = [];

  for (const invoiceId of invoiceIds) {
    const detail = await call(`getInvoice ${invoiceId}`, () => as.invoice.invoiceApi.getInvoice({ invoiceId }));
    views.push({
      invoiceId: detail.invoiceId ?? invoiceId,
      workorderId: detail.workorderId,
      status: detail.status === undefined ? undefined : String(detail.status),
      total: detail.total,
      finalizedAt: detail.finalizedAt,
    });
  }
  return auditInvoiceViews(views);
}
