/**
 * Deciding how many appointments a site's upcoming days are short of.
 *
 * The daily appointment run keeps each site's next few weeks booked to a target
 * share of bay time, so the capacity calendar, the schedule view and the
 * dispatch board's look-ahead always have work on them. It is a top-up against
 * what `getScheduleCapacity` reports, not a fixed count per run: shop-manager has
 * no endpoint that lists appointments, but every non-cancelled appointment on a
 * bay is counted in that bay's `occupiedMinutes`, so a day booked by yesterday's
 * run reads as booked today and is left alone.
 *
 * Pure, and typed against structural subsets of the generated models, so the
 * arithmetic is unit-tested without a backend.
 */

/** The fields of `DayCapacityView` this planning reads. */
export interface DayCapacity {
  date: Date;
  status: string;
  dayStartAt?: Date;
  dayEndAt?: Date;
  bays: Array<{ occupiedMinutes: number }>;
}

export interface BookingTargets {
  /** Share of the day's bay minutes to keep booked, 0..1. */
  utilization: number;
  /** Minutes one booked job is assumed to take when sizing the shortfall. */
  jobMinutes: number;
  /** At most this many bookings for one day in one run. */
  maxPerDay: number;
}

export interface DayShortfall {
  /** `YYYY-MM-DD` as the capacity view dates it. */
  date: string;
  dayStartAt: Date;
  dayEndAt: Date;
  bookedMinutes: number;
  capacityMinutes: number;
  jobs: number;
}

const MINUTE = 60_000;

/** `YYYY-MM-DD` for a capacity date (the generated model parses it as UTC midnight). */
export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Every OK day whose booked share is below the target, with the number of jobs
 * that would close the gap, capped per day. Closed, holiday and unavailable days
 * are skipped, as is any day without a window or without bays.
 */
export const planShortfalls = (days: readonly DayCapacity[], targets: BookingTargets): DayShortfall[] => {
  const shortfalls: DayShortfall[] = [];
  for (const day of days) {
    if (String(day.status).toUpperCase() !== 'OK' || !day.dayStartAt || !day.dayEndAt || day.bays.length === 0) {
      continue;
    }
    const windowMinutes = Math.max(0, (day.dayEndAt.getTime() - day.dayStartAt.getTime()) / MINUTE);
    const capacityMinutes = windowMinutes * day.bays.length;
    const bookedMinutes = day.bays.reduce((sum, bay) => sum + Math.max(0, bay.occupiedMinutes), 0);
    const missing = targets.utilization * capacityMinutes - bookedMinutes;
    if (capacityMinutes === 0 || missing <= 0) {
      continue;
    }
    const jobs = Math.min(targets.maxPerDay, Math.ceil(missing / targets.jobMinutes));
    shortfalls.push({
      date: isoDate(day.date),
      dayStartAt: day.dayStartAt,
      dayEndAt: day.dayEndAt,
      bookedMinutes,
      capacityMinutes,
      jobs,
    });
  }
  return shortfalls;
};

/** The structural subset of an `Opening` the picker reads. */
export interface OpeningView {
  bayId: string;
  startAt: Date;
  endAt: Date;
  localDate: string;
}

/**
 * Up to `count` openings on `date`, spread across bays: one per bay first, then
 * a second per bay, and so on, so a day's bookings do not stack on the first bay
 * the search ranks earliest. Openings that overlap one already picked on the
 * same bay are dropped — they come from one search and only one of them could be
 * booked.
 */
export const pickOpenings = <T extends OpeningView>(openings: readonly T[], date: string, count: number): T[] => {
  const byBay = new Map<string, T[]>();
  for (const opening of openings) {
    if (opening.localDate !== date) continue;
    const list = byBay.get(opening.bayId) ?? [];
    list.push(opening);
    byBay.set(opening.bayId, list);
  }

  const picked: T[] = [];
  const overlaps = (a: OpeningView, b: OpeningView) =>
    a.bayId === b.bayId && a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();

  for (let round = 0; picked.length < count; round += 1) {
    let progressed = false;
    for (const list of byBay.values()) {
      const candidate = list[round];
      if (!candidate || picked.length >= count) continue;
      progressed = true;
      if (!picked.some((chosen) => overlaps(chosen, candidate))) {
        picked.push(candidate);
      }
    }
    if (!progressed) break;
  }
  return picked;
};
