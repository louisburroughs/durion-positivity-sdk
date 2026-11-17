/**
 * The reading a staff routine starts with, done in code before the agent starts.
 *
 * Routines begin by finding out the state of things: who works at this site and
 * whether each is clocked in, which bank accounts there are and what statements
 * they have, what is waiting in accounts payable. Those are reads with a fixed
 * rule; left to the model, each costs turns (and every turn resends the whole
 * conversation), and on alpha the crew routines spent most of theirs on them —
 * one stalled re-reading the same list. The decisions stay the agent's: who
 * clocks out, what to post, what to approve.
 *
 * Like the visit preparation (day/prepare.ts), these are ordinary SDK calls
 * recorded under the routine's id, and every step is best effort: a read that
 * fails leaves its fact out, and the brief still says how to find it.
 */
import type { Lookup } from '../day/prepare';

export type RoutinePreparation = 'crew' | 'bank-accounts' | 'vendor-bills';

export interface RoutineContext {
  /** The site a per-site routine is at. */
  site?: { id: string; name: string; code: string };
  /** The routine's own persona. */
  persona: string;
  /** Whether personas have their own logins; without, every read is the same login. */
  roleMode: boolean;
  /** Shop-local date, YYYY-MM-DD. */
  date: string;
  /** Shop time zone, for reading when a session started. */
  timeZone: string;
}

/**
 * Reads a preparation does, so the routine stops offering them once it has:
 * offered the tool, an agent read the whole crew's sessions again on its first turn.
 */
export const PREPARED_READS: Record<RoutinePreparation, readonly string[]> = {
  crew: [
    'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
    'people.WorkSessionsAPIApi.getCurrentWorkSession',
    'shop-manager.TechnicianAPIApi.listLocationTechnicians',
    'people.EmployeeAPIApi.searchEmployees',
  ],
  'bank-accounts': ['accounting.BankAccountsApi.listBankAccounts'],
  // The routine reads the stages again at its end, so they stay offered.
  'vendor-bills': [],
};

