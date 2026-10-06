import { siteCapacity, siteClaimOrder } from './siteShare';
import type { SiteRoster } from '../runs/shopFloorPlan';

const site = (code: string, positions: number, technicians: number, busy = 0): SiteRoster => ({
  locationId: code,
  code,
  name: code,
  freePositions: Array.from({ length: positions - busy }, (_, i) => ({ kind: 'BAY' as const, id: `${code}-p${i}`, name: `Bay ${i}` })),
  occupiedPositions: Array.from({ length: busy }, (_, i) => ({ kind: 'BAY' as const, id: `${code}-o${i}`, name: `Bay o${i}` })),
  idleTechnicianIds: Array.from({ length: technicians - busy }, (_, i) => `${code}-t${i}`),
  busyTechnicianIds: Array.from({ length: busy }, (_, i) => `${code}-b${i}`),
});

const codes = (rosters: SiteRoster[]) => rosters.map((roster) => roster.code);

describe('siteCapacity', () => {
  it('is the positions a site can crew: the smaller of positions and technicians, busy or free', () => {
    expect(siteCapacity(site('A', 10, 8))).toBe(8);
    expect(siteCapacity(site('B', 5, 3))).toBe(3);
    // Busy ones count: a bay with a job on it is still the site's capacity.
    expect(siteCapacity(site('C', 4, 4, 4))).toBe(4);
    expect(siteCapacity(site('D', 0, 6))).toBe(0);
  });
});

describe('siteClaimOrder', () => {
  it('keeps discovery order when nothing has started yet', () => {
    expect(codes(siteClaimOrder([site('A', 10, 8), site('B', 5, 3)], new Map()))).toEqual(['A', 'B']);
  });

  it('puts the site furthest below its share of capacity first', () => {
    // A has 8 of capacity and 4 started (0.5 each); B has 2 and none started.
    const order = siteClaimOrder([site('A', 10, 8), site('B', 2, 2)], new Map([['A', 4]]));
    expect(codes(order)).toEqual(['B', 'A']);
  });

  it('puts a site that cannot crew anything last, whatever has started', () => {
    const order = siteClaimOrder([site('Z', 3, 0), site('A', 4, 4)], new Map([['A', 9]]));
    expect(codes(order)).toEqual(['A', 'Z']);
  });

  it('over a day, gives each site jobs in proportion to its capacity (#157)', () => {
    // Alpha's shape: one large site first in discovery order, three smaller ones.
    const rosters = [site('MAIN', 10, 8), site('SOUTH', 9, 7), site('NORTH', 8, 6), site('RIV', 8, 3)];
    const started = new Map<string, number>();
    for (let job = 0; job < 48; job += 1) {
      const next = siteClaimOrder(rosters, started)[0];
      started.set(next.locationId, (started.get(next.locationId) ?? 0) + 1);
    }
    // Capacities 8:7:6:3 of 24, times 48 jobs.
    expect(Object.fromEntries(started)).toEqual({ MAIN: 16, SOUTH: 14, NORTH: 12, RIV: 6 });
  });
});
