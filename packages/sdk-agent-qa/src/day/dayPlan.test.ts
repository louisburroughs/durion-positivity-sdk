import { buildDayPlan, describeVisit, type DayPlanOptions, type Visit } from './dayPlan';

const OPTIONS: DayPlanOptions = {
  visitsMin: 10,
  visitsMax: 10,
  newCustomerRatio: 0.3,
  commercialRatio: 0.3,
  newVehicleRatio: 0.2,
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
        visit.disposition === 'declines' ? ['intake'] : ['intake', 'work', 'checkout'],
      );
    }
  });

  it('bills only commercial accounts on account, and only returning customers arrive on an appointment', () => {
    const visits = WEEKDAYS.flatMap((date) => buildDayPlan(date, { ...OPTIONS, visitsMin: 30, visitsMax: 30 }).visits);
    expect(visits.some((visit) => visit.payment === 'on-account')).toBe(true);
    expect(visits.some((visit) => visit.arrival === 'appointment')).toBe(true);
    expect(visits.filter((visit) => visit.payment === 'on-account').every((visit) => visit.customer.type === 'commercial')).toBe(true);
    expect(visits.filter((visit) => visit.arrival === 'appointment').every((visit) => visit.customer.status === 'existing')).toBe(true);
  });

  it('spreads the day over several sites', () => {
    const sites = buildDayPlan('2026-03-10', OPTIONS).visits.map((visit) => visit.site);
    expect(new Set(sites).size).toBeGreaterThan(3);
    expect(sites.every((site) => Number.isInteger(site) && site >= 1)).toBe(true);
  });

  it('is quieter on a Saturday, and empty when visits are turned off', () => {
    expect(buildDayPlan('2026-03-14', OPTIONS).visits).toHaveLength(6);
    expect(buildDayPlan('2026-03-10', { ...OPTIONS, visitsMin: 0, visitsMax: 0 }).visits).toEqual([]);
  });

  it('describes a visit in one line', () => {
    const [visit] = buildDayPlan('2026-03-10', OPTIONS).visits;
    expect(describeVisit(visit)).toMatch(/^(service|counter-sale|appointment-call): (new|existing) /);
  });
});
