/**
 * Every time bound a virtual day needs, derived together from one clock reading.
 *
 * Pure: no SDK, no clients, no clock of its own. It exists because the day runner's
 * characteristic defect — four review cycles running — was never a wrong formula. It
 * was bounds computed at *different instants*: a `dayEnd` taken before a wait that
 * crossed midnight, a `workBound` taken before a shift fan-out that cost virtual
 * hours, a `closesAt` that answered null and quietly fell back to the day's end. Each
 * fix was locally right and produced the next instance of the same class.
 *
 * So the bounds are no longer computed one at a time where they are used. A reading is
 * taken, a whole consistent set is derived from it, and the set says up front whether
 * the day is workable at all. Deriving is free, so re-deriving after anything that
 * costs virtual time is the normal thing to do rather than an optimisation to skip —
 * and a stale bound cannot coexist with a fresh one, because they arrive together.
 */
import { nextUtcMidnight } from './virtualTimer';
import type { ShopCalendar } from './shopCalendar';

/**
 * Why a date yields no bay work.
 *
 * Only `'closed'` — a date the shop never opens. "The window has gone by" is
 * deliberately *not* here: from a single instant it is indistinguishable from "the
 * window has not come yet", and both are answered the same way, by waiting for
 * `opensAt`. Whether a wait *overshot* is the caller's knowledge, because only the
 * caller knows it just waited. Encoding it here is what made a Friday-evening start
 * report a missed window instead of waiting for Saturday.
 */
export type DayBlocker = 'closed';

export interface DaySchedule {
  /** The reading every field below was derived from. */
  observedAt: Date;
  /** Midnight after `observedAt`: no stretch of work may cross it. */
  dayEnd: Date;
  /**
   * When bay work may start: `observedAt` when the shop is already open, otherwise the
   * next opening instant — which may be on a later date, since a run whose setup
   * finished on a Friday evening waits for Saturday rather than giving up on the day.
   * Null only when the date never opens.
   */
  opensAt: Date | null;
  /** When the bays shut, or null when `observedAt` is outside the window. */
  closesAt: Date | null;
  /**
   * Where the in-hours loop stops: bay close, never past the day's end.
   *
   * Null when there is no window to work. Deliberately *not* close + grace: the loop
   * can only check its bound between ticks, so it exits one tick past whatever it is
   * given, and the grace is the margin that keeps that tick and the clock-out legal.
   */
  workBound: Date | null;
  /**
   * Where the finish-the-car stretch stops — close plus half the grace, or null when
   * there is no grace configured.
   *
   * Half, so the remainder covers the clock-out fan-out. A mechanic finishes the car
   * they are on while still on the clock, and the shift then ends inside the grace,
   * which is what the end-of-run payroll audit requires. The stretch also refuses to
   * begin a step it predicts would cross the limit — see AcceleratedDayRunner — because
   * a bound checked only between steps is a bound exceeded by one step.
   */
  graceWorkBound: Date | null;
  /**
   * The last instant the shift may legally end: close + grace, exclusive, and never
   * past midnight — the grace goes up to 1440 minutes, and an instant on the next date
   * belongs to a window this comparison knows nothing about.
   */
  graceLimit: Date | null;
  /** True when bay work can start at `observedAt` without waiting. */
  openNow: boolean;
  /** True when work of any kind can happen at `observedAt`. */
  mobileOpenNow: boolean;
  /** Set when no bay work is possible on this date. */
  blocker?: DayBlocker;
}

/**
 * Derives the whole set from one instant.
 *
 * `blocker` distinguishes the two ways a day yields no bay work, because the journal
 * should not record a missed window as a closure: a wait that lands across a weekend
 * is genuinely closed, while one that lands at 19:00 on a Tuesday is not.
 */
export function daySchedule(observedAt: Date, calendar: ShopCalendar): DaySchedule {
  const dayEnd = nextUtcMidnight(observedAt);
  const mobileOpenNow = calendar.isOpen(observedAt, 'MOBILE_UNIT');

  if (!calendar.isWorkingDay(observedAt)) {
    return {
      observedAt,
      dayEnd,
      opensAt: null,
      closesAt: null,
      workBound: null,
      graceWorkBound: null,
      graceLimit: null,
      openNow: false,
      mobileOpenNow,
      blocker: 'closed',
    };
  }

  const openNow = calendar.isOpen(observedAt, 'BAY');
  const closesAt = calendar.closesAt(observedAt, 'BAY');

  // A working date, but not open at this instant — before the window or after it. Either
  // way there is nothing to bound yet, and `opensAt` is where the caller waits for.
  if (!openNow) {
    return {
      observedAt,
      dayEnd,
      opensAt: calendar.nextOpen(observedAt, 'BAY'),
      closesAt: null,
      workBound: null,
      graceWorkBound: null,
      graceLimit: null,
      openNow: false,
      mobileOpenNow,
    };
  }

  const graceMs = calendar.graceMinutes * 60_000;
  // Non-null by construction: `isOpen` is true, so the instant is inside a window.
  const close = closesAt as Date;
  // Clamped against this day's own end, not against the midnight after `close`. Those
  // differ for an all-day window, where `close` *is* midnight: the latter is a day too
  // far and puts the limit on the next date, which is the very thing this clamp exists
  // to prevent.
  const graceLimit = new Date(Math.min(close.getTime() + graceMs - 1, dayEnd.getTime() - 1));
  // Null when there is no grace to spend, rather than an instant a millisecond *before*
  // the work bound: the whole point of deriving these together is that the set cannot
  // contradict itself.
  const graceWorkBound =
    graceMs === 0
      ? null
      : new Date(Math.min(close.getTime() + Math.floor(graceMs / 2), graceLimit.getTime()));

  return {
    observedAt,
    dayEnd,
    opensAt: observedAt,
    closesAt: close,
    workBound: close.getTime() < dayEnd.getTime() ? close : dayEnd,
    graceWorkBound,
    graceLimit,
    openNow: true,
    mobileOpenNow,
  };
}

/** Clamps an instant to the last legal shift end, for the phases that take one. */
export function clampToGrace(instant: Date, schedule: DaySchedule): Date {
  if (schedule.graceLimit === null) {
    return instant;
  }
  return instant.getTime() > schedule.graceLimit.getTime() ? schedule.graceLimit : instant;
}
