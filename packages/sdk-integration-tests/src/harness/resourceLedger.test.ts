import type { ShopPosition, SiteRoster } from '../runs/shopFloorPlan';
import { ResourceLedger } from './resourceLedger';

const bay = (n: number): ShopPosition => ({ kind: 'BAY', id: `bay-${n}`, name: `Bay 0${n}` });
const unit = (n: number): ShopPosition => ({ kind: 'MOBILE_UNIT', id: `mu-${n}`, name: `MU-0${n}` });

const roster = (overrides: Partial<SiteRoster> = {}): SiteRoster => ({
  locationId: 'site-1',
  code: 'CLT-MAIN-001',
  name: 'Charlotte Main',
  freePositions: [bay(1), bay(2), unit(1)],
  occupiedPositions: [],
  idleTechnicianIds: ['tech-a', 'tech-b', 'tech-c'],
  busyTechnicianIds: [],
  ...overrides,
});

const t0 = new Date('2025-11-03T08:00:00Z');
const t1 = new Date('2025-11-03T12:00:00Z');
const t2 = new Date('2025-11-03T16:00:00Z');

describe('ResourceLedger — claiming', () => {
  it('hands out a position and a technician together', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());

    const claim = ledger.claim('site-1', t0);

    expect(claim).not.toBeNull();
    expect(claim?.position.id).toBe('bay-1');
    expect(claim?.technicianId).toBe('tech-a');
    expect(ledger.capacity('site-1')).toEqual({ free: 2, held: 1, technicians: 3, freeTechnicians: 2 });
  });

  it('interleaves bays and mobile units so a shortfall is shared between the kinds', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1), bay(2), bay(3), unit(1)] }));

    const kinds = [
      ledger.claim('site-1', t0)?.position.id,
      ledger.claim('site-1', t0)?.position.id,
      ledger.claim('site-1', t0)?.position.id,
    ];

    expect(kinds).toEqual(['bay-1', 'mu-1', 'bay-2']);
  });

  it('honours a requested kind', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());

    expect(ledger.claim('site-1', t0, 'MOBILE_UNIT')?.position.id).toBe('mu-1');
    expect(ledger.claim('site-1', t0, 'MOBILE_UNIT')).toBeNull();
  });

  it('returns null when the site is out of positions, rather than asking the backend', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1)] }));

    expect(ledger.claim('site-1', t0)).not.toBeNull();
    expect(ledger.claim('site-1', t0)).toBeNull();
  });

  it('returns null when the site is out of technicians', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ idleTechnicianIds: ['tech-a'] }));

    expect(ledger.claim('site-1', t0)).not.toBeNull();
    expect(ledger.claim('site-1', t0)).toBeNull();
  });

  it('refuses a second claim on a named position — the double-booking this exists to prevent', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    ledger.claimSpecific('site-1', bay(1), 'tech-a', t0);

    expect(() => ledger.claimSpecific('site-1', bay(1), 'tech-b', t0)).toThrow(/Bay 01.*already held.*double-book/);
  });

  it('refuses a second claim on a named technician', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    ledger.claimSpecific('site-1', bay(1), 'tech-a', t0);

    expect(() => ledger.claimSpecific('site-1', bay(2), 'tech-a', t0)).toThrow(/technician tech-a.*already held/);
  });

  it('refuses a claim against a site nobody reconciled', () => {
    expect(() => new ResourceLedger().claimSpecific('site-9', bay(1), 'tech-a', t0)).toThrow(/has not been reconciled/);
    expect(new ResourceLedger().claim('site-9', t0)).toBeNull();
  });
});

describe('ResourceLedger — reconciliation from the board', () => {
  it('starts the day holding whatever the board reports as occupied', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(
      roster({
        freePositions: [bay(2)],
        occupiedPositions: [bay(1)],
        idleTechnicianIds: ['tech-b'],
        busyTechnicianIds: ['tech-a'],
      }),
    );

    expect(ledger.capacity('site-1')).toEqual({ free: 1, held: 1, technicians: 2, freeTechnicians: 1 });
    expect(() => ledger.claimSpecific('site-1', bay(1), 'tech-b', t0)).toThrow(/already held/);
  });

  it('keeps its own carried claims across a reconciliation that does not mention them', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    const claim = ledger.claim('site-1', t0);
    ledger.carry(claim!);

    // A board read taken mid-flight may not show a claim taken seconds ago.
    ledger.reconcile(roster({ freePositions: [bay(1), bay(2), unit(1)], idleTechnicianIds: ['tech-a', 'tech-b', 'tech-c'] }));

    expect(() => ledger.claimSpecific('site-1', bay(1), 'tech-b', t1)).toThrow(/already held/);
    expect(ledger.carriedClaims()).toHaveLength(1);
  });

  it('does not lose a held position the board has stopped listing', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    const claim = ledger.claim('site-1', t0);

    ledger.reconcile(roster({ freePositions: [bay(2)], occupiedPositions: [] }));

    expect(ledger.openClaims()).toHaveLength(1);
    expect(ledger.release(claim!, t1)).toBe(true);
  });
});

