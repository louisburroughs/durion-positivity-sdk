/**
 * Generates one day of customers for the whole tenant.
 *
 * A tenant's day is a day at each of its shops. Every site gets its own roster
 * of **visits**: who comes in, what they drive, what they want, what they
 * decide and how they pay. A bigger site (more bays and mobile units) gets a
 * busier day. The roster fixes the facts that make a day realistic and that an
 * agent left to itself would flatten — the arrival curve, and the mix of new
 * and returning customers, of individuals and commercial accounts, of vehicles
 * already on file and vehicles never seen before. Everything else is left to
 * the agent: finding the returning customer in the CRM, choosing services that
 * fit the complaint, working around a full shop, dealing with whatever state
 * alpha is in.
 *
 * The mix is allocated, not sampled, and per site. With ten visits at a site
 * and a 30% commercial share there are exactly three commercial visits there,
 * every day, rather than "about three, sometimes none" — the point of the mix
 * is that it is there, at every shop.
 *
 * The roster is a pure function of the date and the seed, so every process
 * that asks for today's plan gets the same one.
 */
import { SeederRandom } from '@durion-sdk/seeder';
import type { Site } from './sites';

export type CustomerType = 'individual' | 'commercial';
export type VisitKind = 'service' | 'counter-sale' | 'appointment-call';
export type StageName = 'intake' | 'work' | 'checkout' | 'sale' | 'call';

/** What the customer says when the advisor presents the estimate. */
export type Disposition =
  /** Approves the estimate as written. */
  | 'approves'
  /** Declines; the visit ends at the counter. */
  | 'declines'
  /** Approves, and more work is found once the vehicle is on the lift. */
  | 'approves-then-adds-work';

export type Payment = 'cash' | 'on-account';

export interface NewVehicle {
  year: number;
  make: string;
  model: string;
  vin: string;
  licensePlate: string;
}

export interface VisitCustomer {
  type: CustomerType;
  /** `existing` customers are found in the CRM; `new` ones are created from `identity`. */
  status: 'existing' | 'new';
  /** A new individual. */
  person?: { firstName: string; lastName: string; email: string; phone: string };
  /** A new commercial account, with the employee who brings the vehicle in. */
  company?: { legalName: string; contactFirstName: string; contactLastName: string; email: string; phone: string };
  /** For an existing customer: where to start looking, so different customers are picked on different days. */
  search?: { fragment: string; ordinal: number };
}

export interface VisitVehicle {
  status: 'existing' | 'new';
  details?: NewVehicle;
}

export interface VisitStage {
  /** `main-v03-intake` */
  id: string;
  name: StageName;
  /** Shop-local HH:MM. */
  at: string;
}

export interface Visit {
  /** `<site slug>-v03` */
  id: string;
  kind: VisitKind;
  customer: VisitCustomer;
  vehicle: VisitVehicle;
  /** What the customer asks for, in their words. */
  concern: string;
  /** Service visits with an existing customer may arrive on a booked appointment. */
  arrival: 'walk-in' | 'appointment';
  disposition: Disposition;
  payment: Payment;
  /** The shop the customer comes to. */
  site: Pick<Site, 'id' | 'name' | 'code' | 'slug'>;
  stages: VisitStage[];
}

export interface DayPlan {
  date: string;
  seed: number;
  /** Every shop taking part in the day, including any whose roster is empty. */
  sites: Site[];
  visits: Visit[];
}

export interface DayPlanOptions {
  /**
   * Visits **per site** on a full weekday: the smallest site gets about
   * `visitsMin`, the largest about `visitsMax`. Saturdays get about 60%.
   */
  visitsMin: number;
  visitsMax: number;
  /** Ceiling on the whole tenant's visits in a day, to bound cost. Sites are trimmed evenly. */
  tenantMax: number;
  /** Share of visits by a customer the shop has never seen. */
  newCustomerRatio: number;
  /** Share of visits by a commercial account. */
  commercialRatio: number;
  /** Share of returning customers who bring a vehicle that is not on file yet. */
  newVehicleRatio: number;
  /** Shop-local HH:MM. */
  openTime: string;
  closeTime: string;
  /** Mixed into the date so two environments can run different days. */
  seed: number;
}

