import { buildDayPlan as buildTenantDay, describeVisit, visitCounts, type DayPlan, type DayPlanOptions, type Visit } from './dayPlan';
import type { Site } from './sites';

const MAIN: Site = { id: 'loc-main', code: 'MAIN', name: 'Main Street', slug: 'main', positions: 6 };
const NORTH: Site = { id: 'loc-north', code: 'NORTH', name: 'Northside', slug: 'north', positions: 3 };
const DEPOT: Site = { id: 'loc-depot', code: 'DEPOT', name: 'Fleet Depot', slug: 'depot', positions: 10 };

/** One site's day: most of what follows is about a single shop's roster. */
const buildDayPlan = (date: string, options: DayPlanOptions): DayPlan => buildTenantDay(date, [MAIN], options);

const OPTIONS: DayPlanOptions = {
  visitsMin: 10,
  visitsMax: 10,
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

/** Tuesdays to Fridays of two weeks in March 2026. */
const WEEKDAYS = ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20'];
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const count = (visits: Visit[], test: (visit: Visit) => boolean): number => visits.filter(test).length;

describe('buildDayPlan', () => {
  it('is the same plan every time it is asked for the same day, and a different one the next day', () => {
    expect(buildDayPlan('2026-03-10', OPTIONS)).toEqual(buildDayPlan('2026-03-10', OPTIONS));
    expect(buildDayPlan('2026-03-11', OPTIONS)).not.toEqual(buildDayPlan('2026-03-10', OPTIONS));
    expect(buildDayPlan('2026-03-10', { ...OPTIONS, seed: 7 })).not.toEqual(buildDayPlan('2026-03-10', OPTIONS));
  });

  it('gives every day exactly the configured mix of new and returning, commercial and individual', () => {
    for (const date of WEEKDAYS) {
      const { visits } = buildDayPlan(date, OPTIONS);
      expect(visits).toHaveLength(10);
      expect([date, count(visits, (visit) => visit.customer.status === 'new')]).toEqual([date, 3]);
      expect([date, count(visits, (visit) => visit.customer.type === 'commercial')]).toEqual([date, 3]);
    }
  });

  it('varies which visits are the new and the commercial ones, so all four combinations turn up', () => {
    const seen = new Set<string>();
    for (const date of WEEKDAYS) {
      for (const visit of buildDayPlan(date, OPTIONS).visits) {
        seen.add(`${visit.customer.status} ${visit.customer.type}`);
      }
    }
    expect([...seen].sort()).toEqual(['existing commercial', 'existing individual', 'new commercial', 'new individual']);
  });

  it('keeps at least one of each kind in the mix even on a small day', () => {
    const { visits } = buildDayPlan('2026-03-10', { ...OPTIONS, visitsMin: 3, visitsMax: 3, newCustomerRatio: 0.1, commercialRatio: 0.1 });
    expect(count(visits, (visit) => visit.customer.status === 'new')).toBe(1);
    expect(count(visits, (visit) => visit.customer.type === 'commercial')).toBe(1);
  });

  it('gives a new customer an identity and a new vehicle, and a returning one a place to start looking', () => {
    for (const date of WEEKDAYS) {
      for (const visit of buildDayPlan(date, OPTIONS).visits) {
        const { customer, vehicle } = visit;
        if (customer.status === 'existing') {
          expect(customer.search).toEqual({ fragment: expect.stringMatching(/^[a-z]$/), ordinal: expect.any(Number) });
          expect(customer.person ?? customer.company).toBeUndefined();
        } else if (customer.type === 'individual') {
          expect(customer.person).toEqual({
            firstName: expect.any(String),
            lastName: expect.any(String),
            email: expect.stringMatching(/^[a-z0-9.]+@agentqa\.invalid$/),
            phone: expect.any(String),
          });
        } else {
          expect(customer.company?.legalName).toMatch(/ (LLC|Inc\.|Co\.)$/);
        }
        if (customer.status === 'new' && visit.kind !== 'counter-sale') {
          expect(vehicle.status).toBe('new');
          expect(vehicle.details?.vin).toHaveLength(17);
        }
      }
    }
  });

  it('makes new-customer emails unique within a day', () => {
    const emails = buildDayPlan('2026-03-10', { ...OPTIONS, visitsMin: 40, visitsMax: 40, newCustomerRatio: 1 }).visits.map(
      (visit) => visit.customer.person?.email ?? visit.customer.company?.email,
    );
    expect(new Set(emails).size).toBe(40);
  });

  it('is mostly service work, with counter sales and phone bookings through the day', () => {
    const { visits } = buildDayPlan('2026-03-10', OPTIONS);
    expect(count(visits, (visit) => visit.kind === 'counter-sale')).toBe(2);
    expect(count(visits, (visit) => visit.kind === 'appointment-call')).toBe(2);
    expect(count(visits, (visit) => visit.kind === 'service')).toBe(6);
  });

  it('lays each visit out in order, inside opening hours', () => {
    for (const date of WEEKDAYS) {
      const { visits } = buildDayPlan(date, OPTIONS);
      const starts = visits.map((visit) => minutes(visit.stages[0].at));
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      for (const visit of visits) {
        const times = visit.stages.map((stage) => minutes(stage.at));
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(times[0]).toBeGreaterThanOrEqual(8 * 60);
        expect(times[times.length - 1]).toBeLessThanOrEqual(17 * 60 + 30);
        expect(visit.stages.map((stage) => stage.id)).toEqual(visit.stages.map((stage) => `${visit.id}-${stage.name}`));
      }
    }
  });

  it('ends a visit at the counter when the customer declines, and runs it through to checkout otherwise', () => {
    const visits = WEEKDAYS.flatMap((date) => buildDayPlan(date, { ...OPTIONS, visitsMin: 30, visitsMax: 30 }).visits).filter(
      (visit) => visit.kind === 'service',
    );
    const declined = visits.filter((visit) => visit.disposition === 'declines');
    expect(declined.length).toBeGreaterThan(0);
    expect(visits.some((visit) => visit.disposition === 'approves-then-adds-work')).toBe(true);
    for (const visit of visits) {
      expect(visit.stages.map((stage) => stage.name)).toEqual(
        visit.disposition === 'declines'
          ? ['intake']
          : visit.parts === 'special-order'
            ? ['intake', 'order'] // the rest happens the next day, when the part arrives
            : ['intake', 'work', 'checkout'],
      );
    }
  });

  it('gives every site jobs that use stock parts, jobs that need a part ordered in, and labor-only jobs', () => {
    for (const date of WEEKDAYS) {
      const services = buildDayPlan(date, { ...OPTIONS, visitsMin: 20, visitsMax: 20 }).visits.filter((visit) => visit.kind === 'service');
      const by = (need: string): number => services.filter((visit) => visit.parts === need).length;
      expect(services).toHaveLength(13);
      expect([date, by('special-order')]).toEqual([date, 3]); // 20% of 13, allocated
      expect(by('stock')).toBeGreaterThanOrEqual(3);
      expect(by('none')).toBeGreaterThanOrEqual(1);
    }
    const others = buildDayPlan('2026-03-10', OPTIONS).visits.filter((visit) => visit.kind !== 'service');
    expect(others.every((visit) => visit.parts === 'none')).toBe(true);
  });

  it('ends the first day of a special-order job once the part is ordered', () => {
    const special = WEEKDAYS.flatMap((date) => buildDayPlan(date, { ...OPTIONS, visitsMin: 30, visitsMax: 30 }).visits).filter(
      (visit) => visit.parts === 'special-order' && visit.disposition !== 'declines',
    );
    expect(special.length).toBeGreaterThan(10);
    for (const visit of special) {
      const [intake, order] = visit.stages.map((stage) => minutes(stage.at));
      expect(visit.stages.map((stage) => stage.name)).toEqual(['intake', 'order']);
      expect(intake).toBeLessThanOrEqual(order);
      expect(order).toBeLessThanOrEqual(17 * 60);
      expect(visit.carriedFrom).toBeUndefined();
    }
  });

  it('can turn parts off', () => {
    const { visits } = buildDayPlan('2026-03-10', { ...OPTIONS, stockPartsRatio: 0, specialOrderRatio: 0 });
    expect(visits.every((visit) => visit.parts === 'none')).toBe(true);
  });

  it('bills only commercial accounts on account, and only returning customers arrive on an appointment', () => {
    const visits = WEEKDAYS.flatMap((date) => buildDayPlan(date, { ...OPTIONS, visitsMin: 30, visitsMax: 30 }).visits);
    expect(visits.some((visit) => visit.payment === 'on-account')).toBe(true);
    expect(visits.some((visit) => visit.arrival === 'appointment')).toBe(true);
    expect(visits.filter((visit) => visit.payment === 'on-account').every((visit) => visit.customer.type === 'commercial')).toBe(true);
    expect(visits.filter((visit) => visit.arrival === 'appointment').every((visit) => visit.customer.status === 'existing')).toBe(true);
  });

  it('is quieter on a Saturday, and empty when visits are turned off', () => {
    expect(buildDayPlan('2026-03-14', OPTIONS).visits).toHaveLength(6);
    expect(buildDayPlan('2026-03-10', { ...OPTIONS, visitsMin: 0, visitsMax: 0 }).visits).toEqual([]);
  });

  it('describes a visit in one line', () => {
    const [visit] = buildDayPlan('2026-03-10', OPTIONS).visits;
    expect(describeVisit(visit)).toMatch(/^Main Street — (service|counter-sale|appointment-call): (new|existing) /);
  });
});

describe('a tenant with several sites', () => {
  const SITES = [DEPOT, MAIN, NORTH];
  const RANGE: DayPlanOptions = { ...OPTIONS, visitsMin: 4, visitsMax: 8 };

  it('gives every site its own day', () => {
    const plan = buildTenantDay('2026-03-10', SITES, RANGE);
    expect(plan.sites).toEqual(SITES);
    for (const site of SITES) {
      const here = plan.visits.filter((visit) => visit.site.id === site.id);
      expect(here.length).toBeGreaterThanOrEqual(4);
      expect(here.every((visit) => visit.id.startsWith(`${site.slug}-v`) && visit.site.name === site.name)).toBe(true);
      expect(here.some((visit) => visit.kind === 'service')).toBe(true);
    }
    expect(new Set(plan.visits.flatMap((visit) => visit.stages.map((stage) => stage.id))).size).toBe(
      plan.visits.reduce((sum, visit) => sum + visit.stages.length, 0),
    );
  });

  it('holds the mix at every site, not just across the tenant', () => {
    const plan = buildTenantDay('2026-03-10', SITES, { ...RANGE, visitsMin: 10, visitsMax: 10 });
    for (const site of SITES) {
      const here = plan.visits.filter((visit) => visit.site.id === site.id);
      expect([site.slug, here.filter((visit) => visit.customer.status === 'new').length]).toEqual([site.slug, 3]);
      expect([site.slug, here.filter((visit) => visit.customer.type === 'commercial').length]).toEqual([site.slug, 3]);
    }
  });

  it('gives the sites different customers from one another', () => {
    const plan = buildTenantDay('2026-03-10', SITES, { ...RANGE, visitsMin: 10, visitsMax: 10, newCustomerRatio: 1 });
    const emails = plan.visits.map((visit) => visit.customer.person?.email ?? visit.customer.company?.email);
    expect(new Set(emails).size).toBe(30);
  });

  it('gives a bigger site a busier day', () => {
    for (const date of WEEKDAYS) {
      const [depot, main, north] = visitCounts(date, SITES, RANGE);
      expect(depot).toBeGreaterThanOrEqual(7);
      expect(north).toBeLessThanOrEqual(5);
      expect(depot).toBeGreaterThan(north);
      expect(main).toBeGreaterThanOrEqual(4);
      expect(main).toBeLessThanOrEqual(8);
    }
  });

  it('trims the busiest sites first to stay under the tenant ceiling, and empties none', () => {
    const counts = visitCounts('2026-03-10', SITES, { ...RANGE, tenantMax: 9 });
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(9);
    expect(counts.every((count) => count >= 2)).toBe(true);
  });

  it('plans nothing for a tenant with no sites', () => {
    expect(buildTenantDay('2026-03-10', [], RANGE)).toMatchObject({ sites: [], visits: [] });
  });
});
