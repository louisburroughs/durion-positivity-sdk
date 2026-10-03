/**
 * The open-work tail: where the accelerated year stops finishing every job.
 *
 * The year run takes each job from estimate to paid invoice inside a day or two,
 * so when it ends nothing is open — no estimate awaiting a customer, no approved
 * workorder awaiting dispatch, no car on a bay. A freshly deployed alpha then
 * looks like a shop that closed for good the day the run finished. In the last
 * `tailDays` virtual days before the run's end, a share of new jobs stop short at
 * one of the `HOLD_POINTS` instead, and stay that way for the environment that
 * outlives the run (the daily shop-floor close-out finishes the ones on a bay).
 *
 * Pure, so the window arithmetic and the draw are unit-tested.
 */
import { HOLD_POINTS, type HoldPoint, type JobRandom } from './acceleratedJob';

const DAY_MS = 86_400_000;

/**
 * The wall-clock instant a converging accelerated clock catches up with wall
 * time: virtualStart + scale * (t - realStart) = t. Undefined for a clock that
 * never converges (scale at or below 1).
 */
export const convergenceAt = (realStart: Date, virtualStart: Date, scale: number): Date | undefined => {
  if (!(scale > 1)) {
    return undefined;
  }
  return new Date((scale * realStart.getTime() - virtualStart.getTime()) / (scale - 1));
};

/**
 * The first virtual instant of the tail: `tailDays` before whichever comes first,
 * the run's planned end or the clock's convergence. Undefined disables the tail.
 */
export const tailStartsAt = (options: {
  virtualEnd: Date;
  convergeAt: Date | undefined;
  tailDays: number;
}): Date | undefined => {
  if (options.tailDays <= 0) {
    return undefined;
  }
  const end = Math.min(options.virtualEnd.getTime(), options.convergeAt?.getTime() ?? Number.POSITIVE_INFINITY);
  return new Date(end - options.tailDays * DAY_MS);
};

/** The `holdAt` a job is given: inside the tail, `ratio` of jobs stop at a uniformly drawn hold point. */
export const createHoldPolicy = (options: {
  startsAt: Date | undefined;
  ratio: number;
  random: Pick<JobRandom, 'chance' | 'int'>;
}): ((at: Date) => HoldPoint | undefined) => {
  const { startsAt, ratio, random } = options;
  return (at: Date) => {
    if (startsAt === undefined || ratio <= 0 || at.getTime() < startsAt.getTime() || !random.chance(ratio)) {
      return undefined;
    }
    return HOLD_POINTS[random.int(0, HOLD_POINTS.length - 1)];
  };
};
