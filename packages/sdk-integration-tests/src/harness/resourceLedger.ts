/**
 * Who holds which mechanic and which bay, and for how long.
 *
 * Pure: no SDK, no clients, no clock. Every instant is passed in, so the rule
 * that matters — a mechanic, a bay or a mobile unit holds at most one open
 * workorder — is decided from data alone and unit-tested.
 *
 * The backend *should* refuse a double-booking (one open workorder per bay,
 * backend #1984), and the accelerated run is not testing that refusal: it
 * declines to ask. Asking and taking a 409 is what the seeder does, and at a
 * year's scale it produces thousands of log lines nobody reads and leaves
 * technicians attached to workorders that never got a position. So a resource is
 * claimed here first, and a call the ledger would refuse is never made.
 *
 * The ledger also keeps a closed history of every hold, which is what makes the
 * end-of-run resource-compliance assertion possible: not "the run intended not
 * to double-book" but "no resource was ever held twice at the same virtual
 * instant".
 */
import { interleaveByKind, type PositionKind, type ShopPosition, type SiteRoster } from '../runs/shopFloorPlan';

export interface Claim {
  /** Unique within a ledger, for release and for audit trails. */
  id: string;
  locationId: string;
  position: ShopPosition;
  technicianId: string;
  /** Virtual instant the claim was taken. */
  heldFrom: Date;
  /** Set once the claim is attached to a workorder. */
  workorderId?: string;
}

/** A hold that has ended — the audit record. */
export interface ClosedHold {
  locationId: string;
  positionId: string;
  /**
   * Which kind of position the hold was on.
   *
   * Carried through because a finished hold is the only place the run can still
   * learn how a workorder was worked, and the labor-span audit needs it: a bay's
   * hours must sit inside the shop's window and a mobile unit's need not.
   */
  kind: PositionKind;
  technicianId: string;
  workorderId: string | undefined;
  from: Date;
  to: Date;
}

/** Two holds on one resource overlapping in virtual time. */
export interface OverlapViolation {
  resourceKind: 'POSITION' | 'TECHNICIAN';
  resourceId: string;
  first: { workorderId: string | undefined; from: Date; to: Date | undefined };
  second: { workorderId: string | undefined; from: Date; to: Date | undefined };
}

interface SiteState {
  locationId: string;
  code: string;
  positions: Map<string, ShopPosition>;
  /**
   * Every position at the site, in the order work should be placed on them —
   * computed once per reconciliation rather than per claim.
   *
   * Per claim would be wrong: re-interleaving whatever is left puts a bay first
   * every time while bays outnumber units, so a site with 3 bays and 1 unit hands
   * out bay, bay, bay and the unit never works. Ordering the whole set once and
   * then skipping what is held preserves the round robin across successive claims.
   */
  order: ShopPosition[];
  heldPositions: Set<string>;
  technicians: Set<string>;
  heldTechnicians: Set<string>;
}

export class ResourceLedger {
  private readonly sites = new Map<string, SiteState>();
  private readonly open = new Map<string, Claim>();
  private readonly carried = new Map<string, Claim>();
  private readonly closed: ClosedHold[] = [];
  private sequence = 0;

  /**
   * Seeds a site's occupancy from what the dispatch board and the staffing roll
   * currently say.
   *
   * Called at the start of every open virtual day. Anything the board reports as
   * occupied — a record left open by a previous day, a previous run, or the
   * seeder — starts the day held, so the run never places work on a bay that
   * merely looks free to it.
   *
   * Claims this ledger is already carrying survive reconciliation: a work-in-
   * progress job's bay reads occupied on the board *because* this run holds it,
   * and dropping the claim here would hand the same bay out twice.
   */
  reconcile(roster: SiteRoster): void {
    const existing = this.sites.get(roster.locationId);
    const state: SiteState = {
      locationId: roster.locationId,
      code: roster.code,
      positions: new Map(),
      order: [],
      heldPositions: new Set(),
      technicians: new Set(),
      heldTechnicians: new Set(),
    };

    for (const position of [...roster.freePositions, ...roster.occupiedPositions]) {
      state.positions.set(position.id, position);
    }
    for (const position of roster.occupiedPositions) {
      state.heldPositions.add(position.id);
    }
    for (const technicianId of [...roster.idleTechnicianIds, ...roster.busyTechnicianIds]) {
      state.technicians.add(technicianId);
    }
    for (const technicianId of roster.busyTechnicianIds) {
      state.heldTechnicians.add(technicianId);
    }

    // Re-assert our own holds. A carried job's position is occupied on the board
    // by our own workorder, and a board read taken mid-flight may not show a
    // claim taken seconds ago at all.
    for (const claim of [...this.open.values(), ...this.carried.values()]) {
      if (claim.locationId !== roster.locationId) {
        continue;
      }
      state.positions.set(claim.position.id, claim.position);
      state.heldPositions.add(claim.position.id);
      state.technicians.add(claim.technicianId);
      state.heldTechnicians.add(claim.technicianId);
    }

    // Positions the board has stopped listing (deactivated between days) are
    // dropped, but never one we are still holding — hence the merge above.
    if (existing) {
      for (const claim of [...this.open.values(), ...this.carried.values()]) {
        if (claim.locationId === roster.locationId && !state.positions.has(claim.position.id)) {
          state.positions.set(claim.position.id, claim.position);
        }
      }
    }

    state.order = interleaveByKind([...state.positions.values()]);
    this.sites.set(roster.locationId, state);
  }

