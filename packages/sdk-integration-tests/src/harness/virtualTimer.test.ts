import { ClockConvergedError, type ServerTime, VirtualClock } from './virtualClock';
import { nextUtcMidnight, realMsForVirtualMs, VirtualTimer } from './virtualTimer';

/** A clock stub that walks a scripted list of virtual instants. */
const scriptedClock = (
  instants: string[],
  options: { scale?: number; convergesAt?: number } = {},
): { clock: VirtualClock; reads: () => number } => {
  let index = 0;
  const scale = options.scale ?? 1460;
  const stub = {
    async read(): Promise<ServerTime> {
      const at = instants[Math.min(index, instants.length - 1)];
      const converged = options.convergesAt !== undefined && index >= options.convergesAt;
      index += 1;
      return {
        virtualTime: new Date(at),
        scale,
        zone: 'UTC',
        accelerated: true,
        converged,
        realStart: new Date('2026-09-17T12:00:00.000Z'),
        virtualStart: new Date('2025-09-17T12:00:00.000Z'),
        readAt: new Date(),
      };
    },
    async now(): Promise<Date> {
      return (await this.read()).virtualTime;
    },
  };
  return { clock: stub as unknown as VirtualClock, reads: () => index };
};

describe('nextUtcMidnight', () => {
  it('is the midnight after the instant, never the one it sits on', () => {
    expect(nextUtcMidnight(new Date('2025-11-03T08:30:00Z')).toISOString()).toBe('2025-11-04T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2025-11-03T00:00:00Z')).toISOString()).toBe('2025-11-04T00:00:00.000Z');
    expect(nextUtcMidnight(new Date('2025-12-31T23:59:59Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('realMsForVirtualMs', () => {
  it('divides the virtual gap by the scale', () => {
    expect(realMsForVirtualMs(1_460_000, 1460)).toBe(1000);
    expect(realMsForVirtualMs(0, 1460)).toBe(0);
    expect(realMsForVirtualMs(-500, 1460)).toBe(0);
  });
});

describe('VirtualTimer', () => {
  it('returns at once when the target is already past — the boundary arrived mid-request', async () => {
    const { clock, reads } = scriptedClock(['2025-11-04T00:05:00Z']);
    const result = await new VirtualTimer(clock, { pollMs: 1 }).waitUntil(new Date('2025-11-04T00:00:00Z'));

    expect(result.observed.virtualTime.toISOString()).toBe('2025-11-04T00:05:00.000Z');
    expect(reads()).toBe(1);
  });

  it('polls until the clock reaches the target', async () => {
    const { clock } = scriptedClock([
      '2025-11-03T23:59:00Z',
      '2025-11-03T23:59:40Z',
      '2025-11-04T00:00:01Z',
    ]);
    const result = await new VirtualTimer(clock, { pollMs: 1 }).waitUntil(new Date('2025-11-04T00:00:00Z'));

    expect(result.polls).toBe(3);
    expect(result.observed.virtualTime.toISOString()).toBe('2025-11-04T00:00:01.000Z');
  });

  it('waitForNextDay crosses into the next calendar day', async () => {
    const { clock } = scriptedClock(['2025-11-03T18:00:00Z', '2025-11-04T00:00:02Z']);
    const result = await new VirtualTimer(clock, { pollMs: 1 }).waitForNextDay(new Date('2025-11-03T09:00:00Z'));

    expect(result.observed.virtualTime.toISOString()).toBe('2025-11-04T00:00:02.000Z');
  });

  it('throws ClockConvergedError rather than waiting at scale 1', async () => {
    const { clock } = scriptedClock(['2025-11-03T09:00:00Z'], { convergesAt: 0 });
    await expect(
      new VirtualTimer(clock, { pollMs: 1 }).waitUntil(new Date('2025-11-10T00:00:00Z')),
    ).rejects.toThrow(ClockConvergedError);
  });

  it('gives up on a frozen clock instead of hanging the run', async () => {
    const { clock } = scriptedClock(['2025-11-03T09:00:00Z']);
    await expect(
      // A one-hour virtual wait at scale 1460 predicts ~2.5s; the floor and
      // factor are shrunk so the test does not spend that long proving it.
      new VirtualTimer(clock, { pollMs: 1, budgetFloorMs: 20, budgetFactor: 1 }).waitUntil(
        new Date('2025-11-03T10:00:00Z'),
        'the shop to open',
      ),
    ).rejects.toThrow(/waited \d+s for the shop to open.*has stopped/s);
  });

  it('does not extend its own deadline as the clock creeps', async () => {
    // Creeping forward by a virtual second per poll never reaches the target,
    // and a deadline recomputed per poll would keep moving with it.
    const creeping = Array.from({ length: 500 }, (_, index) =>
      new Date(Date.parse('2025-11-03T09:00:00Z') + index * 1000).toISOString(),
    );
    const { clock } = scriptedClock(creeping);
    await expect(
      // Half an hour of virtual time predicts ~1.2s real at scale 1460, and the
      // creep tops out well short of it — so the fixed deadline is what ends this.
      new VirtualTimer(clock, { pollMs: 1, budgetFloorMs: 30, budgetFactor: 1 }).waitUntil(
        new Date('2025-11-03T09:30:00Z'),
      ),
    ).rejects.toThrow(/backend clock is slower than its reported scale/);
  });
});
