import {
  formatCoverageReport,
  interleaveByKind,
  planFloor,
  planSite,
  type ShopPosition,
  type SiteRoster,
} from './shopFloorPlan';

const bay = (n: number): ShopPosition => ({ kind: 'BAY', id: `bay-${n}`, name: `Bay 0${n}` });
const unit = (n: number): ShopPosition => ({ kind: 'MOBILE_UNIT', id: `mu-${n}`, name: `MU-0${n}` });
const technicians = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `tech-${index + 1}`);

const roster = (over: Partial<SiteRoster> = {}): SiteRoster => ({
  locationId: 'loc-1',
  code: 'CLT-MAIN-001',
  name: 'Charlotte Main Service Center',
  freePositions: [],
  occupiedPositions: [],
  idleTechnicianIds: [],
  busyTechnicianIds: [],
  ...over,
});

describe('interleaveByKind', () => {
  it('alternates bays and mobile units so a shortfall does not fall on one kind', () => {
    const ordered = interleaveByKind([bay(1), bay(2), bay(3), unit(1), unit(2)]);

    expect(ordered.map((position) => position.name)).toEqual([
      'Bay 01',
      'MU-01',
      'Bay 02',
      'MU-02',
      'Bay 03',
    ]);
  });

  it('keeps the remaining kind in order once the shorter one runs out', () => {
    const ordered = interleaveByKind([bay(1), bay(2), bay(3), unit(1)]);

    expect(ordered.map((position) => position.name)).toEqual(['Bay 01', 'MU-01', 'Bay 02', 'Bay 03']);
  });

  it('handles a site with only one kind of position', () => {
    expect(interleaveByKind([unit(1), unit(2)]).map((p) => p.name)).toEqual(['MU-01', 'MU-02']);
    expect(interleaveByKind([]).length).toBe(0);
  });
});

describe('planSite', () => {
  it('gives each position its own technician and never books one twice', () => {
    const plan = planSite(
      roster({ freePositions: [bay(1), bay(2), unit(1)], idleTechnicianIds: technicians(3) }),
    );

    expect(plan.jobs).toHaveLength(3);
    expect(new Set(plan.jobs.map((job) => job.technicianId)).size).toBe(3);
    expect(plan.unstaffed).toHaveLength(0);
    expect(plan.spareTechnicians).toBe(0);
  });

  it('leaves the surplus positions unstaffed rather than sharing a technician', () => {
    const plan = planSite(
      roster({ freePositions: [bay(1), bay(2), bay(3), unit(1)], idleTechnicianIds: technicians(2) }),
    );

    expect(plan.jobs.map((job) => job.position.name)).toEqual(['Bay 01', 'MU-01']);
    expect(plan.unstaffed.map((position) => position.name)).toEqual(['Bay 02', 'Bay 03']);
    expect(new Set(plan.jobs.map((job) => job.technicianId)).size).toBe(2);
  });

  it('staffs a mobile unit before the last bays when the site is short', () => {
    const plan = planSite(
      roster({ freePositions: [bay(1), bay(2), bay(3), unit(1)], idleTechnicianIds: technicians(3) }),
    );

    expect(plan.jobs.map((job) => job.position.kind)).toContain('MOBILE_UNIT');
    expect(plan.unstaffed.map((position) => position.name)).toEqual(['Bay 03']);
  });

  it('reports spare technicians when the site has more of them than positions', () => {
    const plan = planSite(roster({ freePositions: [bay(1)], idleTechnicianIds: technicians(4) }));

    expect(plan.jobs).toHaveLength(1);
    expect(plan.spareTechnicians).toBe(3);
    expect(plan.unstaffed).toHaveLength(0);
  });

  it('plans nothing for a site with no idle technician, and says so', () => {
    const plan = planSite(roster({ freePositions: [bay(1), unit(1)], idleTechnicianIds: [] }));

    expect(plan.jobs).toHaveLength(0);
    expect(plan.unstaffed).toHaveLength(2);
  });
});

