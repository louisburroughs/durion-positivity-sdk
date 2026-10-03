import { currentAssignedAt, decideCloseOut, heldPositions, startOfUtcDay, type HeldPosition } from './shopFloorCloseOutPlan';

const NOW = new Date('2026-10-03T12:00:00Z');
const YESTERDAY = new Date('2026-10-02T15:00:00Z');
const position: HeldPosition = { kind: 'BAY', id: 'bay-1', name: 'Bay 1', workorderId: 'wo-1' };

describe('startOfUtcDay', () => {
  it('truncates to midnight UTC', () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });
});

describe('heldPositions', () => {
  it('lists only bays and mobile units an open workorder holds', () => {
    const held = heldPositions({
      bays: [
        { bayId: 'b1', bayName: 'Bay 1', available: false, assignedWorkorderId: 'wo-1' },
        { bayId: 'b2', available: true },
      ],
      mobileUnits: [{ unitId: 'u1', available: false, assignedWorkorderId: 'wo-2' }],
    });
    expect(held).toEqual([
      { kind: 'BAY', id: 'b1', name: 'Bay 1', workorderId: 'wo-1' },
      { kind: 'MOBILE_UNIT', id: 'u1', name: 'u1', workorderId: 'wo-2' },
    ]);
  });
});

describe('decideCloseOut', () => {
  it('closes work holding its position since before today in a finishable status', () => {
    for (const status of ['ASSIGNED', 'WORK_IN_PROGRESS', 'APPROVED']) {
      expect(decideCloseOut(position, { status, heldSince: YESTERDAY }, NOW)).toEqual({ action: 'close', position });
    }
  });

  it('keeps work placed today, however old the workorder: it is the morning load', () => {
    const decision = decideCloseOut(position, { status: 'WORK_IN_PROGRESS', heldSince: new Date('2026-10-03T00:00:00Z') }, NOW);
    expect(decision).toEqual({ action: 'keep', position, reason: 'placed today' });
  });

  it('keeps a position whose assignment time could not be read', () => {
    expect(decideCloseOut(position, { status: 'WORK_IN_PROGRESS' }, NOW)).toEqual({
      action: 'keep',
      position,
      reason: 'position assignment time unavailable',
    });
  });

  it('keeps a status it cannot finish from', () => {
    const decision = decideCloseOut(position, { status: 'DRAFT', heldSince: YESTERDAY }, NOW);
    expect(decision.action).toBe('keep');
  });

  it('keeps a workorder whose detail could not be read', () => {
    expect(decideCloseOut(position, undefined, NOW)).toEqual({
      action: 'keep',
      position,
      reason: 'workorder detail unavailable',
    });
  });
});

describe('currentAssignedAt', () => {
  const morning = new Date('2026-10-03T09:00:00Z');
  const lastWeek = new Date('2026-09-26T09:00:00Z');

  it('reads the record flagged current', () => {
    const history = [
      { resourceId: 'bay-1', assignedAt: lastWeek, releasedAt: new Date('2026-09-27T09:00:00Z') },
      { resourceId: 'bay-1', assignedAt: morning, current: true },
    ];
    expect(currentAssignedAt(history, 'bay-1')).toEqual(morning);
  });

  it('falls back to the unreleased record on this resource', () => {
    expect(currentAssignedAt([{ resourceId: 'bay-1', assignedAt: lastWeek }], 'bay-1')).toEqual(lastWeek);
    expect(currentAssignedAt([{ resourceId: 'bay-2', assignedAt: lastWeek }], 'bay-1')).toBeUndefined();
    expect(currentAssignedAt(undefined, 'bay-1')).toBeUndefined();
  });
});
