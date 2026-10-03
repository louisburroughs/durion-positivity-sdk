import { HOLD_POINTS } from './acceleratedJob';
import { convergenceAt, createHoldPolicy, tailStartsAt } from './openWorkTail';

const DAY = 86_400_000;

describe('convergenceAt', () => {
  it('solves virtualStart + scale * (t - realStart) = t', () => {
    const realStart = new Date('2026-09-29T22:00:00Z');
    // A year behind at scale 1000 closes in 365/999 days of wall time.
    const virtualStart = new Date(realStart.getTime() - 365 * DAY);
    const at = convergenceAt(realStart, virtualStart, 1000) as Date;
    const virtualThen = virtualStart.getTime() + 1000 * (at.getTime() - realStart.getTime());
    // Date truncates to whole milliseconds, which scale multiplies back up.
    expect(Math.abs(virtualThen - at.getTime())).toBeLessThan(1_000);
    expect(Math.abs(at.getTime() - realStart.getTime() - (365 * DAY) / 999)).toBeLessThan(1_000);
  });

  it('is undefined for a clock that cannot converge', () => {
    expect(convergenceAt(new Date(), new Date(0), 1)).toBeUndefined();
  });
});

describe('tailStartsAt', () => {
  const virtualEnd = new Date('2026-12-31T00:00:00Z');

  it('counts back from the earlier of the planned end and convergence', () => {
    const convergeAt = new Date('2026-10-01T00:00:00Z');
    expect(tailStartsAt({ virtualEnd, convergeAt, tailDays: 5 })?.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(tailStartsAt({ virtualEnd, convergeAt: undefined, tailDays: 1 })?.toISOString()).toBe('2026-12-30T00:00:00.000Z');
  });

  it('is disabled by zero tail days', () => {
    expect(tailStartsAt({ virtualEnd, convergeAt: undefined, tailDays: 0 })).toBeUndefined();
  });
});

describe('createHoldPolicy', () => {
  const startsAt = new Date('2026-09-26T00:00:00Z');
  const always = { chance: () => true, int: (min: number) => min };
  const never = { chance: () => false, int: (min: number) => min };

  it('runs every job to the end before the tail', () => {
    expect(createHoldPolicy({ startsAt, ratio: 1, random: always })(new Date('2026-09-25T23:59:59Z'))).toBeUndefined();
  });

  it('holds a drawn job inside the tail at a hold point', () => {
    const hold = createHoldPolicy({ startsAt, ratio: 0.3, random: always })(new Date('2026-09-27T10:00:00Z'));
    expect(HOLD_POINTS).toContain(hold);
  });

  it('leaves an undrawn job alone, and a zero ratio or no tail holds nothing', () => {
    const inside = new Date('2026-09-27T10:00:00Z');
    expect(createHoldPolicy({ startsAt, ratio: 0.3, random: never })(inside)).toBeUndefined();
    expect(createHoldPolicy({ startsAt, ratio: 0, random: always })(inside)).toBeUndefined();
    expect(createHoldPolicy({ startsAt: undefined, ratio: 1, random: always })(inside)).toBeUndefined();
  });
});
