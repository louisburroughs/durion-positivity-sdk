/**
 * Turning one location's dispatch board and staffing roll into a `SiteRoster`.
 *
 * Pure, and typed against structural subsets of the generated models rather
 * than the models themselves, so the mapping that decides what counts as a free
 * position and an idle technician is unit-tested. It is the half of discovery
 * that can be wrong without a network call.
 */
import type { ShopPosition, SiteRoster } from './shopFloorPlan';

/** The fields of `DashboardResponse` this mapping reads. */
export interface BoardView {
  dataQualityWarning?: boolean;
  bays?: Array<{ bayId: string; bayName?: string; available: boolean; assignedWorkorderId?: string }>;
  mobileUnits?: Array<{ unitId: string; unitName?: string; available: boolean; assignedWorkorderId?: string }>;
  mechanics?: Array<{
    personId: string;
    assignedWorkorderId?: string;
    onBreak?: boolean;
    ptoEntries?: Array<{ start: Date; end: Date }>;
  }>;
}

/** The fields of `PeopleAvailabilityResponse` this mapping reads. */
export interface StaffingView {
  personId: string;
  role?: string;
  assignmentStatus: string;
}

export type RosterOutcome =
  | { kind: 'roster'; roster: SiteRoster }
  | { kind: 'skipped'; reason: string };

/** A PTO entry covering the board's date, inclusive of both ends. */
export const isOnPto = (
  mechanic: { ptoEntries?: Array<{ start: Date; end: Date }> },
  on: Date,
): boolean =>
  (mechanic.ptoEntries ?? []).some((pto) => pto.start.getTime() <= on.getTime() && on.getTime() <= pto.end.getTime());

/**
 * Technicians the board says are not available for new work.
 *
 * Three signals, each explicit in the model: already on a workorder, on break,
 * or on PTO covering the board's date. `currentStatus` is deliberately not
 * interpreted — the contract does not name its vocabulary, so treating an
 * unrecognised value as busy would silently drop technicians, and treating it
 * as idle would add nothing the three signals above do not already say.
 */
export const busyTechnicianIds = (board: BoardView, on: Date): Set<string> =>
  new Set(
    (board.mechanics ?? [])
      .filter(
        (mechanic) =>
          mechanic.assignedWorkorderId != null || mechanic.onBreak === true || isOnPto(mechanic, on),
      )
      .map((mechanic) => mechanic.personId),
  );

/**
 * Builds the roster, or says why the site is not loadable.
 *
 * A site with positions but no idle technician is **kept**, not skipped: its
 * positions are exactly the ones the coverage report has to name. Only a site
 * with no position at all, or a board that cannot be trusted, is dropped.
 */
export const buildRoster = (
  site: { locationId: string; code: string; name: string },
  board: BoardView,
  staffing: readonly StaffingView[],
  on: Date,
): RosterOutcome => {
  // The board sets this when an upstream source was unavailable during
  // aggregation, so a bay may read free while an open workorder holds it, or a
  // mechanic may be missing entirely. Placing work on a board that may be
  // incomplete risks a duplicate placement or a double-booked technician, and
  // the run has no way to tell which rows are the incomplete ones.
  if (board.dataQualityWarning === true) {
    return {
      kind: 'skipped',
      reason: 'the dispatch board reported dataQualityWarning — it may be incomplete, so placing work here could double-book',
    };
  }

  const entries: Array<{ position: ShopPosition; occupied: boolean }> = [
    ...(board.bays ?? []).map((bay) => ({
      position: { kind: 'BAY' as const, id: bay.bayId, name: bay.bayName ?? bay.bayId },
      occupied: bay.assignedWorkorderId != null || !bay.available,
    })),
    ...(board.mobileUnits ?? []).map((unit) => ({
      position: { kind: 'MOBILE_UNIT' as const, id: unit.unitId, name: unit.unitName ?? unit.unitId },
      occupied: unit.assignedWorkorderId != null || !unit.available,
    })),
  ];

  if (entries.length === 0) {
    return { kind: 'skipped', reason: 'no bay or mobile unit' };
  }

  const technicianIds = staffing
    .filter((person) => person.assignmentStatus === 'ACTIVE' && person.role === 'TECHNICIAN')
    .map((person) => person.personId);
  const busy = busyTechnicianIds(board, on);

  return {
    kind: 'roster',
    roster: {
      locationId: site.locationId,
      code: site.code,
      name: site.name,
      freePositions: entries.filter((entry) => !entry.occupied).map((entry) => entry.position),
      occupiedPositions: entries.filter((entry) => entry.occupied).map((entry) => entry.position),
      idleTechnicianIds: technicianIds.filter((id) => !busy.has(id)),
      busyTechnicianIds: technicianIds.filter((id) => busy.has(id)),
    },
  };
};
