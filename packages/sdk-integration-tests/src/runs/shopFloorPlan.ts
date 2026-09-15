/**
 * Pairing a shop floor's free service positions with its idle technicians.
 *
 * Pure: no SDK, no clients, no clock. The run (`shopFloorLoad.ts`) discovers
 * the rosters and executes the plan; everything decided here is decided from
 * data alone, so the rule that matters — what happens when a site has more
 * positions than technicians — is unit-tested rather than only observable
 * against a live backend.
 */

export type PositionKind = 'BAY' | 'MOBILE_UNIT';

/** A place work is done: one bay, or one mobile unit based at the site. */
export interface ShopPosition {
  kind: PositionKind;
  id: string;
  /** As the dispatch board names it; falls back to the id when the replica has no name yet. */
  name: string;
}

/**
 * One site as discovery found it.
 *
 * Free/occupied and idle/busy are split at discovery rather than here because
 * only the backend can say whether a position or a technician is already
 * holding open work. The planner places work on free positions with idle
 * technicians; the occupied and busy lists are carried through for the report.
 */
export interface SiteRoster {
  locationId: string;
  code: string;
  name: string;
  freePositions: ShopPosition[];
  occupiedPositions: ShopPosition[];
  idleTechnicianIds: string[];
  busyTechnicianIds: string[];
}

export interface PlannedJob {
  position: ShopPosition;
  technicianId: string;
}

export interface SitePlan {
  site: SiteRoster;
  jobs: PlannedJob[];
  /** Free positions left empty because the site ran out of idle technicians. */
  unstaffed: ShopPosition[];
  /** Idle technicians left over because the site ran out of free positions. */
  spareTechnicians: number;
}

export interface FloorPlan {
  sites: SitePlan[];
  totals: {
    sites: number;
    freePositions: number;
    idleTechnicians: number;
    planned: number;
    unstaffed: number;
  };
}

/**
 * Orders a site's positions so that a technician shortfall is shared between
 * bays and mobile units instead of falling entirely on one kind.
 *
 * Filling bays first would leave every mobile unit idle at exactly the sites
 * that are short — the alpha packs put 8 bays and 2 mobile units against 8
 * technicians at CLT-MAIN-001 — which defeats the point of loading the board.
 * Round-robin from bays: Bay 01, MU-01, Bay 02, MU-02, Bay 03, ... so both
 * kinds are working before any position goes without, and the tail that goes
 * unstaffed is whichever kind the site has more of.
 */
export const interleaveByKind = (positions: readonly ShopPosition[]): ShopPosition[] => {
  const bays = positions.filter((position) => position.kind === 'BAY');
  const units = positions.filter((position) => position.kind === 'MOBILE_UNIT');

  const ordered: ShopPosition[] = [];
  for (let index = 0; index < Math.max(bays.length, units.length); index += 1) {
    if (index < bays.length) ordered.push(bays[index]);
    if (index < units.length) ordered.push(units[index]);
  }
  return ordered;
};

/**
 * One technician per position, no double-booking: a technician already holding
 * an open workorder is not in `idleTechnicianIds`, and none is paired twice.
 * When the site has fewer idle technicians than free positions the surplus
 * positions are reported as unstaffed rather than shared.
 */
export const planSite = (site: SiteRoster): SitePlan => {
  const ordered = interleaveByKind(site.freePositions);
  const staffable = Math.min(ordered.length, site.idleTechnicianIds.length);

  return {
    site,
    jobs: ordered.slice(0, staffable).map((position, index) => ({
      position,
      technicianId: site.idleTechnicianIds[index],
    })),
    unstaffed: ordered.slice(staffable),
    spareTechnicians: site.idleTechnicianIds.length - staffable,
  };
};

/**
 * Plans every site independently: a spare technician at one site cannot cover
 * a gap at another, so the floor's shortfall is the sum of the per-site gaps,
 * never the difference between the two totals.
 */
export const planFloor = (sites: readonly SiteRoster[]): FloorPlan => {
  const plans = sites.map(planSite);

  return {
    sites: plans,
    totals: {
      sites: plans.length,
      freePositions: plans.reduce((sum, plan) => sum + plan.site.freePositions.length, 0),
      idleTechnicians: plans.reduce((sum, plan) => sum + plan.site.idleTechnicianIds.length, 0),
      planned: plans.reduce((sum, plan) => sum + plan.jobs.length, 0),
      unstaffed: plans.reduce((sum, plan) => sum + plan.unstaffed.length, 0),
    },
  };
};

/**
 * The coverage answer, as lines to log before anything is written: which sites
 * are short of technicians, by how much, and which positions that leaves empty.
 * Built here rather than inline in the run so the shortfall wording is covered
 * by the same tests as the arithmetic behind it.
 */
export const formatCoverageReport = (plan: FloorPlan): string[] => {
  const lines: string[] = [];

  for (const site of plan.sites) {
    const positions = site.site.freePositions.length;
    const technicians = site.site.idleTechnicianIds.length;
    const occupied = site.site.occupiedPositions.length;
    const busy = site.site.busyTechnicianIds.length;

    lines.push(
      `${site.site.code}: ${positions} free position(s), ${technicians} idle technician(s)` +
        `${occupied > 0 ? `, ${occupied} position(s) already working` : ''}` +
        `${busy > 0 ? `, ${busy} technician(s) already on a job` : ''}`,
    );

    if (site.unstaffed.length > 0) {
      lines.push(`  SHORT by ${site.unstaffed.length} technician(s) — these stay empty:`);
      for (const position of site.unstaffed) {
        lines.push(`    ${position.kind} ${position.name}`);
      }
    } else if (site.spareTechnicians > 0) {
      lines.push(`  covered, with ${site.spareTechnicians} technician(s) to spare`);
    } else {
      lines.push('  covered exactly, with no technician to spare');
    }
  }

  const { planned, freePositions, unstaffed, idleTechnicians, sites } = plan.totals;
  lines.push(
    `TOTAL: ${planned}/${freePositions} free position(s) staffable across ${sites} site(s) ` +
      `from ${idleTechnicians} idle technician(s)`,
  );
  if (unstaffed > 0) {
    lines.push(
      `TOTAL: NOT ENOUGH TECHNICIANS — ${unstaffed} position(s) will be left empty. ` +
        'A spare technician at one site cannot cover a gap at another, so this is the sum of the per-site gaps.',
    );
  }

  return lines;
};
