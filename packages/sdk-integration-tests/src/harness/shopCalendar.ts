/**
 * When a shop is open, and therefore when work may happen.
 *
 * Pure: no SDK, no clients, no clock, no `Date.now()`. Every answer comes from
 * the instant passed in, so the rules that decide whether a mechanic may touch a
 * car at 03:00 on a Sunday are unit-tested rather than only observable against a
 * moving backend clock.
 *
 * The calendar is *owned* here rather than discovered, because it cannot be
 * discovered: `LocationResponseDTO` returns no `operatingHours`, no
 * `holidayClosures` and no `timezone` — they are write-only on `patchLocation`.
 * So the suite decides the hours and publishes them to the sites it touches
 * (see acceleratedGlobalSetup), which is the only way the backend's own
 * scheduling refusals and this gate can agree.
 *
 * All arithmetic is UTC. The accelerated clock contract fixes
 * `pos.time.accelerated.zone=UTC`, and a local zone here would introduce DST
 * transitions the backend's own clock does not have.
 */

// Type-only, so this module still imports nothing at runtime. PositionKind is
// defined where the dispatch board is mapped rather than duplicated here: a
// second definition is a second thing to keep in step with the board's contract.
import type { PositionKind } from '../runs/shopFloorPlan';

/** An open window on one weekday, as minutes from midnight UTC. */
export interface DayWindow {
  openMinutes: number;
  closeMinutes: number;
}

export interface CalendarSpec {
  /** Monday–Friday. */
  weekday: DayWindow;
  saturday: DayWindow | null;
  sunday: DayWindow | null;
  /** Closed dates, as `YYYY-MM-DD` in UTC. */
  holidays: ReadonlySet<string>;
  /**
   * Virtual minutes a job already started may run past close — a mechanic
   * finishing the car they are on. New work never starts inside the grace.
   */
  graceMinutes: number;
  /** Mobile units take work at any hour. False makes them behave like a bay. */
  mobileAfterHours: boolean;
}

export const MINUTES_PER_DAY = 24 * 60;
const DAY_MS = 86_400_000;

/** `HH:MM` → minutes from midnight. Throws on anything else. */
export function parseTimeOfDay(value: string, field: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`${field} must be HH:MM in 24-hour time (got "${value}")`);
  }
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

/** `09:00-13:00`, or `closed`. */
export function parseWindow(value: string, field: string): DayWindow | null {
  const trimmed = value.trim();
  if (/^closed$/i.test(trimmed)) {
    return null;
  }
  const halves = trimmed.split('-');
  if (halves.length !== 2) {
    throw new Error(`${field} must be "HH:MM-HH:MM" or "closed" (got "${value}")`);
  }
  const openMinutes = parseTimeOfDay(halves[0], `${field} open time`);
  const closeMinutes = parseTimeOfDay(halves[1], `${field} close time`);
  if (closeMinutes <= openMinutes) {
    throw new Error(`${field} must open before it closes (got "${value}")`);
  }
  return { openMinutes, closeMinutes };
}

/** `YYYY-MM-DD` for an instant, in UTC. */
export const utcDateKey = (instant: Date): string => instant.toISOString().slice(0, 10);

const minutesOfDay = (instant: Date): number => instant.getUTCHours() * 60 + instant.getUTCMinutes();

const atMinutes = (instant: Date, minutes: number): Date => {
  const at = new Date(instant);
  at.setUTCHours(0, 0, 0, 0);
  return new Date(at.getTime() + minutes * 60_000);
};

const startOfUtcDay = (instant: Date): Date => {
  const start = new Date(instant);
  start.setUTCHours(0, 0, 0, 0);
  return start;
};

/** The nth `weekday` of a month, e.g. the 3rd Monday of January. */
const nthWeekdayOfMonth = (year: number, month: number, weekday: number, nth: number): Date => {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (nth - 1) * 7));
};

