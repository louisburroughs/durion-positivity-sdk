import { jitterFor, localClock, planDay, runDaysLeftInMonth, type LastRun, type PlanOptions, type Schedulable } from './planner';

const TZ = 'America/New_York';
const OPTIONS: PlanOptions = { runDays: [1, 2, 3, 4, 5, 6], jitterMinutes: 0, maxLatenessMinutes: 180 };

const daily: Schedulable = { id: 'open-shop', title: '', cadence: 'daily', at: '07:45' };
const weekly: Schedulable = { id: 'cycle-count', title: '', cadence: 'weekly', weekday: 2, at: '10:00' };
const monthly: Schedulable = { id: 'period-close', title: '', cadence: 'monthly', dayOfMonth: 1, at: '09:00' };

/** `2026-03-10 09:00` shop time → the instant. March 10 2026 is a Tuesday, in daylight time (UTC-4). */
const at = (local: string): Date => new Date(`${local.replace(' ', 'T')}:00-04:00`);
const statusOf = (scenario: Schedulable, when: Date, last?: LastRun, options: PlanOptions = OPTIONS): string =>
  planDay([scenario], localClock(when, TZ), last ? { [scenario.id]: last } : {}, options)[0].status;

describe('localClock', () => {
  it('reads the shop calendar, not the machine one', () => {
    // 02:30 UTC on the 11th is still the evening of the 10th in New York.
    expect(localClock(new Date('2026-03-11T02:30:00Z'), TZ)).toEqual({
      date: '2026-03-10',
      month: '2026-03',
      week: '2026-W11',
      weekday: 2,
      dayOfMonth: 10,
      minutes: 22 * 60 + 30,
    });
  });

  it('numbers ISO weeks across a year boundary', () => {
    expect(localClock(new Date('2027-01-01T17:00:00Z'), TZ).week).toBe('2026-W53');
    expect(localClock(new Date('2026-12-28T17:00:00Z'), TZ)).toMatchObject({ week: '2026-W53', weekday: 1 });
    expect(localClock(new Date('2027-01-04T17:00:00Z'), TZ).week).toBe('2027-W01');
  });
});

describe('planDay', () => {
  it('runs a daily scenario at its time, once', () => {
    expect(statusOf(daily, at('2026-03-10 07:30'))).toBe('upcoming');
    expect(statusOf(daily, at('2026-03-10 07:45'))).toBe('due');
    expect(statusOf(daily, at('2026-03-10 09:00'), { date: '2026-03-10', week: '2026-W11', month: '2026-03' })).toBe('done');
    expect(statusOf(daily, at('2026-03-11 08:00'), { date: '2026-03-10', week: '2026-W11', month: '2026-03' })).toBe('due');
  });

  it('skips a daily scenario whose time of day is long past, rather than running it out of character', () => {
    expect(statusOf(daily, at('2026-03-10 10:45'))).toBe('due');
    expect(statusOf(daily, at('2026-03-10 10:46'))).toBe('missed');
  });

  it('keeps a weekly scenario due from its weekday until it has run that week', () => {
    expect(statusOf(weekly, at('2026-03-09 12:00'))).toBe('not-today'); // Monday
    expect(statusOf(weekly, at('2026-03-10 09:00'))).toBe('upcoming'); // Tuesday, before 10:00
    expect(statusOf(weekly, at('2026-03-10 16:00'))).toBe('due'); // hours late is still due
    expect(statusOf(weekly, at('2026-03-12 11:00'))).toBe('due'); // missed Tuesday and Wednesday
    expect(statusOf(weekly, at('2026-03-12 11:00'), { date: '2026-03-10', week: '2026-W11', month: '2026-03' })).toBe('done');
    expect(statusOf(weekly, at('2026-03-17 11:00'), { date: '2026-03-10', week: '2026-W11', month: '2026-03' })).toBe('due');
  });

  it('keeps a monthly scenario due from its day until it has run that month', () => {
    const late: Schedulable = { ...monthly, dayOfMonth: 15 };
    expect(statusOf(late, at('2026-03-14 12:00'))).toBe('not-today');
    expect(statusOf(late, at('2026-03-16 12:00'))).toBe('due'); // the 15th was a Sunday
    expect(statusOf(late, at('2026-03-30 12:00'))).toBe('due');
    expect(statusOf(late, at('2026-03-30 12:00'), { date: '2026-03-16', week: '2026-W12', month: '2026-03' })).toBe('done');
    expect(statusOf(late, at('2026-04-15 12:00'), { date: '2026-03-16', week: '2026-W12', month: '2026-03' })).toBe('due');
  });

  it('runs nothing on a day the shop is closed, and loses nothing weekly or monthly by it', () => {
    // The 15th of March 2026 is a Sunday.
    const closing: Schedulable = { ...monthly, dayOfMonth: 15 };
    const sunday = at('2026-03-15 12:00');
    expect(statusOf(daily, sunday)).toBe('not-today');
    expect(statusOf(closing, sunday)).toBe('not-today');
    expect(statusOf(closing, at('2026-03-16 09:30'))).toBe('due');
  });

  it('orders the day by time', () => {
    const slots = planDay([weekly, monthly, daily], localClock(at('2026-03-10 06:00'), TZ), {}, OPTIONS);
    expect(slots.map((slot) => slot.scenario.id)).toEqual(['open-shop', 'period-close', 'cycle-count']);
  });

  it('shifts each slot by a jitter that is stable within a day and varies between days', () => {
    const options = { ...OPTIONS, jitterMinutes: 10 };
    const minutesOn = (date: string): number => planDay([daily], localClock(at(`${date} 06:00`), TZ), {}, options)[0].minutes;
    expect(minutesOn('2026-03-10')).toBe(minutesOn('2026-03-10'));
    const spread = new Set(['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-16'].map(minutesOn));
    expect(spread.size).toBeGreaterThan(1);
    for (const minutes of spread) {
      expect(Math.abs(minutes - (7 * 60 + 45))).toBeLessThanOrEqual(10);
    }
    expect(jitterFor('2026-03-10', 'open-shop', 0)).toBe(0);
  });
});

describe('runDaysLeftInMonth', () => {
  it('counts open days from today to month end', () => {
    expect(runDaysLeftInMonth(localClock(at('2026-03-01 12:00'), TZ), OPTIONS.runDays)).toBe(26); // 31 days, 5 Sundays
    expect(runDaysLeftInMonth(localClock(at('2026-03-30 12:00'), TZ), OPTIONS.runDays)).toBe(2);
    expect(runDaysLeftInMonth(localClock(at('2026-03-31 12:00'), TZ), OPTIONS.runDays)).toBe(1);
  });
});
