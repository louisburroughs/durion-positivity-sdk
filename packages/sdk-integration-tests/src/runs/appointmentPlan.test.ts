import { pickOpenings, planShortfalls, type DayCapacity, type OpeningView } from './appointmentPlan';

const TARGETS = { utilization: 0.5, jobMinutes: 60, maxPerDay: 6 };

const day = (date: string, over: Partial<DayCapacity> = {}): DayCapacity => ({
  date: new Date(`${date}T00:00:00Z`),
  status: 'OK',
  dayStartAt: new Date(`${date}T12:00:00Z`),
  dayEndAt: new Date(`${date}T20:00:00Z`), // 8 hours
  bays: [{ occupiedMinutes: 0 }, { occupiedMinutes: 0 }],
  ...over,
});

describe('planShortfalls', () => {
  it('sizes the gap to the target share of bay minutes', () => {
    // 2 bays x 480 min = 960; half is 480; 120 booked leaves 360 = 6 one-hour jobs.
    const [shortfall] = planShortfalls([day('2026-10-05', { bays: [{ occupiedMinutes: 120 }, { occupiedMinutes: 0 }] })], TARGETS);
    expect(shortfall).toMatchObject({ date: '2026-10-05', capacityMinutes: 960, bookedMinutes: 120, jobs: 6 });
  });

  it('caps a day at maxPerDay', () => {
    const [shortfall] = planShortfalls([day('2026-10-05')], { ...TARGETS, maxPerDay: 3 });
    expect(shortfall.jobs).toBe(3);
  });

  it('leaves a day already at or above target alone', () => {
    expect(planShortfalls([day('2026-10-05', { bays: [{ occupiedMinutes: 480 }, { occupiedMinutes: 0 }] })], TARGETS)).toEqual([]);
  });

  it('skips closed days and days without a window or bays', () => {
    expect(
      planShortfalls(
        [
          day('2026-10-04', { status: 'CLOSED' }),
          day('2026-10-05', { dayStartAt: undefined }),
          day('2026-10-06', { bays: [] }),
        ],
        TARGETS,
      ),
    ).toEqual([]);
  });
});

describe('pickOpenings', () => {
  const at = (bayId: string, hour: number, localDate = '2026-10-05'): OpeningView => ({
    bayId,
    localDate,
    startAt: new Date(`${localDate}T${String(hour).padStart(2, '0')}:00:00Z`),
    endAt: new Date(`${localDate}T${String(hour + 1).padStart(2, '0')}:00:00Z`),
  });

  it('spreads picks across bays before doubling up', () => {
    const picked = pickOpenings([at('b1', 12), at('b1', 13), at('b1', 14), at('b2', 12)], '2026-10-05', 3);
    expect(picked.map((o) => `${o.bayId}@${o.startAt.getUTCHours()}`)).toEqual(['b1@12', 'b2@12', 'b1@13']);
  });

  it('ignores openings on other days', () => {
    expect(pickOpenings([at('b1', 12, '2026-10-06')], '2026-10-05', 2)).toEqual([]);
  });

  it('drops an opening overlapping one already picked on the same bay', () => {
    const overlapping: OpeningView = { ...at('b1', 12), startAt: new Date('2026-10-05T12:30:00Z'), endAt: new Date('2026-10-05T13:30:00Z') };
    const picked = pickOpenings([at('b1', 12), overlapping], '2026-10-05', 2);
    expect(picked).toHaveLength(1);
  });

  it('returns fewer than asked when the day runs out', () => {
    expect(pickOpenings([at('b1', 12)], '2026-10-05', 4)).toHaveLength(1);
  });
});
