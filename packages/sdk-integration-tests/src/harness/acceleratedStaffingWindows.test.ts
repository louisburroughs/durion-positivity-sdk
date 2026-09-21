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
    const [plan] = planStaffingBackdates([assignment()], VIRTUAL_START).plans;

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

  it('leaves an assignment already effective at the floor alone, so a re-run writes nothing', () => {
    const already = assignment({ effectiveFrom: new Date('2024-01-01T00:00:00.000Z') });

    expect(planStaffingBackdates([already], VIRTUAL_START).plans).toEqual([]);
    expect(planStaffingBackdates([assignment({ effectiveFrom: FLOOR })], VIRTUAL_START).plans).toEqual([]);
  });

  it('leaves everything that is not ACTIVE, because reviving it would be inventing staff', () => {
    const suspended = assignment({ status: 'SUSPENDED' });
    const ended = assignment({ status: 'ENDED' });

    expect(planStaffingBackdates([suspended, ended], VIRTUAL_START).plans).toEqual([]);
  });

  it('leaves an assignment that closed before the run: moving its start would still cover nothing', () => {
    const closed = assignment({
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-07-01T00:00:00.000Z'),
    });

    expect(planStaffingBackdates([closed], VIRTUAL_START).plans).toEqual([]);
  });

  it('clamps the start to the day after an ACTIVE sibling that closes before it', () => {
    // The backend refuses an update whose window overlaps another ACTIVE
    // assignment of the same person, location and role
    // (AssignmentOverlapSearch). Landing on the floor would collide here.
    const earlier = assignment({
      assignmentId: 'sa-earlier',
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-11-30T00:00:00.000Z'),
    });
    const { plans, blocked } = planStaffingBackdates([earlier, assignment()], VIRTUAL_START);

    // Only the later row moves — `earlier` ends after the floor, so it is not
    // itself a candidate, and the mover starts the day after it closes.
    expect(plans).toHaveLength(1);
    expect(plans[0].assignmentId).toBe('sa-1');
    expect(iso(plans[0].effectiveFrom)).toBe('2025-12-01');
    expect(blocked).toEqual([]);
  });

  it('ignores an ENDED sibling, which the overlap guard does not count', () => {
    const endedSibling = assignment({
      assignmentId: 'sa-ended',
      status: 'ENDED',
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-11-30T00:00:00.000Z'),
    });
    const { plans } = planStaffingBackdates([endedSibling, assignment()], VIRTUAL_START);

    expect(plans).toHaveLength(1);
    expect(iso(plans[0].effectiveFrom)).toBe('2025-08-15');
  });

  it('leaves a row alone when an ACTIVE sibling already covers the floor', () => {
    const covering = assignment({
      assignmentId: 'sa-covering',
      effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const { plans, blocked } = planStaffingBackdates([covering, assignment()], VIRTUAL_START);

    // The person is already present at the floor; nothing to write, nothing wrong.
    expect(plans).toEqual([]);
    expect(blocked).toEqual([]);
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
    const { plans, blocked } = planStaffingBackdates([across, assignment()], VIRTUAL_START);

    expect(plans).toEqual([]);
    expect(blocked).toHaveLength(2);
    expect(blocked.join(' ')).toContain('sa-across');
    expect(blocked.join(' ')).toContain('sa-1');
  });

  it('keys siblings on person, location and role, so another location is not a conflict', () => {
    const elsewhere = assignment({
      assignmentId: 'sa-other-site',
      locationId: 'loc-2',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: null,
    });
    const { plans, blocked } = planStaffingBackdates([elsewhere, assignment()], VIRTUAL_START);

    expect(blocked).toEqual([]);
    expect(plans.map((plan) => plan.assignmentId).sort()).toEqual(['sa-1', 'sa-other-site']);
  });

  it('keeps an end date that falls inside the run, so a real departure stays real', () => {
    const leaves = assignment({ effectiveTo: new Date('2026-01-31T00:00:00.000Z') });
    const [plan] = planStaffingBackdates([leaves], VIRTUAL_START).plans;

    expect(iso(plan.effectiveFrom)).toBe('2025-08-15');
    expect(iso(plan.effectiveTo as Date)).toBe('2026-01-31');
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
    );

    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-1', 'sa-2']);
    expect(backdated).toHaveLength(2);
    expect(backdated[0]).toContain('person-1 TECHNICIAN at loc-1 from 2026-09-20 to 2025-08-15');
    expect(unreadable).toEqual([]);
  });

  it('asks about each person once, however often the roster names them', async () => {
    const { port, written } = fakePort({ 'person-1': [assignment()] });

    await new AcceleratedStaffingWindows(port).run(['person-1', 'person-1'], VIRTUAL_START);

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
      new AcceleratedStaffingWindows(port).run(['person-1'], VIRTUAL_START),
    ).rejects.toThrow(/not one of 1 staffing assignment\(s\) could be back-dated/);
  });

  it('does not throw when there was simply nothing to move', async () => {
    const { port } = fakePort({
      'person-1': [assignment({ effectiveFrom: new Date('2024-01-01T00:00:00.000Z') })],
    });

    const { backdated, failed } = await new AcceleratedStaffingWindows(port).run(
      ['person-1'],
      VIRTUAL_START,
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

    const { blocked } = await new AcceleratedStaffingWindows(port).run(['person-1'], VIRTUAL_START);

    expect(written).toEqual([]);
    expect(blocked).toHaveLength(2);
  });

  it('reports a person it cannot read and carries on with the rest', async () => {
    const { port, written } = fakePort({
      'person-1': new Error('people answered 500'),
      'person-2': [assignment({ assignmentId: 'sa-2', personId: 'person-2' })],
    });

    const { backdated, unreadable } = await new AcceleratedStaffingWindows(port).run(
      ['person-1', 'person-2'],
      VIRTUAL_START,
    );

    expect(unreadable).toEqual(['person-1: people answered 500']);
    expect(written.map((plan) => plan.assignmentId)).toEqual(['sa-2']);
    expect(backdated).toHaveLength(1);
  });
});