const SERVICE_CONCERNS = [
  'Oil change and tire rotation; the maintenance light came on last week.',
  'Brakes squeal when stopping and the pedal feels soft. Wants them inspected and fixed.',
  'Needs four new tires before winter; the current set is worn to the bars.',
  'Slow leak in the right rear tire. Wants it repaired or replaced.',
  'Steering wheel shakes above 60 mph. Suspects wheel balance or alignment.',
  'Check engine light is on and the engine idles rough.',
  'Battery struggles on cold mornings. Wants the battery and charging system tested.',
  'State inspection is due this month.',
  'Air conditioning blows warm. Wants it diagnosed.',
  'Car pulls to the left after hitting a pothole. Wants an alignment check.',
  'Scheduled 60,000-mile service.',
  'Wiper blades streak and a headlight is out.',
  'Grinding noise from the front end on turns.',
  'Coolant smell and the temperature gauge runs high in traffic.',
];

const FLEET_CONCERNS = [
  'Fleet van is due for its scheduled preventive maintenance.',
  'Delivery truck needs two drive tires replaced and an alignment check.',
  'Company pickup failed its DOT pre-trip check: brake lights and a worn front tire.',
  'Service vehicle needs an oil change and a brake inspection before a long route tomorrow.',
  'Driver reports a vibration under load; wants the tires and suspension checked.',
  'Box truck has a nail in an inside dual. Needs it repaired today if possible.',
];

const COUNTER_CONCERNS = [
  'Wants to buy a set of wiper blades over the counter.',
  'Needs a quart of oil and an oil filter; does their own changes.',
  'Wants to buy a replacement battery and take it with them.',
  'Asks for a tire pressure gauge and a set of valve caps.',
  'Needs a pair of replacement headlight bulbs.',
  'Buying a single tire to carry as a spare.',
];

const CALL_CONCERNS = [
  'Calls to book an oil change for later this week.',
  'Calls to book a brake inspection; can only come in the morning.',
  'Wants an appointment for new tires, the earliest slot available.',
  'Calls to schedule the annual state inspection.',
  'Fleet coordinator calls to book preventive maintenance for one of their vans.',
];

const COMPANY_SUFFIXES = [
  'Plumbing',
  'Landscaping',
  'Electric',
  'Courier Service',
  'Construction',
  'Heating & Air',
  'Catering',
  'Logistics',
  'Roofing',
  'Property Management',
  'Pest Control',
  'Florist Delivery',
];

/** Share of the day's arrivals in each hour after opening: a morning rush, a lunch lull, a smaller afternoon wave. */
const ARRIVAL_WEIGHTS = [25, 20, 15, 10, 5, 10, 10, 5];

const toMinutes = (hhmm: string): number => {
  const [hours, minutes] = hhmm.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
};

