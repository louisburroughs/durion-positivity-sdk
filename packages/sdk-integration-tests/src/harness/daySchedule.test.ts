import { clampToGrace, daySchedule } from './daySchedule';
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
const at = (iso: string) => new Date(iso);
const on = (iso: string, cal = calendar) => daySchedule(at(iso), cal);

// 2025-11-03 Monday, 11-08 Saturday, 11-09 Sunday, 12-25 Christmas.
describe('daySchedule — inside the window', () => {
  const schedule = on('2025-11-03T10:00:00Z');

  it('derives every bound from the one instant it was given', () => {
    expect(schedule.observedAt.toISOString()).toBe('2025-11-03T10:00:00.000Z');
    expect(schedule.openNow).toBe(true);
    expect(schedule.opensAt?.toISOString()).toBe('2025-11-03T10:00:00.000Z');
    expect(schedule.closesAt?.toISOString()).toBe('2025-11-03T18:00:00.000Z');
    expect(schedule.dayEnd.toISOString()).toBe('2025-11-04T00:00:00.000Z');
    expect(schedule.blocker).toBeUndefined();
  });

  it('bounds the work loop at close, not at close plus grace', () => {
    // The loop exits one tick past its bound, and the grace is the margin that keeps
    // that tick and the clock-out legal — not a second working window.
    expect(schedule.workBound?.toISOString()).toBe('2025-11-03T18:00:00.000Z');
  });

  it('gives the finish-the-car stretch half the grace, and keeps the rest as margin', () => {
    expect(schedule.graceLimit?.toISOString()).toBe('2025-11-03T19:29:59.999Z');
    // Half of what the limit leaves, so a margin always survives for the clock-out.
    expect(schedule.graceWorkBound?.toISOString()).toBe('2025-11-03T18:44:59.999Z');
    const marginMs = (schedule.graceLimit as Date).getTime() - (schedule.graceWorkBound as Date).getTime();
    expect(marginMs).toBeGreaterThan(0);
  });

  it('keeps the grace limit inside the grace the calendar would accept', () => {
    expect(calendar.withinGrace(schedule.graceLimit as Date, 'BAY')).toBe(true);
    expect(calendar.withinGrace(schedule.graceWorkBound as Date, 'BAY')).toBe(true);
  });

  it('judges a Saturday against its own shorter window', () => {
    const saturday = on('2025-11-08T10:00:00Z');
    expect(saturday.closesAt?.toISOString()).toBe('2025-11-08T13:00:00.000Z');
    expect(saturday.workBound?.toISOString()).toBe('2025-11-08T13:00:00.000Z');
    expect(saturday.graceWorkBound?.toISOString()).toBe('2025-11-08T13:44:59.999Z');
  });
});

describe('daySchedule — waiting, not giving up', () => {
  it('points at this morning when called before opening', () => {
    const schedule = on('2025-11-03T05:00:00Z');
    expect(schedule.openNow).toBe(false);
    expect(schedule.blocker).toBeUndefined();
    expect(schedule.opensAt?.toISOString()).toBe('2025-11-03T08:00:00.000Z');
    expect(schedule.workBound).toBeNull();
  });

  it('points at the next open date when the window has gone by', () => {
    // A Friday evening start waits for Saturday. Reporting this as a missed window is
    // what made the run skip the day instead of working it.
    const schedule = on('2025-11-07T20:00:00Z');
    expect(schedule.openNow).toBe(false);
    expect(schedule.blocker).toBeUndefined();
    expect(schedule.opensAt?.toISOString()).toBe('2025-11-08T09:00:00.000Z');
  });

  it('crosses a closed Sunday to reach Monday', () => {
    const schedule = on('2025-11-08T14:00:00Z');
    expect(schedule.opensAt?.toISOString()).toBe('2025-11-10T08:00:00.000Z');
  });
});

describe('daySchedule — a date the shop never opens', () => {
  it.each([
    ['Sunday', '2025-11-09T10:00:00Z'],
    ['Christmas', '2025-12-25T10:00:00Z'],
  ])('reports %s as closed, with nothing to bound', (_label, iso) => {
    const schedule = on(iso);
    expect(schedule.blocker).toBe('closed');
    expect(schedule.opensAt).toBeNull();
    expect(schedule.workBound).toBeNull();
    expect(schedule.graceLimit).toBeNull();
    // Mobile units are the whole reason such a day is not simply skipped.
    expect(schedule.mobileOpenNow).toBe(true);
  });

  it('reports mobile as shut too when after-hours mobile work is off', () => {
    const gated = new ShopCalendar(spec({ mobileAfterHours: false }));
    expect(on('2025-11-09T10:00:00Z', gated).mobileOpenNow).toBe(false);
  });
});