  knownSites(): string[] {
    return [...this.sites.keys()];
  }

  /** Free positions of a kind, in the order work should be placed on them. */
  freePositions(locationId: string, kind?: PositionKind): ShopPosition[] {
    const state = this.sites.get(locationId);
    if (!state) {
      return [];
    }
    // `order` already round-robins bays and mobile units, so a technician
    // shortfall is shared between the kinds instead of leaving every mobile unit
    // idle — the same reason shopFloorPlan interleaves.
    const free = state.order.filter((position) => !state.heldPositions.has(position.id));
    return kind ? free.filter((position) => position.kind === kind) : free;
  }

  freeTechnicians(locationId: string): string[] {
    const state = this.sites.get(locationId);
    if (!state) {
      return [];
    }
    return [...state.technicians].filter((id) => !state.heldTechnicians.has(id));
  }

  /**
   * Takes the next free `{ position, technician }` pair, or null when the site
   * has none — the caller then waits for a slot rather than asking the backend
   * for one it cannot have.
   */
  claim(locationId: string, at: Date, kind?: PositionKind): Claim | null {
    const position = this.freePositions(locationId, kind)[0];
    const technicianId = this.freeTechnicians(locationId)[0];
    if (!position || technicianId === undefined) {
      return null;
    }
    return this.claimSpecific(locationId, position, technicianId, at);
  }

  /**
   * Claims a named pair. Throws when either side is already held: this is the
   * programming-error path, and a silent second hold is the exact defect the
   * ledger exists to prevent.
   */
  claimSpecific(locationId: string, position: ShopPosition, technicianId: string, at: Date): Claim {
    const state = this.sites.get(locationId);
    if (!state) {
      throw new Error(`[accel] site ${locationId} has not been reconciled — no claim can be made against it`);
    }
    if (state.heldPositions.has(position.id)) {
      throw new Error(
        `[accel] ${position.kind} ${position.name} (${position.id}) at ${state.code} is already held — ` +
          'refusing to double-book it',
      );
    }
    if (state.heldTechnicians.has(technicianId)) {
      throw new Error(
        `[accel] technician ${technicianId} at ${state.code} is already held — refusing to double-book them`,
      );
    }

    state.positions.set(position.id, position);
    state.technicians.add(technicianId);
    state.heldPositions.add(position.id);
    state.heldTechnicians.add(technicianId);

    this.sequence += 1;
    const claim: Claim = {
      id: `claim-${this.sequence}`,
      locationId,
      position,
      technicianId,
      heldFrom: new Date(at),
    };
    this.open.set(claim.id, claim);
    return claim;
  }

  /** Records the workorder a claim is working, once there is one. */
  attach(claim: Claim, workorderId: string): void {
    const held = this.open.get(claim.id) ?? this.carried.get(claim.id);
    if (!held) {
      throw new Error(`[accel] claim ${claim.id} is not held, so no workorder can be attached to it`);
    }
    held.workorderId = workorderId;
    claim.workorderId = workorderId;
  }

  /**
   * Gives a resource back. Idempotent by design and returns whether anything was
   * freed: the failure paths release defensively, and a release that has already
   * happened is not an error worth unwinding a day's work for.
   */
  release(claim: Claim, at: Date): boolean {
    const held = this.open.get(claim.id) ?? this.carried.get(claim.id);
    if (!held) {
      return false;
    }
    const state = this.sites.get(held.locationId);
    if (state) {
      state.heldPositions.delete(held.position.id);
      state.heldTechnicians.delete(held.technicianId);
    }
    this.open.delete(claim.id);
    this.carried.delete(claim.id);
    this.closed.push({
      locationId: held.locationId,
      positionId: held.position.id,
      kind: held.position.kind,
      technicianId: held.technicianId,
      workorderId: held.workorderId,
      from: held.heldFrom,
      to: new Date(at),
    });
    return true;
  }

