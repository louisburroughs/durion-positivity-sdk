import {
  AcceleratedStaffingWindows,
  floorFor,
  iso,
  planStaffingBackdates,
  type StaffingBackdate,
  type StaffingWindow,
  type StaffingWindowPort,
} from './acceleratedStaffingWindows';

const VIRTUAL_START = new Date('2025-08-16T23:00:30.000Z');
/** A year of virtual days, as the run drives. */
const VIRTUAL_END = new Date('2026-08-16T23:00:30.000Z');
/** One day past the run's end, where a lapsing window is pushed to. */
const CEILING = '2026-08-17';
/** One day below the virtual start, at UTC midnight — where a back-dated row lands. */
const FLOOR = new Date('2025-08-15T00:00:00.000Z');

const assignment = (overrides: Partial<StaffingWindow> = {}): StaffingWindow => ({
  assignmentId: 'sa-1',
  personId: 'person-1',
  locationId: 'loc-1',
  role: 'TECHNICIAN',
  isPrimary: true,
  status: 'ACTIVE',
  // Written in wall time: ten months after the instant the run judges.
  effectiveFrom: new Date('2026-09-20T00:00:00.000Z'),
  effectiveTo: null,
  ...overrides,
});

describe('planStaffingBackdates', () => {
  it('moves an assignment that starts after the run to the floor below it', () => {
    const [plan] = planStaffingBackdates([assignment()], VIRTUAL_START, VIRTUAL_END).plans;

    expect(plan.assignmentId).toBe('sa-1');
    expect(iso(plan.effectiveFrom)).toBe('2025-08-15');
    expect(iso(plan.was)).toBe('2026-09-20');
    // Everything the update has to round-trip comes back untouched.
    expect(plan.personId).toBe('person-1');
    expect(plan.locationId).toBe('loc-1');
    expect(plan.role).toBe('TECHNICIAN');
    expect(plan.isPrimary).toBe(true);
    expect(plan.effectiveTo).toBeNull();
  });

  it('leaves a row that already spans the whole run, so a re-run writes nothing', () => {
    // Open-ended and starting at or below the floor: covered from the first
    // virtual day to the last.
    const already = assignment({ effectiveFrom: new Date('2024-01-01T00:00:00.000Z') });

    expect(planStaffingBackdates([already], VIRTUAL_START, VIRTUAL_END).plans).toEqual([]);
    expect(planStaffingBackdates([assignment({ effectiveFrom: FLOOR })], VIRTUAL_START, VIRTUAL_END).plans).toEqual([]);
  });

  it('extends a row that starts before the run but lapses inside it', () => {
    // The failure this exists for. The backend answered "3 ACTIVE technician
    // staffing assignments exist at this location, none effective on 2025-11-10"
    // while this pass reported nothing to do, because the old rule looked only at
    // where a row *started*.
    const lapses = assignment({
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-09-30T00:00:00.000Z'),
    });
    const [plan] = planStaffingBackdates([lapses], VIRTUAL_START, VIRTUAL_END).plans;

    expect(iso(plan.effectiveFrom)).toBe('2025-01-01');
    expect(iso(plan.effectiveTo as Date)).toBe(CEILING);
    expect(iso(plan.wasTo as Date)).toBe('2025-09-30');
  });

  it('leaves everything that is not ACTIVE, because reviving it would be inventing staff', () => {
    const suspended = assignment({ status: 'SUSPENDED' });
    const ended = assignment({ status: 'ENDED' });

    expect(planStaffingBackdates([suspended, ended], VIRTUAL_START, VIRTUAL_END).plans).toEqual([]);
  });

  it('leaves an assignment that closed before the run: moving its start would still cover nothing', () => {
    const closed = assignment({
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-07-01T00:00:00.000Z'),
    });

    expect(planStaffingBackdates([closed], VIRTUAL_START, VIRTUAL_END).plans).toEqual([]);
  });

  it('walks a key in order: the first row reaches back, the last reaches forward', () => {
    // The backend refuses an update whose window overlaps another ACTIVE
    // assignment of the same person, location and role
    // (AssignmentOverlapSearch). Landing on the floor would collide here.
    const earlier = assignment({
      assignmentId: 'sa-earlier',
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-11-30T00:00:00.000Z'),
    });
    const { plans, blocked } = planStaffingBackdates([earlier, assignment()], VIRTUAL_START, VIRTUAL_END);

    // Only `sa-1` moves. `earlier` already starts below the floor and a later row
    // follows it, so it has nothing to reach for at either end; `sa-1` starts the
    // day after it closes and carries the run from there.
    const byId = Object.fromEntries(plans.map((plan) => [plan.assignmentId, plan]));
    expect(Object.keys(byId).sort()).toEqual(['sa-1']);
    expect(iso(byId['sa-1'].effectiveFrom)).toBe('2025-12-01');
    expect(blocked).toEqual([]);
  });

  it('ignores an ENDED sibling, which the overlap guard does not count', () => {
    const endedSibling = assignment({
      assignmentId: 'sa-ended',
      status: 'ENDED',
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-11-30T00:00:00.000Z'),
    });
    const { plans } = planStaffingBackdates([endedSibling, assignment()], VIRTUAL_START, VIRTUAL_END);

    expect(plans).toHaveLength(1);
    expect(iso(plans[0].effectiveFrom)).toBe('2025-08-15');
  });

  it('keeps the furthest end when a key already overlaps, so later rows stay blocked', () => {
    // The bound has to be a running maximum. Tracking the last row's end instead
    // lets a short row after a long one lower the guard, and the row after that
    // is then widened into a window that is already occupied.
    const long = assignment({
      assignmentId: 'sa-long',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-06-30T00:00:00.000Z'),
    });
    const overlapsLong = assignment({
      assignmentId: 'sa-short',
      effectiveFrom: new Date('2025-02-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-02-28T00:00:00.000Z'),
    });
    const after = assignment({
      assignmentId: 'sa-after',
      effectiveFrom: new Date('2025-03-01T00:00:00.000Z'),
      effectiveTo: null,
    });

    const { plans, blocked } = planStaffingBackdates(
      [long, overlapsLong, after],
      VIRTUAL_START,
      VIRTUAL_END,
    );

    // sa-short overlaps sa-long, and sa-after starts inside sa-long as well —
    // both are named, and nothing is written into the occupied window.
    expect(blocked).toHaveLength(2);
    expect(blocked.join(' ')).toContain('sa-short');
    expect(blocked.join(' ')).toContain('sa-after');
    expect(plans.map((plan) => plan.assignmentId)).not.toContain('sa-after');
  });

  it('reports a duplicate open row rather than widening into it', () => {
    // Two ACTIVE open-ended rows of one key overlap by definition, which the
    // backend's own guard should have refused. The earlier one still reaches back
    // to the floor; the later one is named and left alone.
    const covering = assignment({
      assignmentId: 'sa-covering',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const { plans, blocked } = planStaffingBackdates([covering, assignment()], VIRTUAL_START, VIRTUAL_END);

    expect(plans).toEqual([]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('sa-1');
  });

  it('writes nothing when two ACTIVE rows of one key already overlap, and says so', () => {
    // A state the backend's own guard should have refused: two open-ended ACTIVE
    // assignments for the same person, location and role. Neither can move while
    // the other stands, so both are reported and nothing is written.
    const across = assignment({
      assignmentId: 'sa-across',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const { plans, blocked } = planStaffingBackdates([across, assignment()], VIRTUAL_START, VIRTUAL_END);

    // The earlier row is widened back to the floor, which is safe and useful; the
    // one that duplicates it is reported instead of written.
    expect(plans.map((plan) => plan.assignmentId)).toEqual(['sa-across']);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('sa-1');
  });

  it('keys siblings on person, location and role, so another location is not a conflict', () => {
    const elsewhere = assignment({
      assignmentId: 'sa-other-site',
      locationId: 'loc-2',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const { plans, blocked } = planStaffingBackdates([elsewhere, assignment()], VIRTUAL_START, VIRTUAL_END);

    expect(blocked).toEqual([]);
    expect(plans.map((plan) => plan.assignmentId).sort()).toEqual(['sa-1', 'sa-other-site']);
  });

  it('pushes an end that falls inside the run out to the ceiling', () => {
    // A departure mid-run leaves the rest of the year unstaffed, and this fixture
    // exists to keep its seeded mechanics present for all of it. The row is the
    // last of its key, so it is the one that has to reach.
    const leaves = assignment({ effectiveTo: new Date('2026-01-31T00:00:00.000Z') });
    const [plan] = planStaffingBackdates([leaves], VIRTUAL_START, VIRTUAL_END).plans;

    expect(iso(plan.effectiveFrom)).toBe('2025-08-15');
    expect(iso(plan.effectiveTo as Date)).toBe(CEILING);
  });
});

describe('floorFor', () => {
  it('lands on UTC midnight, because effectiveFrom is a LocalDate on the wire', () => {
    expect(floorFor(VIRTUAL_START).toISOString()).toBe('2025-08-15T00:00:00.000Z');
  });
});

describe('AcceleratedStaffingWindows', () => {
  const fakePort = (
    byPerson: Record<string, StaffingWindow[] | Error>,
    /** Assignment ids whose update the backend refuses. */
    refuse: Record<string, Error> = {},
  ): { port: StaffingWindowPort; written: StaffingBackdate[] } => {
    const written: StaffingBackdate[] = [];
    const port: StaffingWindowPort = {
      async list(personId: string): Promise<StaffingWindow[]> {
        const answer = byPerson[personId];
        if (answer instanceof Error) {
          throw answer;
        }
        return answer ?? [];
      },
      async backdate(plan: StaffingBackdate): Promise<void> {
        const refusal = refuse[plan.assignmentId];
        if (refusal) {
          throw refusal;
        }
        written.push(plan);
      },
    };
    return { port, written };
  };

  it('writes one update per assignment that has to move, and reports each', async () => {
    const { port, written } = fakePort({
      'person-1': [assignment()],
      'person-2': [assignment({ assignmentId: 'sa-2', personId: 'person-2' })],
    });

    const { backdated, unreadable } = await new AcceleratedStaffingWindows(port).run(
      ['person-1', 'person-2'],
      VIRTUAL_START,
      VIRTUAL_END,
    );

    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-1', 'sa-2']);
    expect(backdated).toHaveLength(2);
    expect(backdated[0]).toContain('person-1 TECHNICIAN at loc-1: 2026-09-20–open → 2025-08-15–open');
    expect(unreadable).toEqual([]);
  });

  it('asks about each person once, however often the roster names them', async () => {
    const { port, written } = fakePort({ 'person-1': [assignment()] });

    await new AcceleratedStaffingWindows(port).run(['person-1', 'person-1'], VIRTUAL_START, VIRTUAL_END);

    expect(written).toHaveLength(1);
  });

  it('reports a refused update and carries on, so one bad row does not end the run', async () => {
    // 409 is the overlap guard on a shape the planner did not foresee; the next
    // person's assignment is unaffected and still moves.
    const { port, written } = fakePort(
      {
        'person-1': [assignment()],
        'person-2': [assignment({ assignmentId: 'sa-2', personId: 'person-2' })],
      },
      { 'sa-1': new Error('people answered 409 - An overlapping assignment already exists') },
    );

    const { backdated, failed } = await new AcceleratedStaffingWindows(port).run(
      ['person-1', 'person-2'],
      VIRTUAL_START,
      VIRTUAL_END,
    );

    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-2']);
    expect(backdated).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('sa-1');
    expect(failed[0]).toContain('409');
  });

  it('throws when nothing at all could be moved, rather than walking into the refusal', async () => {
    // Every row failed, so no mechanic is present anywhere and every booking
    // would come back MECHANIC_UNAVAILABLE. Better to fail here, naming why.
    const { port } = fakePort(
      { 'person-1': [assignment()] },
      { 'sa-1': new Error('people answered 403') },
    );

    await expect(
      new AcceleratedStaffingWindows(port).run(['person-1'], VIRTUAL_START, VIRTUAL_END),
    ).rejects.toThrow(/not one of 1 staffing assignment\(s\) could be back-dated/);
  });

  it('does not throw when there was simply nothing to move', async () => {
    const { port } = fakePort({
      'person-1': [assignment({ effectiveFrom: new Date('2024-01-01T00:00:00.000Z') })],
    });

    const { backdated, failed } = await new AcceleratedStaffingWindows(port).run(
      ['person-1'],
      VIRTUAL_START,
      VIRTUAL_END,
    );

    expect(backdated).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('carries the planner\'s blocked rows out to the caller', async () => {
    const across = assignment({
      assignmentId: 'sa-across',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const { port, written } = fakePort({ 'person-1': [across, assignment()] });

    const { blocked } = await new AcceleratedStaffingWindows(port).run(['person-1'], VIRTUAL_START, VIRTUAL_END);

    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-across']);
    expect(blocked).toHaveLength(1);
  });

  it('writes only at the sites it is given, however many a person is assigned to', async () => {
    // Every employee is read so the right people are found, but on a shared
    // environment only the run's own sites may be rewritten. A person also staffed
    // somewhere the run never touches keeps that assignment exactly as it was.
    const { port, written } = fakePort({
      'person-1': [
        assignment({ assignmentId: 'sa-here', locationId: 'loc-1' }),
        assignment({ assignmentId: 'sa-elsewhere', locationId: 'loc-2' }),
      ],
    });

    await new AcceleratedStaffingWindows(port).run(
      ['person-1'],
      VIRTUAL_START,
      VIRTUAL_END,
      new Set(['loc-1']),
    );

    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-here']);
  });

  it('reports a person it cannot read and carries on with the rest', async () => {
    const { port, written } = fakePort({
      'person-1': new Error('people answered 500'),
      'person-2': [assignment({ assignmentId: 'sa-2', personId: 'person-2' })],
    });

    const { backdated, unreadable } = await new AcceleratedStaffingWindows(port).run(
      ['person-1', 'person-2'],
      VIRTUAL_START,
      VIRTUAL_END,
    );

    expect(unreadable).toEqual(['person-1: people answered 500']);
    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-2']);
    expect(backdated).toHaveLength(1);
  });
});

