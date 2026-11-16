/**
 * The lookups a visit stage needs before anyone talks to the customer, done in
 * code rather than by the model.
 *
 * Finding "result 3 of the customers whose name contains 'r'", listing their
 * vehicles, finding a part that is on the shelf at this site and matching a
 * concern to catalog services are not judgements: they are searches with a
 * fixed rule. Left to the model, each costs a turn, and every turn resends the
 * whole conversation, so they made up most of a visit's tokens. Done here they
 * are ordinary SDK calls — recorded in the ledger and the month's coverage like
 * any other — and their results reach the agent as facts in the visit memory.
 *
 * Values nobody needs to judge (a vehicle for a customer with none on file, a
 * part price) come from the seeded generator, so a day replays identically.
 *
 * Every step is best effort. A lookup that fails or finds nothing leaves its
 * fact unset, and the stage brief falls back to asking the agent to do it.
 */
import { SeederRandom } from '@durion-sdk/seeder';
import { daySeed, type StageName, type Visit } from './dayPlan';
import type { VisitMemory } from './visitScenarios';

export interface LookupResult {
  ok: boolean;
  body: unknown;
}

/** One SDK call made by the harness: operation id, input, and optionally who makes it. */
export type Lookup = (operationId: string, input: Record<string, unknown>, persona?: string) => Promise<LookupResult>;

/** Shop labor rate per hour, in USD, for the labor lines the harness prices. */
export const LABOR_RATE = 130;

/** Facts only the stage that prepared them needs; later stages are not shown them. */
export const PREPARED_FACTS: ReadonlySet<string> = new Set(['laborLines', 'partLine', 'partsNote', 'vehicleToRegister', 'billingTerms']);

const PREPARED_STAGES: ReadonlySet<StageName> = new Set(['intake', 'sale', 'call']);

/** Concern wording → catalog search terms, most specific first. */
const TERMS: Array<[RegExp, string[]]> = [
  [/oil/i, ['oil change', 'oil']],
  [/nail|leak/i, ['tire repair']],
  [/tire|tyre|dual|spare/i, ['tire']],
  [/rotation/i, ['rotation']],
  [/brake/i, ['brake']],
  [/align|pulls/i, ['alignment']],
  [/shake|balance|vibration/i, ['balance', 'alignment']],
  [/battery|charging/i, ['battery']],
  [/inspection|pre-trip|DOT/i, ['inspection']],
  [/air conditioning/i, ['air conditioning', 'a/c']],
  [/wiper/i, ['wiper']],
  [/headlight|bulb/i, ['headlight', 'bulb']],
  [/coolant|temperature/i, ['coolant', 'cooling']],
  [/check engine|idles/i, ['diagnostic', 'engine']],
  [/maintenance|60,000|service\b/i, ['maintenance']],
  [/grinding|front end|suspension/i, ['suspension', 'steering']],
  [/gauge|valve/i, ['gauge', 'valve']],
];

/** The catalog search terms for what the customer said, in order of preference. */
export function concernTerms(concern: string): string[] {
  const terms: string[] = [];
  for (const [pattern, words] of TERMS) {
    if (pattern.test(concern)) {
      terms.push(...words.filter((word) => !terms.includes(word)));
    }
  }
  return terms.length > 0 ? terms : ['inspection'];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown, ...keys: string[]): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.map(asRecord);
  }
  for (const key of keys) {
    const inner = asRecord(value)[key];
    if (Array.isArray(inner)) {
      return inner.map(asRecord);
    }
  }
  return [];
};

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const COMMERCIAL_PARTY_TYPES = new Set(['COMMERCIAL', 'ORGANIZATION', 'BUSINESS']);

async function findCustomer(visit: Visit, memory: VisitMemory, lookup: Lookup, random: SeederRandom): Promise<void> {
  const search = visit.customer.search;
  const fragments = [search?.fragment ?? 'a', ...'aeinorst'.split('').filter((letter) => letter !== search?.fragment)];
  const wantCommercial = visit.customer.type === 'commercial';
  for (const fragment of fragments) {
    const { ok, body } = await lookup('customer.CRMAccountsApi.searchParties', {
      searchPartiesRequest: { name: fragment, pageSize: 50 },
    });
    if (!ok) {
      return;
    }
    const matches = asArray(body, 'results').filter(
      (party) =>
        text(party['partyId']) &&
        party['houseAccount'] === undefined &&
        (party['status'] === undefined || party['status'] === 'ACTIVE') &&
        COMMERCIAL_PARTY_TYPES.has(String(party['partyType'])) === wantCommercial,
    );
    if (matches.length > 0) {
      const ordinal = search?.ordinal ?? random.int(1, matches.length);
      const party = matches[(ordinal - 1) % matches.length];
      memory['partyId'] = String(party['partyId']);
      memory['customerName'] = text(party['displayName']) ?? text(party['legalName']) ?? 'customer on file';
      return;
    }
  }
}

