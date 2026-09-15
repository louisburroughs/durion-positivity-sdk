import { buildRoster, busyTechnicianIds, isOnPto, type BoardView, type StaffingView } from './shopFloorRoster';

const SITE = { locationId: 'loc-1', code: 'CLT-MAIN-001', name: 'Charlotte Main' };
const ON = new Date('2026-09-15T12:00:00Z');

const bay = (id: string, over: Partial<{ available: boolean; assignedWorkorderId: string }> = {}) => ({
  bayId: id,
  bayName: `Bay ${id}`,
  available: true,
  ...over,
});
const unit = (id: string, over: Partial<{ available: boolean; assignedWorkorderId: string }> = {}) => ({
  unitId: id,
  unitName: `MU-${id}`,
  available: true,
  ...over,
});
const tech = (personId: string): StaffingView => ({ personId, role: 'TECHNICIAN', assignmentStatus: 'ACTIVE' });

const rosterOf = (board: BoardView, staffing: readonly StaffingView[] = []) => {
  const outcome = buildRoster(SITE, board, staffing, ON);
  if (outcome.kind !== 'roster') {
    throw new Error(`expected a roster, got skipped: ${outcome.reason}`);
  }
  return outcome.roster;
};

describe('isOnPto', () => {
  it('counts a PTO interval covering the date, inclusive of both ends', () => {
    const covering = { ptoEntries: [{ start: new Date('2026-09-15T00:00:00Z'), end: new Date('2026-09-16T00:00:00Z') }] };
    expect(isOnPto(covering, ON)).toBe(true);
    expect(isOnPto({ ptoEntries: [{ start: ON, end: ON }] }, ON)).toBe(true);
  });

  it('ignores PTO that has ended or has not started', () => {
    expect(
      isOnPto({ ptoEntries: [{ start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-02T00:00:00Z') }] }, ON),
    ).toBe(false);
    expect(
      isOnPto({ ptoEntries: [{ start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-02T00:00:00Z') }] }, ON),
    ).toBe(false);
    expect(isOnPto({}, ON)).toBe(false);
  });
});

describe('busyTechnicianIds', () => {
  it('counts a workorder, a break and PTO as busy, and nothing else', () => {
    const board: BoardView = {
      mechanics: [
        { personId: 'on-job', assignedWorkorderId: 'wo-1' },
        { personId: 'on-break', onBreak: true },
        {
          personId: 'on-pto',
          ptoEntries: [{ start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-09-16T00:00:00Z') }],
        },
        { personId: 'free' },
      ],
    };

    expect([...busyTechnicianIds(board, ON)].sort()).toEqual(['on-break', 'on-job', 'on-pto']);
  });
});

describe('buildRoster', () => {
  it('splits positions into free and occupied', () => {
    const roster = rosterOf({
      bays: [bay('1'), bay('2', { assignedWorkorderId: 'wo-1' }), bay('3', { available: false })],
      mobileUnits: [unit('a')],
    });

    expect(roster.freePositions.map((p) => p.name)).toEqual(['Bay 1', 'MU-a']);
    expect(roster.occupiedPositions.map((p) => p.name)).toEqual(['Bay 2', 'Bay 3']);
  });

  it('counts only ACTIVE TECHNICIAN assignments as technicians', () => {
    const roster = rosterOf({ bays: [bay('1')] }, [
      tech('t1'),
      { personId: 'advisor', role: 'SERVICE_ADVISOR', assignmentStatus: 'ACTIVE' },
      { personId: 'ended', role: 'TECHNICIAN', assignmentStatus: 'ENDED' },
      { personId: 'no-role', assignmentStatus: 'ACTIVE' },
    ]);

    expect(roster.idleTechnicianIds).toEqual(['t1']);
    expect(roster.busyTechnicianIds).toEqual([]);
  });

  it('splits technicians into idle and busy using the board, PTO included', () => {
    const roster = rosterOf(
      {
        bays: [bay('1')],
        mechanics: [
          { personId: 't2', assignedWorkorderId: 'wo-9' },
          { personId: 't3', ptoEntries: [{ start: new Date('2026-09-15T00:00:00Z'), end: new Date('2026-09-20T00:00:00Z') }] },
        ],
      },
      [tech('t1'), tech('t2'), tech('t3')],
    );

    expect(roster.idleTechnicianIds).toEqual(['t1']);
    expect(roster.busyTechnicianIds).toEqual(['t2', 't3']);
  });

  it('keeps a site with no idle technician, so its free positions are still reported', () => {
    const roster = rosterOf(
      { bays: [bay('1'), bay('2')], mechanics: [{ personId: 't1', assignedWorkorderId: 'wo-1' }] },
      [tech('t1')],
    );

    expect(roster.idleTechnicianIds).toEqual([]);
    expect(roster.freePositions).toHaveLength(2);
  });

  it('keeps a site with no technician at all rather than hiding its empty bays', () => {
    const roster = rosterOf({ bays: [bay('1')] }, []);

    expect(roster.idleTechnicianIds).toEqual([]);
    expect(roster.freePositions).toHaveLength(1);
  });

  it('skips a board flagged dataQualityWarning rather than risk a double-booking', () => {
    const outcome = buildRoster(SITE, { dataQualityWarning: true, bays: [bay('1')] }, [tech('t1')], ON);

    expect(outcome.kind).toBe('skipped');
    expect(outcome.kind === 'skipped' && outcome.reason).toContain('dataQualityWarning');
  });

  it('skips a site with no bay and no mobile unit', () => {
    const outcome = buildRoster(SITE, { bays: [], mobileUnits: [] }, [tech('t1')], ON);

    expect(outcome.kind).toBe('skipped');
    expect(outcome.kind === 'skipped' && outcome.reason).toContain('no bay or mobile unit');
  });

  it('falls back to the id when a replica has not supplied a name yet', () => {
    const roster = rosterOf({ bays: [{ bayId: 'bay-7', available: true }] });

    expect(roster.freePositions[0].name).toBe('bay-7');
  });
});
