/**
 * Waiting in virtual time.
 *
 * The suites' only sanctioned wait for *state* is `waitFor`; this is the only
 * sanctioned wait for the *clock*. The distinction matters: `waitFor` polls
 * until the backend has caught up with something the test already did, while
 * this polls until the backend's calendar has moved somewhere the test wants to
 * be. Confusing the two is how an accelerated run ends up asserting that a
 * weekend passed because a Kafka consumer was slow.
 *
 * Every wait is bounded, and the bound is derived from the observed scale rather
 * than configured: `scale` virtual seconds pass per real second, so a wait for a
 * virtual instant `d` away should take `d / scale` real time. The budget is that
 * figure with slack, so a stalled backend clock fails in seconds instead of
 * hanging out a six-hour run.
 */
import { ClockConvergedError, VirtualClock, type ServerTime } from './virtualClock';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface VirtualTimerOptions {
  /** `/system/time` poll interval, real ms. */
  pollMs?: number;
  /**
   * Multiplier applied to the predicted real duration of a wait to get its
   * deadline, plus `budgetFloorMs`. Generous because the prediction assumes a
   * steady scale and one HTTP round trip per poll, and neither is guaranteed.
   */
  budgetFactor?: number;
  budgetFloorMs?: number;
}

export interface WaitResult {
  /** The reading that satisfied the wait. */
  observed: ServerTime;
  /** Real milliseconds the wait actually took. */
  realElapsedMs: number;
  /** How many times `/system/time` was read. */
  polls: number;
}

/** Midnight UTC strictly after `instant`. */
export function nextUtcMidnight(instant: Date): Date {
  const next = new Date(instant);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Real milliseconds a virtual gap of `virtualMs` takes at `scale`. */
export function realMsForVirtualMs(virtualMs: number, scale: number): number {
  return virtualMs <= 0 ? 0 : virtualMs / scale;
}

export class VirtualTimer {
  private readonly pollMs: number;
  private readonly budgetFactor: number;
  private readonly budgetFloorMs: number;

  constructor(
    private readonly clock: VirtualClock,
    options: VirtualTimerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 500;
    this.budgetFactor = options.budgetFactor ?? 4;
    this.budgetFloorMs = options.budgetFloorMs ?? 15_000;
  }

  /**
   * Polls until the backend's virtual time reaches `target`.
   *
   * Returns immediately when the clock is already there — a caller that asks to
   * wait for an instant already past has not made a mistake, it has discovered
   * that the day boundary arrived while its last request was in flight.
   *
   * Throws {@link ClockConvergedError} when the clock has caught up with wall
   * time and the target is still in the future: at scale 1 that wait would take
   * as long as the wait itself, which is never what an accelerated run wants.
   */
  async waitUntil(target: Date, description = `virtual time ${target.toISOString()}`): Promise<WaitResult> {
    const startedAt = Date.now();
    let polls = 0;
    let deadline: number | undefined;

    for (;;) {
      const observed = await this.clock.read();
      polls += 1;

      if (observed.virtualTime.getTime() >= target.getTime()) {
        return { observed, realElapsedMs: Date.now() - startedAt, polls };
      }
      if (observed.converged) {
        throw new ClockConvergedError(
          observed,
          `still waiting for ${description}, which the clock can no longer reach at speed`,
        );
      }

      // Recomputed from the first reading only: a budget that moved with every
      // poll would never expire against a frozen clock, which is the failure
      // this bound exists to catch.
      if (deadline === undefined) {
        const predictedMs = realMsForVirtualMs(
          target.getTime() - observed.virtualTime.getTime(),
          observed.scale,
        );
        deadline = startedAt + Math.max(this.budgetFloorMs, predictedMs * this.budgetFactor);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `[accel] waited ${Math.round((Date.now() - startedAt) / 1000)}s for ${description} but the ` +
            `backend clock only reached ${observed.virtualTime.toISOString()} (scale ${observed.scale}, ` +
            `${polls} polls). The backend clock is slower than its reported scale, or it has stopped.`,
        );
      }

      await sleep(this.pollMs);
    }
  }

  /** Waits for the virtual calendar to cross into the day after `from`. */
  async waitForNextDay(from: Date): Promise<WaitResult> {
    const midnight = nextUtcMidnight(from);
    return this.waitUntil(midnight, `the virtual day after ${from.toISOString().slice(0, 10)}`);
  }

  /** The current virtual instant, without waiting. */
  async now(): Promise<Date> {
    return this.clock.now();
  }

  /** The current reading, without waiting. */
  async read(): Promise<ServerTime> {
    return this.clock.read();
  }
}
