import {
  holidaysForSpan,
  parseTimeOfDay,
  parseWindow,
  ShopCalendar,
  usFederalHolidays,
  utcDateKey,
  type CalendarSpec,
} from './shopCalendar';

const spec = (overrides: Partial<CalendarSpec> = {}): CalendarSpec => ({
  weekday: { openMinutes: 8 * 60, closeMinutes: 18 * 60 },
  saturday: { openMinutes: 9 * 60, closeMinutes: 13 * 60 },
  sunday: null,
  holidays: new Set(['2025-12-25']),
  graceMinutes: 90,
  mobileAfterHours: true,
  ...overrides,
});

const at = (iso: string) => new Date(iso);

// 2025-11-03 is a Monday; 11-08 Saturday; 11-09 Sunday; 12-25 Christmas (Thursday).
describe('parseTimeOfDay', () => {
  it('reads HH:MM as minutes from midnight', () => {
    expect(parseTimeOfDay('08:00', 'x')).toBe(480);
    expect(parseTimeOfDay('00:00', 'x')).toBe(0);
    expect(parseTimeOfDay('23:59', 'x')).toBe(1439);
  });

  it.each(['24:00', '8:00', '08:60', 'eight', '', '08:00:00'])('refuses %p', (value) => {
    expect(() => parseTimeOfDay(value, 'ITEST_ACCEL_OPEN_TIME')).toThrow(/ITEST_ACCEL_OPEN_TIME must be HH:MM/);
  });
});

describe('parseWindow', () => {
  it('reads a range', () => {
    expect(parseWindow('09:00-13:00', 'x')).toEqual({ openMinutes: 540, closeMinutes: 780 });
  });

  it('reads closed, in any case', () => {
    expect(parseWindow('closed', 'x')).toBeNull();
    expect(parseWindow('CLOSED', 'x')).toBeNull();
  });

  it('refuses a window that closes before it opens', () => {
    expect(() => parseWindow('18:00-09:00', 'ITEST_ACCEL_SATURDAY')).toThrow(/must open before it closes/);
  });

  it('refuses a malformed range', () => {
    expect(() => parseWindow('09:00', 'ITEST_ACCEL_SATURDAY')).toThrow(/HH:MM-HH:MM/);
  });
});

describe('usFederalHolidays', () => {
  it('computes the movable ones rather than tabulating them', () => {
    const keys = usFederalHolidays(2025);
    expect(keys).toContain('2025-01-01');
    expect(keys).toContain('2025-01-20'); // 3rd Monday of January
    expect(keys).toContain('2025-05-26'); // last Monday of May
    expect(keys).toContain('2025-06-19');
    expect(keys).toContain('2025-09-01'); // 1st Monday of September
    expect(keys).toContain('2025-11-27'); // 4th Thursday of November
    expect(keys).toContain('2025-12-25');
    expect(keys).toHaveLength(11);
  });

  it('covers every calendar year a virtual span touches', () => {
    const keys = holidaysForSpan(at('2025-09-17T12:00:00Z'), at('2026-09-17T12:00:00Z'));
    expect(keys).toContain('2025-12-25');
    expect(keys).toContain('2026-07-04');
  });
});

describe('ShopCalendar — when a bay may work', () => {
  const calendar = new ShopCalendar(spec());

  it('is open inside the weekday window', () => {
    expect(calendar.isOpen(at('2025-11-03T08:00:00Z'), 'BAY')).toBe(true);
    expect(calendar.isOpen(at('2025-11-03T17:59:00Z'), 'BAY')).toBe(true);
  });

  it('is shut before open, at close, and after', () => {
    expect(calendar.isOpen(at('2025-11-03T07:59:00Z'), 'BAY')).toBe(false);
    expect(calendar.isOpen(at('2025-11-03T18:00:00Z'), 'BAY')).toBe(false);
    expect(calendar.isOpen(at('2025-11-03T23:00:00Z'), 'BAY')).toBe(false);
  });

  it('keeps Saturday short and Sunday shut', () => {
    expect(calendar.isOpen(at('2025-11-08T10:00:00Z'), 'BAY')).toBe(true);
    expect(calendar.isOpen(at('2025-11-08T14:00:00Z'), 'BAY')).toBe(false);
    expect(calendar.isOpen(at('2025-11-09T10:00:00Z'), 'BAY')).toBe(false);
  });

  it('shuts on a holiday that would otherwise be a working day', () => {
    expect(at('2025-12-25T00:00:00Z').getUTCDay()).toBe(4); // a Thursday
    expect(calendar.isOpen(at('2025-12-25T10:00:00Z'), 'BAY')).toBe(false);
    expect(calendar.isWorkingDay(at('2025-12-25T10:00:00Z'))).toBe(false);
  });
});

describe('ShopCalendar — a mobile unit works at any hour', () => {
  const calendar = new ShopCalendar(spec());

  it.each([
    ['midnight on a working day', '2025-11-03T00:30:00Z'],
    ['a Sunday', '2025-11-09T03:00:00Z'],
    ['Christmas', '2025-12-25T22:00:00Z'],
  ])('is open at %s', (_label, iso) => {
    expect(calendar.isOpen(at(iso), 'MOBILE_UNIT')).toBe(true);
    expect(calendar.nextOpen(at(iso), 'MOBILE_UNIT').toISOString()).toBe(at(iso).toISOString());
    expect(calendar.closesAt(at(iso), 'MOBILE_UNIT')).toBeNull();
  });

  it('behaves like a bay when after-hours mobile work is switched off', () => {
    const gated = new ShopCalendar(spec({ mobileAfterHours: false }));
    expect(gated.isOpen(at('2025-11-09T03:00:00Z'), 'MOBILE_UNIT')).toBe(false);
    expect(gated.isOpen(at('2025-11-03T10:00:00Z'), 'MOBILE_UNIT')).toBe(true);
  });
});

