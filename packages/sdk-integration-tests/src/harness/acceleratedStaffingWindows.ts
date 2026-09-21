/**
 * Back-dates the seeded employees' staffing assignments so they cover the
 * accelerated run's virtual year.
 *
 * The sibling of acceleratedRoleWindows, for the other half of the same
 * problem. That one fixes *login*: pos-security-service counts a role only
 * while `effectiveStartDate <= asOf`. This one fixes *presence*:
 * pos-shop-manager decides whether a mechanic is at a location by reading
 * `ExtStaffingAssignmentReplica` and asking whether an ACTIVE assignment
 * covers the booked date (`SkillRequirementResolver.covers`). An assignment
 * written in wall time begins months after the virtual instant being judged,
 * so a fully staffed shop answers:
 *
 *     MECHANIC_UNAVAILABLE — "No mechanic is present at this location for …"
 *
 * and every appointment the run books is refused. That is correct behaviour on
 * the backend's side — an assignment that starts later genuinely does not cover
 * an earlier date, and the platform declined to special-case it
 * (durion-positivity-backend#2140). The data is the run's to get right.
 *
 * Unlike a role assignment, a staffing assignment is editable, so this moves
 * `effectiveFrom` on the existing row rather than bridging a second one.
 * `effectiveTo` is left exactly as it was: an assignment open at the wall-clock
 * today is open for the whole virtual year, and one that was deliberately
 * closed stays closed.
 *
 * Idempotent: an assignment already effective at the floor is skipped, so a
 * re-run writes nothing.
 */
/**
 * Slack below `virtualStart`, in days. `effectiveFrom` is a LocalDate, and the
 * backend compares it against the *facility-local* date of the booking, which
 * can be the day before the UTC one. A day of margin costs nothing and removes
 * the question.
 */
const FLOOR_MARGIN_DAYS = 1;

/** One staffing assignment as the backend stores it. */
export interface StaffingWindow {
  assignmentId: string;
  personId: string;
  locationId: string;
  role: string;
  isPrimary: boolean;
  status: string;
  /** LocalDate at UTC midnight — the wire format is `YYYY-MM-DD`. */
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** An assignment to re-date, carrying everything the update needs to round-trip. */
export interface StaffingBackdate {
  assignmentId: string;
  personId: string;
  locationId: string;
  role: string;
  isPrimary: boolean;
  effectiveTo: Date | null;
  /** Where it will now start. */
  effectiveFrom: Date;
  /** Where it started before, for the run log. */
  was: Date;
}

export interface StaffingWindowPort {
  list(personId: string): Promise<StaffingWindow[]>;
  backdate(plan: StaffingBackdate): Promise<void>;
}

/** The UTC date `days` before `at`, at midnight — the shape a LocalDate round-trips as. */
export function floorFor(virtualStart: Date, days = FLOOR_MARGIN_DAYS): Date {
  const floor = new Date(virtualStart.getTime() - days * 86_400_000);
  return new Date(Date.UTC(floor.getUTCFullYear(), floor.getUTCMonth(), floor.getUTCDate()));
}

/**
 * The assignments that have to move for this person to be present through the
 * virtual year. Pure: no clock, no I/O.
 *
 * Three are left alone, each for its own reason:
 *
 *   - anything not ACTIVE, because the presence check only counts ACTIVE rows
 *     and reviving a suspended assignment would be inventing staff;
 *   - one already effective at the floor, which is what makes a re-run a no-op;
 *   - one that *ended* before the floor, because moving its start would leave a
 *     window that closed before the run began — still no coverage, and a lie
 *     about when that person worked.
 */
export function planStaffingBackdates(
  assignments: readonly StaffingWindow[],
  virtualStart: Date,
): StaffingBackdate[] {
  const floor = floorFor(virtualStart);
  const plans: StaffingBackdate[] = [];

  for (const assignment of assignments) {
    if (assignment.status !== 'ACTIVE') {
      continue;
    }
    if (assignment.effectiveFrom.getTime() <= floor.getTime()) {
      continue;
    }
    if (assignment.effectiveTo !== null && assignment.effectiveTo.getTime() <= floor.getTime()) {
      continue;
    }
    plans.push({
      assignmentId: assignment.assignmentId,
      personId: assignment.personId,
      locationId: assignment.locationId,
      role: assignment.role,
      isPrimary: assignment.isPrimary,
      effectiveTo: assignment.effectiveTo,
      effectiveFrom: floor,
      was: assignment.effectiveFrom,
    });
  }
  return plans;
}

export class AcceleratedStaffingWindows {
  constructor(private readonly port: StaffingWindowPort) {}

  /**
   * Returns one line per assignment moved, for the run log, and the people it
   * could not read.
   *
   * A person whose assignments cannot be listed is reported rather than thrown:
   * the run can still work, with fewer mechanics present, and the refusal it
   * then gets names the date — which is more use than a setup that died here.
   */
  async run(
    personIds: readonly string[],
    virtualStart: Date,
  ): Promise<{ backdated: string[]; unreadable: string[] }> {
    const backdated: string[] = [];
    const unreadable: string[] = [];

    for (const personId of new Set(personIds)) {
      let assignments: StaffingWindow[];
      try {
        assignments = await this.port.list(personId);
      } catch (error) {
        unreadable.push(`${personId}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const plan of planStaffingBackdates(assignments, virtualStart)) {
        await this.port.backdate(plan);
        backdated.push(
          `${plan.personId} ${plan.role} at ${plan.locationId} from ` +
            `${iso(plan.was)} to ${iso(plan.effectiveFrom)}`,
        );
      }
    }
    return { backdated, unreadable };
  }
}

/** `YYYY-MM-DD`, the wire format for a LocalDate. */
export function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Talks to pos-people through the admin's own login, because this runs after
 * `admin login` and the reference bootstrap: the assignments it re-dates are the
 * ones that bootstrap just made or found.
 */
export function createStaffingWindowPort(client: {
  peopleStaffingAssignmentsApi: {
    listStaffingAssignments(request: { personId: string }): Promise<
      Array<{
        assignmentId: string;
        personId: string;
        locationId: string;
        role: string;
        isPrimary: boolean;
        status: string;
        effectiveFrom: Date;
        effectiveTo?: Date;
      }>
    >;
    updateStaffingAssignment(request: {
      assignmentId: string;
      updateStaffingAssignmentRequest: {
        personId: string;
        locationId: string;
        role: string;
        isPrimary: boolean;
        effectiveFrom: Date;
        effectiveTo?: Date;
      };
    }): Promise<unknown>;
  };
}): StaffingWindowPort {
  return {
    async list(personId) {
      const assignments = await client.peopleStaffingAssignmentsApi.listStaffingAssignments({ personId });
      return assignments.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        personId: assignment.personId,
        locationId: assignment.locationId,
        role: assignment.role,
        isPrimary: assignment.isPrimary,
        status: assignment.status,
        effectiveFrom: assignment.effectiveFrom,
        effectiveTo: assignment.effectiveTo ?? null,
      }));
    },

    async backdate(plan) {
      // A full replacement, not a patch: every required field is sent back as it
      // was read, so nothing but the start date moves.
      await client.peopleStaffingAssignmentsApi.updateStaffingAssignment({
        assignmentId: plan.assignmentId,
        updateStaffingAssignmentRequest: {
          personId: plan.personId,
          locationId: plan.locationId,
          role: plan.role,
          isPrimary: plan.isPrimary,
          effectiveFrom: plan.effectiveFrom,
          ...(plan.effectiveTo === null ? {} : { effectiveTo: plan.effectiveTo }),
        },
      });
    },
  };
}
