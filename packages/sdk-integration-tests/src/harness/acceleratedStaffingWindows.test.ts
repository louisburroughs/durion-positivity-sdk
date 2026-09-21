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
    const [plan] = planStaffingBackdates([assignment()], VIRTUAL_START);

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

    expect(planStaffingBackdates([already], VIRTUAL_START)).toEqual([]);
    expect(planStaffingBackdates([assignment({ effectiveFrom: FLOOR })], VIRTUAL_START)).toEqual([]);
  });

  it('leaves everything that is not ACTIVE, because reviving it would be inventing staff', () => {
    const suspended = assignment({ status: 'SUSPENDED' });
    const ended = assignment({ status: 'ENDED' });

    expect(planStaffingBackdates([suspended, ended], VIRTUAL_START)).toEqual([]);
  });

  it('leaves an assignment that closed before the run: moving its start would still cover nothing', () => {
    const closed = assignment({
      effectiveFrom: new Date('2025-06-01T00:00:00.000Z'),
      effectiveTo: new Date('2025-07-01T00:00:00.000Z'),
    });

    expect(planStaffingBackdates([closed], VIRTUAL_START)).toEqual([]);
  });

  it('keeps an end date that falls inside the run, so a real departure stays real', () => {
    const leaves = assignment({ effectiveTo: new Date('2026-01-31T00:00:00.000Z') });
    const [plan] = planStaffingBackdates([leaves], VIRTUAL_START);

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