const toClock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** FNV-1a over the date and the configured seed. */
export function daySeed(date: string, seed: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${date}|${seed}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** `count` slots of which `share` are true (at least one when there is room for a mix), in random order. */
function allocate(random: SeederRandom, count: number, share: number): boolean[] {
  let marked = Math.round(count * share);
  if (share > 0 && marked === 0 && count >= 3) {
    marked = 1;
  }
  if (share < 1 && marked === count && count >= 3) {
    marked = count - 1;
  }
  const flags = Array.from({ length: count }, (_, index) => index < marked);
  return random.pickN(flags, count);
}

function arrivalMinutes(random: SeederRandom, open: number, close: number): number {
  const total = ARRIVAL_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  let roll = random.int(1, total);
  let hour = 0;
  for (; hour < ARRIVAL_WEIGHTS.length - 1; hour += 1) {
    roll -= ARRIVAL_WEIGHTS[hour];
    if (roll <= 0) {
      break;
    }
  }
  // The last arrival still leaves time to be seen before closing.
  return Math.min(open + hour * 60 + random.int(0, 59), close - 90);
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** ISO weekday (1 = Monday) of a YYYY-MM-DD date. */
const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

/** How many customers each site sees: scaled by its size, trimmed evenly to the tenant ceiling. */
export function visitCounts(date: string, sites: readonly Site[], options: DayPlanOptions): number[] {
  if (options.visitsMax === 0 || sites.length === 0) {
    return sites.map(() => 0);
  }
  const saturday = weekdayOf(date) === 6;
  const largest = Math.max(...sites.map((site) => site.positions), 1);
  const smallest = Math.min(...sites.map((site) => site.positions));
  const counts = sites.map((site) => {
    const random = new SeederRandom(daySeed(`${date}|count|${site.id}`, options.seed));
    const span = Math.max(0, options.visitsMax - options.visitsMin);
    const size = largest === smallest ? 0.5 : (site.positions - smallest) / (largest - smallest);
    const base = options.visitsMin + Math.round(span * size) + (span >= 2 ? random.int(-1, 1) : 0);
    const bounded = Math.min(options.visitsMax, Math.max(options.visitsMin, base));
    return saturday ? Math.round(bounded * 0.6) : bounded;
  });
  // Over the ceiling: take one from the busiest site at a time, so no site is emptied to keep another full.
  for (let total = counts.reduce((sum, count) => sum + count, 0); total > options.tenantMax; total -= 1) {
    counts[counts.indexOf(Math.max(...counts))] -= 1;
  }
  return counts;
}

export function buildDayPlan(date: string, sites: readonly Site[], options: DayPlanOptions): DayPlan {
  const counts = visitCounts(date, sites, options);
  return {
    date,
    seed: daySeed(date, options.seed),
    sites: [...sites],
    visits: sites.flatMap((site, index) => buildSiteVisits(date, site, counts[index], options)),
  };
}

/** One site's customers for the day. */
function buildSiteVisits(date: string, site: Site, count: number, options: DayPlanOptions): Visit[] {
  if (count <= 0) {
    return [];
  }
  const random = new SeederRandom(daySeed(`${date}|${site.id}`, options.seed));
  const open = toMinutes(options.openTime);
  const close = toMinutes(options.closeTime);
  const tag = `${date.replace(/-/g, '')}${slug(site.slug)}`;

  const isNew = allocate(random, count, options.newCustomerRatio);
  const isCommercial = allocate(random, count, options.commercialRatio);

  // Kinds are allocated too: mostly service work, with counter sales and phone bookings through the day.
  const sales = count >= 4 ? Math.max(1, Math.round(count * 0.2)) : 0;
  const calls = count >= 5 ? Math.max(1, Math.round(count * 0.15)) : 0;
  const kinds: VisitKind[] = random.pickN(
    Array.from({ length: count }, (_, index): VisitKind =>
      index < sales ? 'counter-sale' : index < sales + calls ? 'appointment-call' : 'service',
    ),
    count,
  );

  const drafts = Array.from({ length: count }, (_, index) => ({
    index,
    kind: kinds[index],
    arrival:
      kinds[index] === 'service' ? arrivalMinutes(random, open, close) : random.int(open + 15, Math.max(open + 15, close - 45)),
  })).sort((a, b) => a.arrival - b.arrival);

  return drafts.map((draft, order): Visit => {
    const id = `${site.slug}-v${String(order + 1).padStart(2, '0')}`;
    const type: CustomerType = isCommercial[draft.index] ? 'commercial' : 'individual';
    const status = isNew[draft.index] ? 'new' : 'existing';

    const firstName = random.firstName();
    const lastName = random.lastName();
    const email = `${slug(firstName)}.${slug(lastName)}.${tag}${order + 1}@agentqa.invalid`;
    const customer: VisitCustomer = { type, status };
    if (status === 'existing') {
      customer.search = { fragment: random.pickOne([...'abcdeghilmnorst']), ordinal: random.int(1, 5) };
    } else if (type === 'individual') {
      customer.person = { firstName, lastName, email, phone: random.phone() };
    } else {
      customer.company = {
        legalName: `${random.lastName()} ${random.pickOne(COMPANY_SUFFIXES)} ${random.pickOne(['LLC', 'Inc.', 'Co.'])}`,
        contactFirstName: firstName,
        contactLastName: lastName,
        email,
        phone: random.phone(),
      };
    }

    // A new customer's vehicle is new by definition; a returning one sometimes brings a different car.
    const newVehicle = status === 'new' || random.chance(options.newVehicleRatio);
    const vehicle: VisitVehicle =
      draft.kind === 'counter-sale'
        ? { status: 'existing' }
        : newVehicle
          ? {
              status: 'new',
              details: {
                year: random.vehicleYear(),
                make: random.vehicleMake(),
                model: random.vehicleModel(),
                vin: random.vin(),
                licensePlate: random.licensePlate(),
              },
            }
          : { status: 'existing' };

    const concern =
      draft.kind === 'counter-sale'
        ? random.pickOne(COUNTER_CONCERNS)
        : draft.kind === 'appointment-call'
          ? random.pickOne(CALL_CONCERNS)
          : random.pickOne(type === 'commercial' ? FLEET_CONCERNS : SERVICE_CONCERNS);

    const roll = random.int(1, 100);
    const disposition: Disposition = roll <= 15 ? 'declines' : roll <= 27 ? 'approves-then-adds-work' : 'approves';
    // Commercial accounts mostly run on terms; individuals pay at pickup.
    const payment: Payment = type === 'commercial' && random.chance(0.65) ? 'on-account' : 'cash';
    const arrival = draft.kind === 'service' && status === 'existing' && random.chance(0.3) ? 'appointment' : 'walk-in';

    let stages: VisitStage[];
    if (draft.kind === 'counter-sale') {
      stages = [{ id: `${id}-sale`, name: 'sale', at: toClock(draft.arrival) }];
    } else if (draft.kind === 'appointment-call') {
      stages = [{ id: `${id}-call`, name: 'call', at: toClock(draft.arrival) }];
    } else {
      const work = Math.min(draft.arrival + random.int(30, 90), close - 60);
      const checkout = Math.min(work + random.int(60, 150), close - 15);
      stages = [
        { id: `${id}-intake`, name: 'intake', at: toClock(draft.arrival) },
        ...(disposition === 'declines'
          ? []
          : [
              { id: `${id}-work`, name: 'work' as const, at: toClock(work) },
              { id: `${id}-checkout`, name: 'checkout' as const, at: toClock(checkout) },
            ]),
      ];
    }

    const where = { id: site.id, name: site.name, code: site.code, slug: site.slug };
    return { id, kind: draft.kind, customer, vehicle, concern, arrival, disposition, payment, site: where, stages };
  });
}

/** One line per visit, for the plan printout and the report. */
export function describeVisit(visit: Visit): string {
  const who =
    visit.customer.status === 'new'
      ? visit.customer.type === 'commercial'
        ? `new commercial (${visit.customer.company?.legalName})`
        : `new individual (${visit.customer.person?.firstName} ${visit.customer.person?.lastName})`
      : `existing ${visit.customer.type}`;
  const vehicle = visit.kind === 'counter-sale' ? '' : `, ${visit.vehicle.status} vehicle`;
  const how = visit.kind === 'service' ? `, ${visit.arrival}, ${visit.disposition}, ${visit.payment}` : '';
  return `${visit.site.name} — ${visit.kind}: ${who}${vehicle}${how}`;
}