describe('planFloor', () => {
  /**
   * The backend's alpha fixture packs — bays.csv, mobile-units.csv (ACTIVE only,
   * so MU-CLT-MAIN-03 is excluded) and staffing-assignments.csv, which live in
   * durion-positivity-backend rather than this repository, so these counts are
   * pinned here and cannot be re-derived locally. The three Charlotte service
   * centers are each two technicians short; the hub and Riverside cover exactly.
   */
  const alphaPacks: SiteRoster[] = [
    roster({
      code: 'CLT-MAIN-001',
      freePositions: [...Array.from({ length: 8 }, (_, i) => bay(i + 1)), unit(1), unit(2)],
      idleTechnicianIds: technicians(8),
    }),
    roster({
      code: 'CLT-SOUTH-001',
      freePositions: [...Array.from({ length: 7 }, (_, i) => bay(i + 1)), unit(1), unit(2)],
      idleTechnicianIds: technicians(7),
    }),
    roster({
      code: 'CLT-NORTH-001',
      freePositions: [...Array.from({ length: 6 }, (_, i) => bay(i + 1)), unit(1), unit(2)],
      idleTechnicianIds: technicians(6),
    }),
    roster({
      code: 'CLT-MOB-HUB-001',
      freePositions: [unit(1), unit(2)],
      idleTechnicianIds: technicians(2),
    }),
    roster({
      code: 'ATX-RIV-001',
      freePositions: [bay(1), bay(2), bay(3)],
      idleTechnicianIds: technicians(3),
    }),
  ];

  it('totals the alpha packs at 32 positions, 26 technicians and a 6-position gap', () => {
    const plan = planFloor(alphaPacks);

    expect(plan.totals.freePositions).toBe(32);
    expect(plan.totals.idleTechnicians).toBe(26);
    expect(plan.totals.planned).toBe(26);
    expect(plan.totals.unstaffed).toBe(6);
  });

  it('sums the per-site gaps instead of netting spare technicians against them', () => {
    // 2 spare at the first site cannot staff the second site's 2 empty bays:
    // the floor is short by 2, not level.
    const plan = planFloor([
      roster({ code: 'A', freePositions: [bay(1)], idleTechnicianIds: technicians(3) }),
      roster({ code: 'B', freePositions: [bay(1), bay(2), bay(3)], idleTechnicianIds: technicians(1) }),
    ]);

    expect(plan.totals.freePositions).toBe(4);
    expect(plan.totals.idleTechnicians).toBe(4);
    expect(plan.totals.unstaffed).toBe(2);
    expect(plan.totals.planned).toBe(2);
  });
});

describe('formatCoverageReport', () => {
  it('names every position a shortfall leaves empty', () => {
    const report = formatCoverageReport(
      planFloor([
        roster({ code: 'CLT-MAIN-001', freePositions: [bay(1), bay(2), bay(3)], idleTechnicianIds: technicians(1) }),
      ]),
    ).join('\n');

    expect(report).toContain('SHORT by 2 technician(s)');
    expect(report).toContain('BAY Bay 02');
    expect(report).toContain('BAY Bay 03');
    expect(report).toContain('NOT ENOUGH TECHNICIANS');
  });

  it('says nothing about a shortfall when every position is covered', () => {
    const report = formatCoverageReport(
      planFloor([roster({ freePositions: [bay(1)], idleTechnicianIds: technicians(1) })]),
    ).join('\n');

    expect(report).toContain('covered exactly, with no technician to spare');
    expect(report).not.toContain('NOT ENOUGH TECHNICIANS');
    expect(report).not.toContain('SHORT by');
  });

  it('reports work already on the board so a re-run is not read as a shortfall', () => {
    const report = formatCoverageReport(
      planFloor([
        roster({
          freePositions: [bay(2)],
          occupiedPositions: [bay(1)],
          idleTechnicianIds: technicians(1),
          busyTechnicianIds: ['tech-busy'],
        }),
      ]),
    ).join('\n');

    expect(report).toContain('1 position(s) already working');
    expect(report).toContain('1 technician(s) already on a job');
  });
});