/** The facts as the brief's closing section; empty when nothing was established. */
export function renderFacts(facts: readonly string[]): string {
  return facts.length === 0
    ? ''
    : '\n\nThe reading this task starts with has been done for you, just now. Its results are below and are current: act ' +
        `on them, and do not read them again or look for other ways to check them.\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const listOf = (value: unknown, ...keys: string[]): Record<string, unknown>[] => {
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

const iso = (value: unknown): string | undefined =>
  value instanceof Date ? (Number.isNaN(value.getTime()) ? undefined : value.toISOString()) : text(value);

/** YYYY-MM-DD of an instant in the shop's time zone. */
const localDate = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));

/** HH:MM of an instant in the shop's time zone. */
const localTime = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(instant));

/**
 * Reads as the routine's persona, then — in role mode, when that persona is
 * refused — as each fallback in turn. Returns the first answer and who got it.
 */
async function readAs(
  lookup: Lookup,
  operationId: string,
  input: Record<string, unknown>,
  context: RoutineContext,
  fallbacks: readonly string[],
): Promise<{ ok: boolean; body: unknown; persona?: string; refused: string[] }> {
  const personas = context.roleMode ? [context.persona, ...fallbacks.filter((persona) => persona !== context.persona)] : [undefined];
  const refused: string[] = [];
  for (const persona of personas) {
    const answer = await lookup(operationId, input, persona);
    if (answer.ok) {
      return { ...answer, persona, refused };
    }
    if (persona) {
      refused.push(persona);
    }
  }
  return { ok: false, body: undefined, refused };
}

/** Says which login could read, when the routine's own was refused. */
function readerNote(operation: string, read: { persona?: string; refused: string[] }, context: RoutineContext): string | undefined {
  if (!read.persona || read.persona === context.persona || read.refused.length === 0) {
    return undefined;
  }
  return (
    `${context.persona} is refused (403) on ${operation}; ${read.persona} can read it. Make those reads with sdk_call and ` +
    `persona "${read.persona}", and keep your own persona for the steps the task gives you.`
  );
}

/**
 * Who works at the site and the clock state of each, read live from each
 * person's current work session (the availability roll's clockState lags), with
 * the routine's own login marked so it does not clock itself out.
 */
async function crew(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  if (!context.site) {
    return [];
  }
  const roll = await lookup(
    'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
    { locationId: context.site.id, date: context.date },
    context.roleMode ? 'admin' : undefined,
  );
  const people = listOf(roll.body)
    .filter((person) => text(person['personId']) && (person['assignmentStatus'] === undefined || person['assignmentStatus'] === 'ACTIVE'))
    .map((person) => ({
      personId: String(person['personId']),
      name: [text(person['firstName']), text(person['lastName'])].filter(Boolean).join(' ') || String(person['personId']),
      role: text(person['role']) ?? 'staff',
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);
  if (!roll.ok || people.length === 0) {
    return [];
  }

  const me = await lookup('people-contact.PeopleAPIApi.getCurrentPerson', {}, context.roleMode ? context.persona : undefined);
  const myId = me.ok ? text(asRecord(me.body)['id']) : undefined;

  const lines: string[] = [
    `The people who work at ${context.site.name}, in alphabetical order, with each one's clock state read just now ` +
      '(personId; workSessionId when a session is open):',
  ];
  const states = new Map<string, number>();
  for (const person of people) {
    const state = await lookup('people.WorkSessionsAPIApi.getCurrentWorkSession', { personId: person.personId }, context.roleMode ? context.persona : undefined);
    const session = asRecord(state.body);
    const clock = state.ok ? text(session['clockState']) ?? 'unknown' : 'unknown (could not be read)';
    states.set(clock, (states.get(clock) ?? 0) + 1);
    const since = iso(session['clockedInAt']);
    const breakSince = iso(session['breakStartedAt']);
    const parts = [`${person.name} — ${person.role}, personId ${person.personId}, ${clock}`];
    if (since) {
      const day = localDate(since, context.timeZone);
      parts.push(
        day === context.date
          ? `since ${localTime(since, context.timeZone)}`
          : `since ${day} ${localTime(since, context.timeZone)} — a session left open from a previous day (missed clock-out)`,
      );
    }
    if (breakSince) {
      parts.push(`on break since ${localTime(breakSince, context.timeZone)}`);
    }
    if (text(session['workSessionId'])) {
      parts.push(`workSessionId ${String(session['workSessionId'])}`);
    }
    if (myId && myId === person.personId) {
      parts.push('this is you');
    }
    lines.push(`  ${parts.join(', ')}`);
  }
  const open = (states.get('CLOCKED_IN') ?? 0) + (states.get('ON_BREAK') ?? 0);
  const tally = [...states.entries()].map(([clock, count]) => `${count} ${clock}`).join(', ');
  lines.push(
    open === 0
      ? `In all: ${tally}. Nobody here has an open work session right now.`
      : `In all: ${tally}; ${open} with an open work session.`,
  );
  return [lines.join('\n')];
}

/** The bank accounts and, for each, how many statements it has and the latest one. */
async function bankAccounts(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  const accounts = await readAs(lookup, 'accounting.BankAccountsApi.listBankAccounts', {}, context, ['controller']);
  if (!accounts.ok) {
    return [];
  }
  const facts: string[] = [];
  const note = readerNote('the bank accounts and statements', accounts, context);
  if (note) {
    facts.push(note);
  }
  const reader = accounts.persona;
  for (const account of listOf(accounts.body, 'accounts', 'content').slice(0, 5)) {
    const glAccountId = text(account['glAccountId']);
    if (!glAccountId) {
      continue;
    }
    const label = `${text(account['accountName']) ?? 'bank account'} (code ${text(account['accountCode']) ?? '?'}, glAccountId ${glAccountId})`;
    const statements = await lookup('accounting.BankStatementsApi.listBankStatements', { glAccountId, page: 0, size: 50 }, reader);
    const list = statements.ok ? listOf(statements.body, 'statements', 'content') : undefined;
    const profile = account['profileExists'] === false ? ', no bank profile yet' : '';
    if (!list) {
      facts.push(`Bank account ${label}${profile}; its statements could not be read.`);
      continue;
    }
    if (list.length === 0) {
      facts.push(`Bank account ${label}${profile}: no statements yet.`);
      continue;
    }
    const ends = (statement: Record<string, unknown>): string =>
      iso(statement['periodEnd']) ?? iso(statement['statementDate']) ?? iso(statement['endDate']) ?? '';
    const latest = [...list].sort((a, b) => ends(b).localeCompare(ends(a)))[0];
    const summary = Object.entries(latest)
      .filter(([key, value]) => /id$|Id$|period|date|Date|balance|Balance|status/.test(key) && (typeof value !== 'object' || value instanceof Date))
      .map(([key, value]) => `${key} ${iso(value) ?? String(value)}`)
      .join(', ');
    facts.push(`Bank account ${label}${profile}: ${list.length} statement(s); the latest: ${summary}.`);
  }
  return facts;
}

