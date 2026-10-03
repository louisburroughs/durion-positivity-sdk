import { decideCloseOut, heldPositions, startOfUtcDay, type HeldPosition } from './shopFloorCloseOutPlan';

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
  it('closes work created before today in a finishable status', () => {
    for (const status of ['ASSIGNED', 'WORK_IN_PROGRESS', 'APPROVED']) {
      expect(decideCloseOut(position, { status, createdAt: YESTERDAY }, NOW)).toEqual({ action: 'close', position });
    }
  });

  it('keeps work created today: it is the morning load', () => {
    const decision = decideCloseOut(position, { status: 'WORK_IN_PROGRESS', createdAt: new Date('2026-10-03T00:00:00Z') }, NOW);
    expect(decision).toEqual({ action: 'keep', position, reason: 'created today' });
  });

  it('keeps a status it cannot finish from', () => {
    const decision = decideCloseOut(position, { status: 'DRAFT', createdAt: YESTERDAY }, NOW);
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
