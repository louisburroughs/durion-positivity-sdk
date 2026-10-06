/**
 * Which site the accelerated year gives its next job to (#157).
 *
 * A real shop's volume follows how much work it can take at once: the positions it
 * has that it can also crew. So each site's share of the day's jobs is in proportion
 * to that, its *capacity* — the smaller of its positions and its technicians, busy or
 * free, as the dispatch board and the staffing read report them. The next job goes to
 * the site furthest below its share: the one with the fewest jobs started today per
 * unit of capacity. Two sites level on that measure keep the order discovery returned
 * them in, so the order is deterministic.
 *
 * The previous rule tried the sites in discovery order and took the first claim
 * offered, so the first site with a free position absorbed the whole day and the rest
 * were reached only when it was momentarily full — 1,124 bay intervals at one site
 * and 4 at another on alpha.
 *
 * Pure, so the arithmetic is unit-tested without a backend.
 */
import type { PositionKind, SiteRoster } from '../runs/shopFloorPlan';

/**
 * How much work of {@code kind} a site can take at once: positions of that kind it can
 * also crew. Without a kind, every position counts. A mobile-only intake (a closed day,
 * after the bays close) is weighed by mobile units alone, so a site with many bays and
 * one mobile unit does not take most of the mobile work.
 */
export const siteCapacity = (roster: SiteRoster, kind?: PositionKind): number => {
  const positions = [...roster.freePositions, ...roster.occupiedPositions].filter(
    (position) => kind === undefined || position.kind === kind,
  ).length;
  return Math.min(positions, roster.idleTechnicianIds.length + roster.busyTechnicianIds.length);
};

/**
 * The rosters in the order a claim should be tried: furthest below its share first.
 *
 * {@code startedToday} counts jobs started per site (by {@code locationId}) so far
 * today, of {@code kind} when one is given — the caller keeps the two counts apart so a
 * share of one kind of work is measured against that kind's capacity. A site with no
 * capacity is placed last; it can take nothing anyway, and dividing by zero would put
 * it first.
 */
export const siteClaimOrder = (
  rosters: readonly SiteRoster[],
  startedToday: ReadonlyMap<string, number>,
  kind?: PositionKind,
): SiteRoster[] =>
  rosters
    .map((roster, index) => ({ roster, index, capacity: siteCapacity(roster, kind) }))
    .sort((a, b) => {
      if (a.capacity === 0 || b.capacity === 0) {
        return a.capacity === 0 && b.capacity === 0 ? a.index - b.index : a.capacity === 0 ? 1 : -1;
      }
      // started_a / capacity_a against started_b / capacity_b, cross-multiplied so the
      // comparison stays in integers.
      const share =
        (startedToday.get(a.roster.locationId) ?? 0) * b.capacity -
        (startedToday.get(b.roster.locationId) ?? 0) * a.capacity;
      return share !== 0 ? share : a.index - b.index;
    })
    .map((entry) => entry.roster);