/** Accounts payable's stage counts, the bills waiting on a receipt match, and purchase orders received lately. */
async function vendorBills(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  const facts: string[] = [];
  const counts = await readAs(lookup, 'accounting.VendorBillAPIApi.getVendorBillStageCounts', {}, context, ['controller']);
  if (counts.ok) {
    const note = readerNote('the vendor bill stages', counts, context);
    if (note) {
      facts.push(note);
    }
    const stages = Object.entries(asRecord(counts.body))
      .filter(([, value]) => typeof value === 'number')
      .map(([stage, value]) => `${stage} ${String(value)}`)
      .join(', ');
    facts.push(`Bills to pay, by stage: ${stages}.`);
    const waiting = await lookup('accounting.VendorBillAPIApi.listVendorBillsByStage', { stage: 'CHECK', page: 0, size: 10 }, counts.persona);
    if (waiting.ok) {
      const bills = listOf(waiting.body, 'content', 'bills');
      facts.push(
        bills.length === 0
          ? 'No bill is in the CHECK stage.'
          : `Bills in the CHECK stage: ${bills
              .map((bill) => text(bill['vendorBillId']) ?? text(bill['id']) ?? '?')
              .slice(0, 10)
              .join(', ')}.`,
      );
    }
  }

  // Received lately: a purchase order's updatedAt moves when goods are received against it.
  const since = new Date(`${context.date}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 1);
  const received: string[] = [];
  let reader: string | undefined;
  for (const status of ['RECEIVED', 'PARTIALLY_RECEIVED']) {
    const orders = await readAs(lookup, 'order.PurchaseOrdersApi.listPurchaseOrders', { status, page: 0, size: 100 }, context, ['parts', 'manager']);
    if (!orders.ok) {
      continue;
    }
    reader = orders.persona;
    for (const order of listOf(orders.body, 'content')) {
      const updated = iso(order['updatedAt']);
      if (updated && updated.slice(0, 10) >= since.toISOString().slice(0, 10)) {
        received.push(
          `${text(order['poNumber']) ?? '?'} (purchaseOrderId ${String(order['purchaseOrderId'])}, ${status}, vendorId ${String(order['vendorId'])}, updated ${updated.slice(0, 16)})`,
        );
      }
    }
  }
  if (reader && reader !== context.persona && context.roleMode) {
    facts.push(`${context.persona} cannot list purchase orders; ${reader} can: read them with sdk_call and persona "${reader}".`);
  }
  if (reader) {
    facts.push(
      received.length === 0
        ? 'No purchase order was received today or yesterday.'
        : `Purchase orders received today or yesterday: ${received.slice(0, 10).join('; ')}.`,
    );
  }
  return facts;
}

/** Runs the routine's preparation and returns the facts it established. Never throws for a failed read. */
export async function prepareRoutine(kind: RoutinePreparation, lookup: Lookup, context: RoutineContext): Promise<string[]> {
  switch (kind) {
    case 'crew':
      return crew(lookup, context);
    case 'bank-accounts':
      return bankAccounts(lookup, context);
    case 'vendor-bills':
    default:
      return vendorBills(lookup, context);
  }
}
