import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { carriedVisits, continueVisit } from './carryOver';
import { buildDayPlan, describeVisit, type DayPlanOptions, type Visit } from './dayPlan';
import { DayPlanStore } from './DayPlanStore';
import type { Site } from './sites';

const SITE: Site = { id: 'loc-main', code: 'MAIN', name: 'Main Street', slug: 'main', positions: 6 };
const OPTIONS: DayPlanOptions = {
  visitsMin: 20,
  visitsMax: 20,
  tenantMax: 1000,
  newCustomerRatio: 0.3,
  commercialRatio: 0.3,
  newVehicleRatio: 0.2,
  stockPartsRatio: 0.45,
  specialOrderRatio: 0.2,
  openTime: '08:00',
  closeTime: '17:30',
  seed: 0,
};
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const isSpecial = (visit: Visit): boolean => visit.parts === 'special-order' && visit.stages.some((stage) => stage.name === 'order');

/** A state directory in which `date` has been planned, with the given visits having reached a workorder. */
function planned(runsDir: string, date: string, withWorkorder: (visit: Visit) => boolean): DayPlanStore {
  const store = DayPlanStore.create(path.join(runsDir, date), date, [SITE], OPTIONS);
  for (const visit of store.plan.visits.filter(withWorkorder)) {
    Object.assign(store.memoryOf(visit.id), { workorderId: `wo-${visit.id}`, purchaseOrderId: `po-${visit.id}`, customerName: 'Dana Ortiz' });
  }
  store.save();
  return store;
}
const runsDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qa-carry-'));

describe('continueVisit', () => {
  const [visit] = buildDayPlan('2026-03-10', [SITE], OPTIONS).visits.filter(isSpecial);
  const next = continueVisit(visit, '2026-03-10', '2026-03-11', OPTIONS);

  it('is the same customer, vehicle and job, a day later', () => {
    expect(next).toMatchObject({ customer: visit.customer, vehicle: visit.vehicle, concern: visit.concern, site: visit.site, payment: visit.payment });
    expect(next.carriedFrom).toBe('2026-03-10');
    expect(describeVisit(next)).toBe(`Main Street — returning for a job started 2026-03-10: part arriving today, ${visit.payment}`);
  });

  it('receives the part in the morning, then does the work, then the customer returns', () => {
    expect(next.stages.map((stage) => stage.name)).toEqual(['receive', 'work', 'checkout']);
    const [receive, work, checkout] = next.stages.map((stage) => minutes(stage.at));
    expect(receive).toBeGreaterThanOrEqual(8 * 60 + 15);
    expect(receive).toBeLessThanOrEqual(10 * 60);
    expect(receive).toBeLessThan(work);
    expect(work).toBeLessThan(checkout);
    expect(checkout).toBeLessThanOrEqual(17 * 60 + 15);
  });

  it('has an id that names the day the job began, so it cannot collide with a new visit', () => {
    expect(next.id).toBe(`main-d0310${visit.id.slice(visit.id.lastIndexOf('-v'))}`);
    expect(next.stages.every((stage) => stage.id.startsWith(`${next.id}-`))).toBe(true);
    const todays = buildDayPlan('2026-03-11', [SITE], OPTIONS).visits.flatMap((entry) => entry.stages.map((stage) => stage.id));
    expect(next.stages.some((stage) => todays.includes(stage.id))).toBe(false);
  });

  it('is the same every time it is asked for', () => {
    expect(continueVisit(visit, '2026-03-10', '2026-03-11', OPTIONS)).toEqual(next);
  });
});

describe('carriedVisits', () => {
  it('continues the jobs that ordered a part yesterday, with everything they had learned', () => {
    const dir = runsDir();
    const yesterday = planned(dir, '2026-03-10', isSpecial);
    const carried = carriedVisits(dir, '2026-03-11', OPTIONS);
    const expected = yesterday.plan.visits.filter(isSpecial);

    expect(expected.length).toBeGreaterThan(0);
    expect(carried).toHaveLength(expected.length);
    for (const [index, entry] of carried.entries()) {
      expect(entry.visit.carriedFrom).toBe('2026-03-10');
      expect(entry.memory).toEqual({ workorderId: `wo-${expected[index].id}`, purchaseOrderId: `po-${expected[index].id}`, customerName: 'Dana Ortiz' });
    }
  });

  it('does not continue a job that never became a workorder, or one that needed no order', () => {
    const dir = runsDir();
    planned(dir, '2026-03-10', (visit) => !isSpecial(visit)); // every other visit has a workorder; the special-order ones do not
    expect(carriedVisits(dir, '2026-03-11', OPTIONS)).toEqual([]);
  });

  it('skips days the shop was closed: a Saturday job continues on Monday', () => {
    const dir = runsDir();
    const saturday = planned(dir, '2026-03-14', isSpecial);
    const carried = carriedVisits(dir, '2026-03-16', OPTIONS);
    expect(carried).toHaveLength(saturday.plan.visits.filter(isSpecial).length);
    expect(carried.every((entry) => entry.visit.carriedFrom === '2026-03-14')).toBe(true);
  });

  it('continues a job once: the day after next does not pick it up again', () => {
    const dir = runsDir();
    planned(dir, '2026-03-10', isSpecial);
    const tuesdaysJobs = carriedVisits(dir, '2026-03-11', OPTIONS);
    DayPlanStore.create(path.join(dir, '2026-03-11'), '2026-03-11', [SITE], { ...OPTIONS, specialOrderRatio: 0 }, tuesdaysJobs);
    expect(tuesdaysJobs.length).toBeGreaterThan(0);
    expect(carriedVisits(dir, '2026-03-12', OPTIONS)).toEqual([]);
  });

  it('gives up on a delivery more than a week late', () => {
    const dir = runsDir();
    planned(dir, '2026-03-02', isSpecial);
    expect(carriedVisits(dir, '2026-03-09', OPTIONS).length).toBeGreaterThan(0);
    expect(carriedVisits(dir, '2026-03-10', OPTIONS)).toEqual([]);
  });

  it('has nothing to carry on the first day ever', () => {
    expect(carriedVisits(path.join(runsDir(), 'runs'), '2026-03-10', OPTIONS)).toEqual([]);
  });
});

describe('DayPlanStore.create with carried jobs', () => {
  it('adds them to the day beside its own visits and hands over their memory', () => {
    const dir = runsDir();
    planned(dir, '2026-03-10', isSpecial);
    const carried = carriedVisits(dir, '2026-03-11', OPTIONS);
    const today = DayPlanStore.create(path.join(dir, '2026-03-11'), '2026-03-11', [SITE], OPTIONS, carried);

    const own = today.plan.visits.filter((visit) => !visit.carriedFrom);
    expect(own).toHaveLength(20); // the day's own roster is not reduced to make room
    expect(today.plan.visits).toHaveLength(20 + carried.length);
    const [first] = carried;
    expect(today.find(`${first.visit.id}-receive`)?.visit.carriedFrom).toBe('2026-03-10');
    expect(today.memoryOf(first.visit.id)).toEqual(first.memory);
    // Reloading from disk gives the same thing back.
    expect(DayPlanStore.load(path.join(dir, '2026-03-11'), '2026-03-11')?.memoryOf(first.visit.id)).toEqual(first.memory);
  });
});