describe('daySchedule — the day boundary', () => {
  it('never lets a bound cross midnight, however long the grace', () => {
    // The grace goes to 1440 minutes; close + grace would land on the next date, whose
    // window this comparison knows nothing about, and would date maintenance there.
    const generous = new ShopCalendar(spec({ graceMinutes: 1440 }));
    const schedule = on('2025-11-03T17:00:00Z', generous);

    expect(schedule.graceLimit?.toISOString()).toBe('2025-11-03T23:59:59.999Z');
    expect((schedule.graceWorkBound as Date).getTime()).toBeLessThanOrEqual(
      (schedule.graceLimit as Date).getTime(),
    );
    expect((schedule.graceLimit as Date).getTime()).toBeLessThan(schedule.dayEnd.getTime());
  });

  it('has no grace at all when the window runs to midnight', () => {
    // An all-day window leaves no room after close for a grace, so both bounds are null
    // rather than instants that contradict the work bound. Clamped against the midnight
    // *after* close they landed on the 4th; halved from the configured grace they landed
    // before `workBound`, making the finish-the-car stretch a guaranteed no-op.
    const allDay = new ShopCalendar(spec({ weekday: { openMinutes: 0, closeMinutes: 24 * 60 } }));
    const schedule = on('2025-11-03T10:00:00Z', allDay);

    expect(schedule.workBound?.toISOString()).toBe('2025-11-04T00:00:00.000Z');
    expect(schedule.graceLimit).toBeNull();
    expect(schedule.graceWorkBound).toBeNull();
  });

  it('has no grace bounds at all when no grace is configured', () => {
    // graceMinutes is allowed to be 0. A limit a millisecond *before* `workBound` meant
    // the clock-out was clamped to before the last work tick.
    const noGrace = new ShopCalendar(spec({ graceMinutes: 0 }));
    const schedule = on('2025-11-03T10:00:00Z', noGrace);

    expect(schedule.graceWorkBound).toBeNull();
    expect(schedule.graceLimit).toBeNull();
  });

  it.each([
    ['default', spec()],
    ['zero grace', spec({ graceMinutes: 0 })],
    ['one minute of grace', spec({ graceMinutes: 1 })],
    ['a day of grace', spec({ graceMinutes: 1440 })],
    ['an all-day window', spec({ weekday: { openMinutes: 0, closeMinutes: 24 * 60 } })],
    ['a Saturday short day', spec()],
  ])('keeps the whole set monotonic — %s', (_label, calendarSpec) => {
    // opensAt <= workBound <= graceWorkBound <= graceLimit < dayEnd, for every reachable
    // calendar. This is the property the restructure exists to guarantee, and it has been
    // broken in both directions before, so it is asserted as a chain rather than one bound
    // at a time.
    const cal = new ShopCalendar(calendarSpec);
    for (const iso of ['2025-11-03T10:00:00Z', '2025-11-08T10:00:00Z', '2025-11-03T00:30:00Z']) {
      const schedule = daySchedule(at(iso), cal);
      if (schedule.workBound === null) {
        continue;
      }
      expect((schedule.opensAt as Date).getTime()).toBeLessThanOrEqual(schedule.workBound.getTime());
      if (schedule.graceWorkBound !== null) {
        expect(schedule.workBound.getTime()).toBeLessThanOrEqual(schedule.graceWorkBound.getTime());
        expect(schedule.graceWorkBound.getTime()).toBeLessThanOrEqual((schedule.graceLimit as Date).getTime());
      }
      if (schedule.graceLimit !== null) {
        expect(schedule.graceLimit.getTime()).toBeLessThan(schedule.dayEnd.getTime());
      }
    }
  });

  it('is open at the instant the window opens, and shut at the instant it closes', () => {
    const atOpen = on('2025-11-03T08:00:00Z');
    expect(atOpen.openNow).toBe(true);
    expect(atOpen.closesAt?.toISOString()).toBe('2025-11-03T18:00:00.000Z');
    expect(atOpen.workBound?.toISOString()).toBe('2025-11-03T18:00:00.000Z');

    // Close is exclusive, so this instant is outside the window and the schedule points
    // at the next opening rather than offering a bound to work against.
    const atClose = on('2025-11-03T18:00:00Z');
    expect(atClose.openNow).toBe(false);
    expect(atClose.workBound).toBeNull();
    expect(atClose.opensAt?.toISOString()).toBe('2025-11-04T08:00:00.000Z');
    expect(atClose.blocker).toBeUndefined();
  });
});

describe('clampToGrace', () => {
  const schedule = on('2025-11-03T10:00:00Z');

  it('leaves a legal instant alone', () => {
    expect(clampToGrace(at('2025-11-03T18:30:00Z'), schedule).toISOString()).toBe('2025-11-03T18:30:00.000Z');
  });

  it('pulls an overshoot back to the last legal instant', () => {
    expect(clampToGrace(at('2025-11-03T23:00:00Z'), schedule).toISOString()).toBe('2025-11-03T19:29:59.999Z');
  });

  it('is a no-op on a day with no window', () => {
    const closed = on('2025-11-09T10:00:00Z');
    expect(clampToGrace(at('2025-11-09T23:00:00Z'), closed).toISOString()).toBe('2025-11-09T23:00:00.000Z');
  });
});