/** The last `weekday` of a month, e.g. the last Monday of May. */
const lastWeekdayOfMonth = (year: number, month: number, weekday: number): Date => {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, 0 - back));
};

/**
 * US federal holidays for a calendar year, as `YYYY-MM-DD` UTC keys.
 *
 * The default closure set, computed rather than tabulated because an accelerated
 * run's virtual year spans two calendar years and a hard-coded list would go
 * stale the moment the anchors move. Observed-day shifting (a Saturday holiday
 * kept on Friday) is deliberately not modelled: a shop's closure calendar is
 * whatever it declares, and `ITEST_ACCEL_HOLIDAYS` overrides this wholesale.
 */
export function usFederalHolidays(year: number): string[] {
  const dates: Date[] = [
    new Date(Date.UTC(year, 0, 1)), // New Year's Day
    nthWeekdayOfMonth(year, 0, 1, 3), // MLK Jr. Day
    nthWeekdayOfMonth(year, 1, 1, 3), // Washington's Birthday
    lastWeekdayOfMonth(year, 4, 1), // Memorial Day
    new Date(Date.UTC(year, 5, 19)), // Juneteenth
    new Date(Date.UTC(year, 6, 4)), // Independence Day
    nthWeekdayOfMonth(year, 8, 1, 1), // Labor Day
    nthWeekdayOfMonth(year, 9, 1, 2), // Columbus Day
    new Date(Date.UTC(year, 10, 11)), // Veterans Day
    nthWeekdayOfMonth(year, 10, 4, 4), // Thanksgiving
    new Date(Date.UTC(year, 11, 25)), // Christmas Day
  ];
  return dates.map(utcDateKey);
}

/** Holiday keys covering every calendar year the run's virtual span touches. */
export function holidaysForSpan(from: Date, to: Date): string[] {
  const keys: string[] = [];
  for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year += 1) {
    keys.push(...usFederalHolidays(year));
  }
  return keys;
}

export class ShopCalendar {
  constructor(private readonly spec: CalendarSpec) {}

  get graceMinutes(): number {
    return this.spec.graceMinutes;
  }

  isHoliday(instant: Date): boolean {
    return this.spec.holidays.has(utcDateKey(instant));
  }

  /** The window for the day `instant` falls in, or null when the shop is shut. */
  windowFor(instant: Date): DayWindow | null {
    if (this.isHoliday(instant)) {
      return null;
    }
    const day = instant.getUTCDay();
    if (day === 0) return this.spec.sunday;
    if (day === 6) return this.spec.saturday;
    return this.spec.weekday;
  }

  /** A day the shop opens at all. */
  isWorkingDay(instant: Date): boolean {
    return this.windowFor(instant) !== null;
  }

  /**
   * May work of this kind start now?
   *
   * A mobile unit answers true at every instant: it is based at the site but it
   * works wherever the customer is, and keeping it available is what stops a
   * virtual weekend from being dead air. A bay answers true only inside its
   * window on a day the shop opens.
   */
  isOpen(instant: Date, kind: PositionKind): boolean {
    if (kind === 'MOBILE_UNIT' && this.spec.mobileAfterHours) {
      return true;
    }
    const window = this.windowFor(instant);
    if (!window) {
      return false;
    }
    const minutes = minutesOfDay(instant);
    return minutes >= window.openMinutes && minutes < window.closeMinutes;
  }

  /**
   * When the window containing `instant` closes, or null when this kind of work
   * is unbounded (a mobile unit) or the shop is shut.
   */
  closesAt(instant: Date, kind: PositionKind): Date | null {
    if (kind === 'MOBILE_UNIT' && this.spec.mobileAfterHours) {
      return null;
    }
    const window = this.windowFor(instant);
    if (!window) {
      return null;
    }
    const minutes = minutesOfDay(instant);
    if (minutes < window.openMinutes || minutes >= window.closeMinutes) {
      return null;
    }
    return atMinutes(instant, window.closeMinutes);
  }

