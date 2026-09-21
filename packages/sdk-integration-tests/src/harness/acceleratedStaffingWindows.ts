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

const DAY_MS = 86_400_000;

/** `{person, location, role}` — the triple the backend's overlap guard keys on. */
const keyOf = (assignment: StaffingWindow): string =>
  `${assignment.personId}|${assignment.locationId}|${assignment.role}`;

/** What the planner decided, including the rows it refused to touch and why. */
export interface StaffingPlan {
  plans: StaffingBackdate[];
  /** One line per assignment that needs moving but cannot be moved safely. */
  blocked: string[];
}

/**
 * The assignments that have to move for this person to be present through the
 * virtual year. Pure: no clock, no I/O.
 *
 * Four are left alone, each for its own reason:
 *
 *   - anything not ACTIVE, because the presence check only counts ACTIVE rows
 *     and reviving a suspended assignment would be inventing staff;
 *   - one already effective at the floor, which is what makes a re-run a no-op;
 *   - one that *ended* before the floor, because moving its start would leave a
 *     window that closed before the run began — still no coverage, and a lie
 *     about when that person worked;
 *   - one whose person is already covered at the floor by another ACTIVE
 *     assignment of the same role at the same location: presence is satisfied,
 *     and moving this one could only collide with that one.
 *
 * **The start is clamped, not simply floored.** `StaffingAssignmentServiceImpl`
 * refuses an update whose window overlaps another assignment of the same
 * `{person, location, role}` with `409 CONFLICT`, and `AssignmentOverlapSearch`
 * keys that check on `status = ACTIVE` — an ENDED row is listed by
 * `listStaffingAssignments` but cannot collide. So a row is moved back to the
 * floor or to the day after the latest ACTIVE sibling that closes before it,
 * whichever is later. A sibling that is open-ended, or that runs past this row's
 * own start, sits across the whole window: nothing can be written without
 * overlapping it, so the row is reported rather than attempted.
 */
export function planStaffingBackdates(
  assignments: readonly StaffingWindow[],
  virtualStart: Date,
): StaffingPlan {
  const floor = floorFor(virtualStart);
  const plans: StaffingBackdate[] = [];
  const blocked: string[] = [];

  const actives = assignments.filter((assignment) => assignment.status === 'ACTIVE');

  for (const assignment of actives) {
    if (assignment.effectiveFrom.getTime() <= floor.getTime()) {
      continue;
    }
    if (assignment.effectiveTo !== null && assignment.effectiveTo.getTime() <= floor.getTime()) {
      continue;
    }

    const siblings = actives.filter(
      (other) => other !== assignment && keyOf(other) === keyOf(assignment),
    );

    // A sibling already covers the whole stretch this row would be moved into —
    // from the floor through to the day this row takes over. The person is
    // present for all of it, so there is nothing to gain and an overlap to lose.
    //
    // Covering the floor alone is not enough: a sibling that lapses halfway
    // through the virtual year leaves the rest of it unstaffed, and this row is
    // what closes that gap.
    const covered = siblings.some(
      (other) =>
        other.effectiveFrom.getTime() <= floor.getTime() &&
        (other.effectiveTo === null ||
          other.effectiveTo.getTime() >= assignment.effectiveFrom.getTime() - DAY_MS),
    );
    if (covered) {
      continue;
    }

    // A sibling with no end, or one still running when this row starts, occupies
    // every day this row could be moved into.
    //
    // Two ACTIVE rows of one `{person, location, role}` that overlap are a state
    // the backend's own guard should have refused, so this is a report about the
    // data rather than a case the run can resolve — and both rows say so, since
    // neither can move while the other stands.
    const across = siblings.filter(
      (other) =>
        other.effectiveTo === null ||
        other.effectiveTo.getTime() >= assignment.effectiveFrom.getTime(),
    );
    if (across.length > 0) {
      blocked.push(
        `${assignment.personId} ${assignment.role} at ${assignment.locationId}: ` +
          `assignment ${assignment.assignmentId} starts ${iso(assignment.effectiveFrom)} and cannot be ` +
          `moved without overlapping ${across.map((other) => other.assignmentId).join(', ')}`,
      );
      continue;
    }

    // The day after the latest sibling that closes before this row begins.
    const earliest = siblings.reduce(
      (floorSoFar, other) =>
        Math.max(floorSoFar, (other.effectiveTo as Date).getTime() + DAY_MS),
      floor.getTime(),
    );
    if (earliest >= assignment.effectiveFrom.getTime()) {
      // Nowhere to move it to that it does not already start at.
      continue;
    }

    plans.push({
      assignmentId: assignment.assignmentId,
      personId: assignment.personId,
      locationId: assignment.locationId,
      role: assignment.role,
      isPrimary: assignment.isPrimary,
      effectiveTo: assignment.effectiveTo,
      effectiveFrom: new Date(earliest),
      was: assignment.effectiveFrom,
    });
  }
  return { plans, blocked };
}

export class AcceleratedStaffingWindows {
  constructor(private readonly port: StaffingWindowPort) {}

  /**
   * Returns one line per assignment moved, and one per row it could not move.
   *
   * A person whose assignments cannot be listed, a row the planner refuses to
   * touch, and a write the backend rejects are all reported rather than thrown.
   * The run can proceed with fewer mechanics present, and the refusal it then
   * gets names the date — which is more use than a setup that died on one row.
   *
   * With one exception. If every assignment that needed moving failed to move,
   * nothing about presence improved, and the run is walking into the refusal
   * this step exists to prevent. That is thrown, carrying every reason, because
   * a setup failure naming them beats a virtual day 1 that fails on an
   * appointment and says nothing about why.
   */
  async run(
    personIds: readonly string[],
    virtualStart: Date,
  ): Promise<{ backdated: string[]; unreadable: string[]; blocked: string[]; failed: string[] }> {
    const backdated: string[] = [];
    const unreadable: string[] = [];
    const blocked: string[] = [];
    const failed: string[] = [];

    for (const personId of new Set(personIds)) {
      let assignments: StaffingWindow[];
      try {
        assignments = await this.port.list(personId);
      } catch (error) {
        unreadable.push(`${personId}: ${describe(error)}`);
        continue;
      }

      const planned = planStaffingBackdates(assignments, virtualStart);
      blocked.push(...planned.blocked);

      for (const plan of planned.plans) {
        try {
          await this.port.backdate(plan);
        } catch (error) {
          // A 409 here is the overlap guard on a shape the planner did not
          // foresee; a 403 or a 5xx is the environment. Either way it is one
          // row, and the next one may still move.
          failed.push(`${plan.personId} ${plan.role} assignment ${plan.assignmentId}: ${describe(error)}`);
          continue;
        }
        backdated.push(
          `${plan.personId} ${plan.role} at ${plan.locationId} from ` +
            `${iso(plan.was)} to ${iso(plan.effectiveFrom)}`,
        );
      }
    }

    if (backdated.length === 0 && failed.length > 0) {
      throw new Error(
        `[accel] not one of ${failed.length} staffing assignment(s) could be back-dated, so no mechanic ` +
          'is present anywhere in the virtual year and every booking will be refused ' +
          `MECHANIC_UNAVAILABLE: ${failed.join('; ')}`,
      );
    }

    return { backdated, unreadable, blocked, failed };
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