describe('ShopCalendar — closesAt and the overrun grace', () => {
  const calendar = new ShopCalendar(spec());

  it('names the close boundary of the window it is in', () => {
    expect(calendar.closesAt(at('2025-11-03T10:00:00Z'), 'BAY')?.toISOString()).toBe('2025-11-03T18:00:00.000Z');
    expect(calendar.closesAt(at('2025-11-08T10:00:00Z'), 'BAY')?.toISOString()).toBe('2025-11-08T13:00:00.000Z');
  });

  it('has no boundary outside a window', () => {
    expect(calendar.closesAt(at('2025-11-03T19:00:00Z'), 'BAY')).toBeNull();
    expect(calendar.closesAt(at('2025-11-09T10:00:00Z'), 'BAY')).toBeNull();
  });

  it('lets a started job finish inside the grace but not beyond it', () => {
    expect(calendar.withinGrace(at('2025-11-03T18:30:00Z'), 'BAY')).toBe(true);
    expect(calendar.withinGrace(at('2025-11-03T19:29:00Z'), 'BAY')).toBe(true);
    expect(calendar.withinGrace(at('2025-11-03T19:31:00Z'), 'BAY')).toBe(false);
  });

  it('never opens work inside the grace — withinGrace is not isOpen', () => {
    expect(calendar.isOpen(at('2025-11-03T18:30:00Z'), 'BAY')).toBe(false);
  });
});

describe('ShopCalendar — nextOpen', () => {
  const calendar = new ShopCalendar(spec());

  it('is now when the shop is already open', () => {
    expect(calendar.nextOpen(at('2025-11-03T10:00:00Z'), 'BAY').toISOString()).toBe('2025-11-03T10:00:00.000Z');
  });

  it('is this morning when called before opening', () => {
    expect(calendar.nextOpen(at('2025-11-03T05:00:00Z'), 'BAY').toISOString()).toBe('2025-11-03T08:00:00.000Z');
  });

  it('is tomorrow morning when called after close', () => {
    expect(calendar.nextOpen(at('2025-11-03T19:00:00Z'), 'BAY').toISOString()).toBe('2025-11-04T08:00:00.000Z');
  });

  it('crosses a closed Sunday', () => {
    expect(calendar.nextOpen(at('2025-11-08T14:00:00Z'), 'BAY').toISOString()).toBe('2025-11-10T08:00:00.000Z');
  });

  it('crosses a holiday next to a weekend — the case a closed form gets wrong', () => {
    // Saturday 2025-12-27 closed, Sunday 12-28 shut, so Friday evening 12-26
    // reaches Saturday's short window; with Saturday closed too it must find Monday.
    const closedSaturday = new ShopCalendar(spec({ saturday: null, holidays: new Set(['2025-12-25', '2025-12-26']) }));
    expect(closedSaturday.nextOpen(at('2025-12-24T19:00:00Z'), 'BAY').toISOString()).toBe('2025-12-29T08:00:00.000Z');
  });

  it('throws rather than hanging when every day is closed', () => {
    const shut = new ShopCalendar(spec({ weekday: { openMinutes: 0, closeMinutes: 1 }, saturday: null, sunday: null }));
    const everyDayClosed = new ShopCalendar({
      ...spec(),
      saturday: null,
      sunday: null,
      holidays: new Set(
        Array.from({ length: 420 }, (_, index) => utcDateKey(new Date(Date.parse('2025-11-03T00:00:00Z') + index * 86_400_000))),
      ),
    });
    expect(shut.nextOpen(at('2025-11-03T05:00:00Z'), 'BAY')).toBeInstanceOf(Date);
    expect(() => everyDayClosed.nextOpen(at('2025-11-03T05:00:00Z'), 'BAY')).toThrow(/no open day in the next 400 days/);
  });
});

describe('ShopCalendar — window sizes and open-day counts', () => {
  const calendar = new ShopCalendar(spec());

  it('reports the open minutes of a day', () => {
    expect(calendar.openMinutesOn(at('2025-11-03T10:00:00Z'))).toBe(600);
    expect(calendar.openMinutesOn(at('2025-11-08T10:00:00Z'))).toBe(240);
    expect(calendar.openMinutesOn(at('2025-11-09T10:00:00Z'))).toBe(0);
  });

  it('reports the tightest window, which is what work must fit into', () => {
    expect(calendar.shortestOpenMinutes()).toBe(240);
    expect(new ShopCalendar(spec({ saturday: null })).shortestOpenMinutes()).toBe(600);
  });

  it('counts open days in a span, excluding weekends and holidays', () => {
    // Mon 2025-11-03 through Sun 2025-11-09: 5 weekdays + Saturday = 6.
    expect(calendar.countOpenDays(at('2025-11-03T00:00:00Z'), at('2025-11-10T00:00:00Z'))).toBe(6);
    // The Christmas week loses the Thursday.
    expect(calendar.countOpenDays(at('2025-12-22T00:00:00Z'), at('2025-12-29T00:00:00Z'))).toBe(5);
  });
});