  /**
   * True while a job that started inside the window may still be finished:
   * inside the window, or within the grace period after it closed.
   */
  withinGrace(instant: Date, kind: PositionKind): boolean {
    if (this.isOpen(instant, kind)) {
      return true;
    }
    const window = this.windowFor(instant);
    if (!window) {
      return false;
    }
    const minutes = minutesOfDay(instant);
    return minutes >= window.closeMinutes && minutes < window.closeMinutes + this.spec.graceMinutes;
  }

  /**
   * The next instant work of this kind may start — `instant` itself when it
   * already may.
   *
   * Scans forward a day at a time rather than solving for the next open day,
   * because a run of holidays and a closed weekend compose, and a closed
   * Saturday next to Christmas is exactly the case a closed-form answer gets
   * wrong. Bounded at 400 days: further than that and the calendar is
   * misconfigured (every day closed), which is worth an error rather than a
   * silent hang.
   */
  nextOpen(instant: Date, kind: PositionKind): Date {
    if (this.isOpen(instant, kind)) {
      return new Date(instant);
    }
    if (kind === 'MOBILE_UNIT' && this.spec.mobileAfterHours) {
      return new Date(instant);
    }

    const window = this.windowFor(instant);
    if (window && minutesOfDay(instant) < window.openMinutes) {
      return atMinutes(instant, window.openMinutes);
    }

    for (let ahead = 1; ahead <= 400; ahead += 1) {
      const candidate = new Date(startOfUtcDay(instant).getTime() + ahead * DAY_MS);
      const candidateWindow = this.windowFor(candidate);
      if (candidateWindow) {
        return atMinutes(candidate, candidateWindow.openMinutes);
      }
    }
    throw new Error(
      '[accel] the shop calendar has no open day in the next 400 days — every weekday window is ' +
        'closed or the holiday list covers the year. Check ITEST_ACCEL_OPEN_TIME / _CLOSE_TIME / _HOLIDAYS.',
    );
  }

  /** Open minutes on the day `instant` falls in; 0 when shut. */
  openMinutesOn(instant: Date): number {
    const window = this.windowFor(instant);
    return window ? window.closeMinutes - window.openMinutes : 0;
  }

  /**
   * The shortest open window the calendar has, in minutes — what the feasibility
   * guard must fit work into, since a Saturday half-day is the tightest case a
   * run will meet.
   */
  shortestOpenMinutes(): number {
    const windows = [this.spec.weekday, this.spec.saturday, this.spec.sunday].filter(
      (window): window is DayWindow => window !== null,
    );
    if (windows.length === 0) {
      throw new Error('[accel] the shop calendar declares no open window at all');
    }
    return Math.min(...windows.map((window) => window.closeMinutes - window.openMinutes));
  }

  /**
   * The closure entries inside `[from, to]`, shaped for `patchLocation`.
   *
   * Only the run's own span: the endpoint replaces the whole list, so publishing a
   * decade of dates would put noise on the record and hide the closures that
   * actually applied.
   */
  closuresBetween(from: Date, to: Date): Array<{ date: Date; reason: string }> {
    const closures: Array<{ date: Date; reason: string }> = [];
    for (const key of [...this.spec.holidays].sort()) {
      const date = new Date(`${key}T00:00:00.000Z`);
      if (date.getTime() >= startOfUtcDay(from).getTime() && date.getTime() <= to.getTime()) {
        closures.push({ date, reason: 'Accelerated run shop closure' });
      }
    }
    return closures;
  }

  /** Days in `[from, to)` the shop opens — the denominator for volume targets. */
  countOpenDays(from: Date, to: Date): number {
    let open = 0;
    for (let day = startOfUtcDay(from); day.getTime() < to.getTime(); day = new Date(day.getTime() + DAY_MS)) {
      if (this.isWorkingDay(day)) {
        open += 1;
      }
    }
    return open;
  }
}
