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
 * Unlike a role assignment, a staffing assignment is editable, so this widens
 * the existing row rather than bridging a second one — `effectiveFrom` back to
 * the run's floor, and `effectiveTo` forward past its end when the window would
 * otherwise lapse mid-run.
 *
 * Both ends matter, and the first version of this only did one. A row that began
 * before the floor was skipped as "already effective", which is true of the first
 * virtual day and false of every day after its end: the backend answered
 * `3 ACTIVE technician staffing assignments exist at this location, none
 * effective on 2025-11-10` while this pass reported nothing to do. Coverage is of
 * the whole run or it is not coverage.
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
  /** Where it ended before, for the run log. */
  wasTo: Date | null;
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
 * The dates the staffing pass asks availability about: the run's first and last
 * virtual days, three points between, and the wall-clock today.
 *
 * Sampled rather than exhaustive — a year of dates is a year of calls per site —
 * and chosen so an assignment covering any sizeable stretch of the run, or live in
 * wall time, is seen at least once. One lying wholly between two samples is still
 * missed, and the setup log says how many people were examined, which is where
 * that would show.
 */
export function samplesAcross(virtualStart: Date, virtualEnd: Date, now = new Date()): Date[] {
  const span = virtualEnd.getTime() - virtualStart.getTime();
  const points = [0, 0.25, 0.5, 0.75, 1].map((fraction) => new Date(virtualStart.getTime() + span * fraction));
  return [...points, now];
}

/** The UTC date `days` after `at`, at midnight — the far edge the run has to be covered to. */
export function ceilingFor(virtualEnd: Date, days = FLOOR_MARGIN_DAYS): Date {
  const ceiling = new Date(virtualEnd.getTime() + days * 86_400_000);
  return new Date(Date.UTC(ceiling.getUTCFullYear(), ceiling.getUTCMonth(), ceiling.getUTCDate()));
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
  virtualEnd: Date,
): StaffingPlan {
  const floor = floorFor(virtualStart);
  const ceiling = ceilingFor(virtualEnd);
  const plans: StaffingBackdate[] = [];
  const blocked: string[] = [];

  // Grouped and walked in order, not judged row by row. The backend refuses an
  // update that overlaps another ACTIVE row of the same {person, location, role}
  // (AssignmentOverlapSearch), and two rows planned independently can each look
  // safe against the *stored* windows while colliding with each other once both
  // are applied — which is what a first attempt at this did.
  const groups = new Map<string, StaffingWindow[]>();
  for (const assignment of assignments) {
    if (assignment.status !== 'ACTIVE') {
      // The presence check counts ACTIVE rows only, and reviving a suspended
      // assignment would be inventing staff.
      continue;
    }
    const key = keyOf(assignment);
    groups.set(key, [...(groups.get(key) ?? []), assignment]);
  }

  for (const group of groups.values()) {
    const rows = [...group].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    // The furthest end applied so far, so the next row starts after it.
    //
    // A running *maximum*, not the last row's end. Assigning the current row's
    // end unconditionally shrinks the bound whenever a row ends earlier than the
    // one before it — and sets it to "unbounded" for an open-ended row — which
    // lets the row after that slip past the overlap guard and be widened into a
    // window that is already occupied.
    //
    // Infinity for an open-ended row, which covers everything after it; -Infinity
    // before the first row, which nothing can overlap.
    let previousEnd = Number.NEGATIVE_INFINITY;
    let previousId: string | null = null;
    const endOf = (value: number | null): number => value ?? Number.POSITIVE_INFINITY;
    // Raised together, so the id always names the row that set the bound. Moving
    // the id on every row instead made an overlap report point at whichever row
    // was seen last rather than the one actually in the way.
    const raiseTo = (end: number, assignmentId: string): void => {
      if (end > previousEnd) {
        previousEnd = end;
        previousId = assignmentId;
      }
    };

    for (const [index, row] of rows.entries()) {
      const from = row.effectiveFrom.getTime();
      const to = row.effectiveTo?.getTime() ?? null;
      const isLast = index === rows.length - 1;

      // Two stored ACTIVE rows that already overlap are a state the backend's own
      // guard should have refused. Nothing here can widen either safely.
      if (from <= previousEnd) {
        blocked.push(
          `${row.personId} ${row.role} at ${row.locationId}: assignment ${row.assignmentId} starts ` +
            `${iso(row.effectiveFrom)}, on or before ${previousId} ends — they already overlap`,
        );
        raiseTo(endOf(to), row.assignmentId);
        continue;
      }

      // Back to the floor, but never past the row before it, and never later than
      // where it already starts.
      const lowerBound =
        previousEnd === Number.NEGATIVE_INFINITY ? floor.getTime() : previousEnd + DAY_MS;
      const effectiveFrom = new Date(Math.min(from, Math.max(lowerBound, floor.getTime())));

      // Only the group's last row reaches for the ceiling: extending an earlier
      // one would run into the next. An open-ended row already covers the rest.
      // Closed before the run began: this person was not staff during the year,
      // and widening the window to say otherwise is inventing work they did not
      // do. Left exactly as it is — including when it is the group's last row,
      // where the temptation to stretch it to the ceiling is strongest.
      if (to !== null && to <= floor.getTime()) {
        raiseTo(to, row.assignmentId);
        continue;
      }

      const effectiveTo =
        to === null ? null : isLast && to < ceiling.getTime() ? ceiling : new Date(to);

      raiseTo(endOf(effectiveTo?.getTime() ?? null), row.assignmentId);

      const movedStart = effectiveFrom.getTime() !== from;
      const movedEnd = (effectiveTo?.getTime() ?? null) !== to;
      if (!movedStart && !movedEnd) {
        continue;
      }

      plans.push({
        assignmentId: row.assignmentId,
        personId: row.personId,
        locationId: row.locationId,
        role: row.role,
        isPrimary: row.isPrimary,
        effectiveFrom,
        effectiveTo,
        was: row.effectiveFrom,
        wasTo: row.effectiveTo,
      });
    }
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
    virtualEnd: Date,
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

      const planned = planStaffingBackdates(assignments, virtualStart, virtualEnd);
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
          `${plan.personId} ${plan.role} at ${plan.locationId}: ` +
            `${iso(plan.was)}–${plan.wasTo ? iso(plan.wasTo) : 'open'} → ` +
            `${iso(plan.effectiveFrom)}–${plan.effectiveTo ? iso(plan.effectiveTo) : 'open'}`,
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
