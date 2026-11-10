/**
 * Decides what is due, and when — so a run is spaced like a shop's day rather
 * than fired as one burst.
 *
 * Every scenario has a time of day in the shop's time zone. The planner turns
 * "now" and "what has already run" into the list of scenarios to run, and is
 * the same whether it is asked once a minute by the daemon or every quarter
 * hour by an external scheduler: it is a pure function of the clock and the
 * state, so it never double-runs and it recovers from a machine that was
 * asleep.
 *
 * Catch-up rules, chosen for a laptop that is not always on:
 *
 * - **daily** — runs at its slot. If the slot passed more than
 *   `maxLatenessMinutes` ago it is skipped for today: opening the shop at 4pm
 *   is not a faithful replay, and a missed morning should not turn into a
 *   burst of nine scenarios when the lid opens.
 * - **weekly** — due from its weekday on, until it has run once in that ISO
 *   week. A Tuesday scenario missed on Tuesday runs Wednesday.
 * - **monthly** — due from its day of the month on, until it has run once in
 *   that month. Nothing monthly is ever lost to a weekend or a day off, which
 *   is what the monthly coverage promise rests on.
 *
 * Each slot is shifted by a jitter derived from the date and the scenario id:
 * stable across ticks within a day, different from one day to the next.
 */
import type { Scenario } from '../scenarios/types';

export interface LocalClock {
  /** YYYY-MM-DD in the shop's time zone. */
  date: string;
  /** YYYY-MM */
  month: string;
  /** ISO week, e.g. 2026-W46. */
  week: string;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  dayOfMonth: number;
  /** Minutes since local midnight. */
  minutes: number;
}

export function localClock(instant: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): number => Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);
  const year = get('year');
  const month = get('month');
  const day = get('day');

  // ISO-8601 week: the week containing the Thursday of this local date.
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  const thursday = new Date(utc);
  thursday.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const weekNumber = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);

  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    month: `${year}-${pad(month)}`,
    week: `${thursday.getUTCFullYear()}-W${pad(weekNumber)}`,
    weekday,
    dayOfMonth: day,
    minutes: get('hour') * 60 + get('minute'),
  };
}

export const slotMinutes = (slot: string): number => {
  const [hours, minutes] = slot.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
};

export const formatMinutes = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Deterministic offset in [-jitter, +jitter] minutes for a scenario on a date (FNV-1a). */
export function jitterFor(date: string, scenarioId: string, jitterMinutes: number): number {
  if (jitterMinutes <= 0) {
    return 0;
  }
  let hash = 0x811c9dc5;
  for (const char of `${date}|${scenarioId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % (2 * jitterMinutes + 1)) - jitterMinutes;
}

/** When each scenario last ran, in the shop's calendar. */
export interface LastRun {
  date: string;
  week: string;
  month: string;
}

export type SlotStatus =
  /** Its time has come and it has not run: run it now. */
  | 'due'
  /** Later today. */
  | 'upcoming'
  /** Already ran in its period. */
  | 'done'
  /** A daily slot that passed too long ago to run in character. */
  | 'missed'
  /** Not scheduled for today (wrong weekday, or before its day of the month). */
  | 'not-today';

export interface PlannedSlot {
  scenario: Pick<Scenario, 'id' | 'cadence' | 'at' | 'weekday' | 'dayOfMonth' | 'title'>;
  /** Minutes since local midnight, jitter applied. */
  minutes: number;
  status: SlotStatus;
}

export interface PlanOptions {
  runDays: readonly number[];
  jitterMinutes: number;
  maxLatenessMinutes: number;
}

export type Schedulable = Pick<Scenario, 'id' | 'cadence' | 'at' | 'weekday' | 'dayOfMonth' | 'title'>;

export function planDay(
  scenarios: readonly Schedulable[],
  clock: LocalClock,
  lastRuns: Readonly<Record<string, LastRun | undefined>>,
  options: PlanOptions,
): PlannedSlot[] {
  const open = options.runDays.includes(clock.weekday);
  const slots = scenarios.map((scenario): PlannedSlot => {
    const base = slotMinutes(scenario.at);
    const minutes = Math.min(23 * 60 + 59, Math.max(0, base + jitterFor(clock.date, scenario.id, options.jitterMinutes)));
    const last = lastRuns[scenario.id];
    const reached = clock.minutes >= minutes;
    let status: SlotStatus;

    if (!open) {
      status = 'not-today';
    } else if (scenario.cadence === 'daily') {
      if (last?.date === clock.date) {
        status = 'done';
      } else if (!reached) {
        status = 'upcoming';
      } else {
        status = clock.minutes - minutes > options.maxLatenessMinutes ? 'missed' : 'due';
      }
    } else if (scenario.cadence === 'weekly') {
      if (last?.week === clock.week) {
        status = 'done';
      } else if (clock.weekday < (scenario.weekday ?? 1)) {
        status = 'not-today';
      } else {
        status = reached ? 'due' : 'upcoming';
      }
    } else if (last?.month === clock.month) {
      status = 'done';
    } else if (clock.dayOfMonth < (scenario.dayOfMonth ?? 1)) {
      status = 'not-today';
    } else {
      status = reached ? 'due' : 'upcoming';
    }
    return { scenario, minutes, status };
  });
  return slots.sort((a, b) => a.minutes - b.minutes || a.scenario.id.localeCompare(b.scenario.id));
}

/** Open days from the local date in `clock` to the end of its month, today included. */
export function runDaysLeftInMonth(clock: LocalClock, runDays: readonly number[]): number {
  const [year, month] = clock.month.split('-').map((part) => Number.parseInt(part, 10));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let day = clock.dayOfMonth; day <= lastDay; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    if (runDays.includes(weekday)) {
      count += 1;
    }
  }
  return count;
}
