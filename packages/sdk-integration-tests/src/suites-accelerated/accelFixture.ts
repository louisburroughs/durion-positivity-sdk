/**
 * What every accelerated suite copy needs, and nothing else.
 *
 * The accelerated suites are copies of the non-accelerated ones (spec: Task A6),
 * and the substitutions they apply are all of one kind: a real date becomes a
 * virtual one, and a labor-bearing step happens only while the shop is open. This
 * module is what those substitutions call, so a copy differs from its twin by a
 * handful of lines rather than by a rewrite — and so the gating rule has exactly
 * one implementation.
 *
 * Nothing here creates data or logs in. The copies keep their own personas,
 * builders and fixtures unchanged.
 */
import { AcceleratedConfig } from '../harness/acceleratedConfig';
import { loadAcceleratedContext } from '../harness/acceleratedContext';
import type { PositionKind } from '../runs/shopFloorPlan';
import { ShopCalendar } from '../harness/shopCalendar';
import { ItestConfig } from '../harness/ItestConfig';
import { VirtualClock, type ServerTime } from '../harness/virtualClock';
import { VirtualTimer } from '../harness/virtualTimer';

export interface ScheduleWindow {
  startAt: Date;
  endAt: Date;
}

export interface AcceleratedFixture {
  clock: VirtualClock;
  timer: VirtualTimer;
  calendar: ShopCalendar;
  /** Virtual seconds per real second, as the backend reports it. */
  scale: number;
  /** The authoritative virtual instant. Never `new Date()`. */
  now(): Promise<Date>;
  /**
   * The virtual instant at which bay work may proceed — now if the shop is
   * already open, otherwise after waiting for it to open. What a labor-bearing
   * step awaits before it runs.
   */
  openNow(kind?: PositionKind): Promise<Date>;
  /**
   * A one-hour schedule window inside an open day `leadDays` virtual days ahead.
   *
   * The non-accelerated suites build these from tomorrow 09:00 real and spread
   * them over months, because nothing in a normal test run can ever reach the slot.
   * Here the slot arrives during the run, so it has to be a *real* open window on a
   * day the shop actually opens.
   */
  futureWindow(leadDays: number, jitterMinutes?: number): Promise<ScheduleWindow>;
  /**
   * Waits for `minutes` of virtual time to pass, and returns where the clock
   * landed.
   *
   * This is the accelerated replacement for the non-accelerated suites' fixed
   * real-time sleeps. Those sleep 1.5 real seconds so a labor entry carries a
   * duration above zero; here a single round trip is already minutes of virtual
   * labor, so what a test needs is not a sleep but a known, asserted virtual
   * interval — and at a thousandfold scale half an hour of it costs about a second.
   */
  elapseVirtual(minutes: number): Promise<Date>;
  /** The reading global setup took, for anchors and scale in a log line. */
  readonly startedFrom: { virtualTime: string; realStart: string; scale: number };
}

export async function acceleratedFixture(): Promise<AcceleratedFixture> {
  const config = ItestConfig.fromEnv();
  const accel = AcceleratedConfig.fromEnv();
  const accelContext = loadAcceleratedContext();

  const clock = new VirtualClock(config.baseUrl, {
    maxSkewMs: accel.maxSkewMs,
    minAnchorGapDays: accel.minAnchorGapDays,
  });
  const timer = new VirtualTimer(clock, { pollMs: accel.pollMs });
  const first: ServerTime = await clock.read();

  // The calendar spans the whole configured run, so its default holiday set covers
  // every calendar year the virtual clock will touch.
  const calendar = accel.calendarFor(
    first.virtualStart,
    new Date(first.virtualTime.getTime() + accel.days * 86_400_000),
  );

  const now = () => clock.now();

  const openNow = async (kind: PositionKind = 'BAY'): Promise<Date> => {
    const at = await now();
    if (calendar.isOpen(at, kind)) {
      return at;
    }
    const open = calendar.nextOpen(at, kind);
    const { observed } = await timer.waitUntil(open, `the shop to open at ${open.toISOString()}`);
    return observed.virtualTime;
  };

  const futureWindow = async (leadDays: number, jitterMinutes = 0): Promise<ScheduleWindow> => {
    const at = await now();
    const target = new Date(at.getTime() + Math.max(1, leadDays) * 86_400_000);
    const open = calendar.nextOpen(target, 'BAY');
    const candidate = new Date(open.getTime() + jitterMinutes * 60_000);
    // Jitter can push past close on a short Saturday; fall back to the window's own
    // opening instant rather than booking into the evening.
    const startAt = calendar.isOpen(candidate, 'BAY') ? candidate : open;
    return { startAt, endAt: new Date(startAt.getTime() + 3_600_000) };
  };

  const elapseVirtual = async (minutes: number): Promise<Date> => {
    const from = await now();
    const target = new Date(from.getTime() + minutes * 60_000);
    const { observed } = await timer.waitUntil(target, `${minutes} virtual minute(s) to pass`);
    return observed.virtualTime;
  };

  return {
    clock,
    timer,
    calendar,
    scale: first.scale,
    now,
    openNow,
    futureWindow,
    elapseVirtual,
    startedFrom: {
      virtualTime: accelContext.clock.virtualTime,
      realStart: accelContext.clock.realStart,
      scale: accelContext.clock.scale,
    },
  };
}