async function findVehicle(memory: VisitMemory, lookup: Lookup, random: SeederRandom): Promise<void> {
  const { ok, body } = await lookup('customer.CRMVehiclesApi.listVehiclesForCustomer', { customerId: memory['partyId'] });
  if (!ok) {
    return;
  }
  const vehicles = asArray(body, 'vehicles', 'items', 'results').filter((vehicle) => text(vehicle['vehicleId']));
  if (vehicles.length > 0) {
    const vehicle = vehicles[random.int(0, vehicles.length - 1)];
    memory['vehicleId'] = String(vehicle['vehicleId']);
    memory['vehicleDescription'] = [vehicle['year'], vehicle['make'], vehicle['model']].filter((part) => part !== undefined).join(' ');
    return;
  }
  memory['vehicleToRegister'] =
    `${random.vehicleYear()} ${random.vehicleMake()} ${random.vehicleModel()}, VIN ${random.vin()}, plate ${random.licensePlate()}`;
}

async function chooseBillingTerms(memory: VisitMemory, lookup: Lookup): Promise<void> {
  const { ok, body } = await lookup('customer.CRMAccountsApi.listBillingTerms', {});
  const codes = ok ? asArray(body, 'items', 'terms').map((term) => text(term['code'])).filter((code): code is string => !!code) : [];
  if (codes.length > 0) {
    memory['billingTerms'] = codes.includes('NET_30') ? 'NET_30' : codes[0];
  }
}

async function chooseServices(visit: Visit, memory: VisitMemory, lookup: Lookup): Promise<void> {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const term of concernTerms(visit.concern)) {
    const { ok, body } = await lookup('catalog.ProductsAPIApi.searchCatalogServices', { q: term, limit: 5 });
    const service = ok ? asArray(body, 'items', 'data').find((entry) => text(entry['id']) && !seen.has(String(entry['id']))) : undefined;
    if (service) {
      seen.add(String(service['id']));
      const hours = typeof service['defaultLaborHours'] === 'number' && service['defaultLaborHours'] > 0 ? service['defaultLaborHours'] : 1;
      lines.push(`serviceId ${String(service['id'])}, description "${String(service['name'])}", quantity ${hours}, unitPrice ${LABOR_RATE}`);
    }
    if (lines.length >= 2) {
      break;
    }
  }
  if (lines.length > 0) {
    memory['laborLines'] = lines.join('; ');
  }
}

/**
 * A product on the shelf at the visit's site that fits the concern: the site's
 * stock (as the parts lead, who may read it) crossed with catalog search
 * results. With nothing on hand at the site, the job goes ahead without a part.
 */
async function choosePart(visit: Visit, memory: VisitMemory, lookup: Lookup, random: SeederRandom, partsPersona: string | undefined): Promise<void> {
  const stock = await lookup('inventory.InventoryStockApi.listStock', { scope: visit.site.id, status: 'ok', pageSize: 100 }, partsPersona);
  if (!stock.ok) {
    return;
  }
  const onShelf = new Set(
    asArray(stock.body, 'lines', 'items')
      .filter((line) => typeof line['available'] === 'number' && (line['available'] as number) > 0)
      .map((line) => text(line['sku']))
      .filter((sku): sku is string => !!sku),
  );
  if (onShelf.size === 0) {
    memory['partsNote'] = 'nothing is on hand at this location, so the job is labor only: add no part line';
    return;
  }
  const searches = [...concernTerms(visit.concern), ...[...onShelf].slice(0, 2)];
  for (const query of searches) {
    const { ok, body } = await lookup('catalog.ProductsAPIApi.searchCatalogProducts', { q: query, limit: 40 });
    const product = ok ? asArray(body, 'data', 'items').find((entry) => onShelf.has(String(entry['sku'])) && text(entry['productId'])) : undefined;
    if (product) {
      const name = text(product['name']) ?? String(product['sku']);
      memory['partProductId'] = String(product['productId']);
      memory['partDescription'] = name;
      memory['partLine'] = `productId ${String(product['productId'])}, description "${name}", quantity 1, unitPrice ${random.price(15, 180)}`;
      return;
    }
  }
}

/**
 * Establishes what a visit stage needs before the agent starts, writing it into
 * the visit memory. Facts already in memory are kept, so a retried stage does
 * not look them up again.
 */
export async function prepareStage(
  visit: Visit,
  stage: StageName,
  memory: VisitMemory,
  lookup: Lookup,
  options: { roleMode: boolean },
): Promise<void> {
  if (!PREPARED_STAGES.has(stage)) {
    return;
  }
  const random = new SeederRandom(daySeed(`${visit.id}|${stage}|prepare`, 0));
  const partsPersona = options.roleMode ? 'parts' : undefined;

  // An appointment arrival finds its customer through the appointment, which is the agent's to read.
  const byAppointment = stage === 'intake' && visit.arrival === 'appointment';
  if (visit.customer.status === 'existing' && !byAppointment && !memory['partyId']) {
    await findCustomer(visit, memory, lookup, random);
  }
  if (visit.customer.status === 'new' && visit.customer.type === 'commercial' && !memory['billingTerms']) {
    await chooseBillingTerms(memory, lookup);
  }
  if (stage !== 'sale' && visit.vehicle.status === 'existing' && memory['partyId'] && !memory['vehicleId'] && !memory['vehicleToRegister']) {
    await findVehicle(memory, lookup, random);
  }
  if (stage === 'intake' && !memory['laborLines']) {
    await chooseServices(visit, memory, lookup);
  }
  const needsShelfPart = (stage === 'intake' && visit.parts === 'stock') || stage === 'sale';
  if (needsShelfPart && !memory['partLine'] && !memory['partsNote']) {
    await choosePart(visit, memory, lookup, random, partsPersona);
  }
}