  /**
   * Keeps a hold across a day boundary: the job is still open at close, so the
   * car stays on the bay and the mechanic stays on the job. This is the honest
   * outcome for work that does not fit one window, and it is the mechanism that
   * lets a fast clock still finish jobs — a job spans as many open windows as it
   * needs, doing no labor outside them.
   */
  carry(claim: Claim): void {
    if (this.carried.has(claim.id)) {
      // Already carried — a day that inherited this job and could not finish it
      // either. Not an error: the hold is exactly where it needs to be.
      return;
    }
    const held = this.open.get(claim.id);
    if (!held) {
      throw new Error(`[accel] claim ${claim.id} is not open, so it cannot be carried to the next day`);
    }
    this.open.delete(claim.id);
    this.carried.set(claim.id, held);
  }

  /**
   * Takes a carried hold back into the working set, for the day that picks the job
   * up again. The counterpart of {@link carry}: without it a job inherited on
   * Tuesday and still unfinished on Tuesday evening could not be carried to
   * Wednesday, because its claim would already be in the carried set.
   */
  resume(claim: Claim): void {
    const held = this.carried.get(claim.id);
    if (!held) {
      return;
    }
    this.carried.delete(claim.id);
    this.open.set(claim.id, held);
  }

  openClaims(): Claim[] {
    return [...this.open.values()];
  }

  carriedClaims(): Claim[] {
    return [...this.carried.values()];
  }

  /** Every hold this run still has, open or carried. */
  activeClaims(): Claim[] {
    return [...this.open.values(), ...this.carried.values()];
  }

  closedHolds(): readonly ClosedHold[] {
    return this.closed;
  }

  /**
   * Every pair of holds on one resource that overlapped in virtual time.
   *
   * The end-of-run resource-compliance assertion: empty is the only acceptable
   * answer. Still-active holds are compared with an open end, so a double-book
   * that has not been released yet is caught too.
   */
  overlaps(): OverlapViolation[] {
    const intervals: Array<{
      resourceKind: 'POSITION' | 'TECHNICIAN';
      resourceId: string;
      workorderId: string | undefined;
      from: Date;
      to: Date | undefined;
    }> = [];

    for (const hold of this.closed) {
      intervals.push({ resourceKind: 'POSITION', resourceId: hold.positionId, workorderId: hold.workorderId, from: hold.from, to: hold.to });
      intervals.push({ resourceKind: 'TECHNICIAN', resourceId: hold.technicianId, workorderId: hold.workorderId, from: hold.from, to: hold.to });
    }
    for (const claim of this.activeClaims()) {
      intervals.push({ resourceKind: 'POSITION', resourceId: claim.position.id, workorderId: claim.workorderId, from: claim.heldFrom, to: undefined });
      intervals.push({ resourceKind: 'TECHNICIAN', resourceId: claim.technicianId, workorderId: claim.workorderId, from: claim.heldFrom, to: undefined });
    }

    const violations: OverlapViolation[] = [];
    const byResource = new Map<string, typeof intervals>();
    for (const interval of intervals) {
      const key = `${interval.resourceKind}:${interval.resourceId}`;
      const bucket = byResource.get(key);
      if (bucket) {
        bucket.push(interval);
      } else {
        byResource.set(key, [interval]);
      }
    }

    for (const bucket of byResource.values()) {
      const sorted = [...bucket].sort((a, b) => a.from.getTime() - b.from.getTime());

      // Compared against the hold that reaches furthest, not merely the previous
      // one. Sorting by start does not order by end, so a long hold can enclose
      // later short ones: [0,100], [1,2], [50,60] against its predecessor alone
      // reports [1,2] and then misses [50,60], which also sits inside [0,100].
      // Under-reporting is the dangerous direction for a compliance check, so the
      // running maximum is what each start is tested against.
      let furthest = sorted[0];
      for (let index = 1; index < sorted.length; index += 1) {
        const current = sorted[index];
        const furthestEnd = furthest.to?.getTime() ?? Number.POSITIVE_INFINITY;
        // Touching ends do not overlap: one job closing at the instant the next
        // opens is a bay turned around, not a double-booking.
        if (current.from.getTime() < furthestEnd) {
          violations.push({
            resourceKind: furthest.resourceKind,
            resourceId: furthest.resourceId,
            first: { workorderId: furthest.workorderId, from: furthest.from, to: furthest.to },
            second: { workorderId: current.workorderId, from: current.from, to: current.to },
          });
        }
        if ((current.to?.getTime() ?? Number.POSITIVE_INFINITY) > furthestEnd) {
          furthest = current;
        }
      }
    }
    return violations;
  }

  /** Per-site capacity, for the coverage line a day logs before it works. */
  capacity(locationId: string): { free: number; held: number; technicians: number; freeTechnicians: number } {
    const state = this.sites.get(locationId);
    if (!state) {
      return { free: 0, held: 0, technicians: 0, freeTechnicians: 0 };
    }
    return {
      free: state.positions.size - state.heldPositions.size,
      held: state.heldPositions.size,
      technicians: state.technicians.size,
      freeTechnicians: state.technicians.size - state.heldTechnicians.size,
    };
  }
}