describe('ResourceLedger — releasing and carrying', () => {
  it('frees both sides on release', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const claim = ledger.claim('site-1', t0);

    expect(ledger.release(claim!, t1)).toBe(true);
    expect(ledger.claim('site-1', t1)).not.toBeNull();
  });

  it('is idempotent: a second release frees nothing and does not throw', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    const claim = ledger.claim('site-1', t0);

    expect(ledger.release(claim!, t1)).toBe(true);
    expect(ledger.release(claim!, t2)).toBe(false);
  });

  it('records the workorder the hold was working', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    const claim = ledger.claim('site-1', t0)!;
    ledger.attach(claim, 'wo-1');
    ledger.release(claim, t1);

    expect(ledger.closedHolds()[0]).toMatchObject({ workorderId: 'wo-1', positionId: 'bay-1', technicianId: 'tech-a' });
  });

  it('refuses to attach a workorder to a claim nobody holds', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    const claim = ledger.claim('site-1', t0)!;
    ledger.release(claim, t1);

    expect(() => ledger.attach(claim, 'wo-1')).toThrow(/is not held/);
  });

  it('keeps a carried claim held across the day boundary', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const claim = ledger.claim('site-1', t0)!;

    ledger.carry(claim);

    expect(ledger.openClaims()).toHaveLength(0);
    expect(ledger.carriedClaims()).toHaveLength(1);
    expect(ledger.activeClaims()).toHaveLength(1);
    expect(ledger.claim('site-1', t1)).toBeNull();
  });

  it('refuses to carry a claim that is not open', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster());
    const claim = ledger.claim('site-1', t0)!;
    ledger.release(claim, t1);

    expect(() => ledger.carry(claim)).toThrow(/cannot be carried/);
  });
});

describe('ResourceLedger — overlap audit', () => {
  it('finds nothing when holds are sequential on the same bay', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));

    const first = ledger.claim('site-1', t0)!;
    ledger.release(first, t1);
    const second = ledger.claim('site-1', t1)!;
    ledger.release(second, t2);

    expect(ledger.overlaps()).toEqual([]);
  });

  it('reports a hold that is still open alongside a closed one on the same resource', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));

    // Forced through reconciliation rather than through claim(), which would have
    // refused: the audit has to catch a double-book however it arose, including
    // one the backend allowed behind the ledger's back.
    const first = ledger.claim('site-1', t0)!;
    ledger.attach(first, 'wo-1');
    ledger.release(first, t2);
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const overlapping = ledger.claim('site-1', t1)!;
    ledger.attach(overlapping, 'wo-2');

    const violations = ledger.overlaps();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.resourceKind === 'POSITION' && v.resourceId === 'bay-1')).toBe(true);
    expect(violations.some((v) => v.resourceKind === 'TECHNICIAN' && v.resourceId === 'tech-a')).toBe(true);
    expect(violations[0].first.workorderId).toBe('wo-1');
    expect(violations[0].second.workorderId).toBe('wo-2');
  });

  it('finds a hold nested inside a longer one, not just the neighbouring pair', () => {
    // The case a previous-only comparison missed: sorted by start, [0,100] then
    // [1,2] then [50,60]. Comparing each interval with its predecessor reports
    // [1,2] and then clears [50,60], because 50 is past 2 — even though [50,60]
    // sits squarely inside [0,100]. Under-reporting is the dangerous direction for
    // a compliance check, so this is the regression guard.
    const ledger = new ResourceLedger();
    const long = new Date('2025-11-03T08:00:00Z');
    const longEnd = new Date('2025-11-03T18:00:00Z');
    const shortStart = new Date('2025-11-03T08:05:00Z');
    const shortEnd = new Date('2025-11-03T08:10:00Z');
    const lateStart = new Date('2025-11-03T13:00:00Z');
    const lateEnd = new Date('2025-11-03T14:00:00Z');

    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const first = ledger.claim('site-1', long)!;
    ledger.attach(first, 'wo-long');
    ledger.release(first, longEnd);

    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const nested = ledger.claim('site-1', shortStart)!;
    ledger.attach(nested, 'wo-nested');
    ledger.release(nested, shortEnd);

    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const late = ledger.claim('site-1', lateStart)!;
    ledger.attach(late, 'wo-late');
    ledger.release(late, lateEnd);

    const violations = ledger.overlaps();
    const reported = violations.map((v) => v.second.workorderId);
    expect(reported).toContain('wo-nested');
    // The one a previous-only sweep loses.
    expect(reported).toContain('wo-late');
  });

  it('reports a hold that is still open against an earlier long one', () => {
    // The last hold is left open (no release), so its interval has no end. It must
    // still be compared against the long hold it starts inside.
    const ledger = new ResourceLedger();
    const openAt = new Date('2025-11-03T08:00:00Z');
    const closeAt = new Date('2025-11-03T18:00:00Z');

    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const long = ledger.claim('site-1', openAt)!;
    ledger.attach(long, 'wo-long');
    ledger.release(long, closeAt);

    // Claimed at an instant inside the hold just closed: the ledger sequenced these,
    // but their recorded intervals overlap, which is what the audit has to catch.
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));
    const stillRunning = ledger.claim('site-1', new Date('2025-11-03T12:00:00Z'))!;
    ledger.attach(stillRunning, 'wo-open');

    const reported = ledger.overlaps().map((v) => v.second.workorderId);
    expect(reported).toContain('wo-open');
  });

  it('treats a bay turned around at the same instant as sequential, not overlapping', () => {
    const ledger = new ResourceLedger();
    ledger.reconcile(roster({ freePositions: [bay(1)], idleTechnicianIds: ['tech-a'] }));

    const first = ledger.claim('site-1', t0)!;
    ledger.release(first, t1);
    const second = ledger.claim('site-1', t1)!;
    ledger.release(second, t2);

    expect(ledger.overlaps()).toEqual([]);
  });
});
