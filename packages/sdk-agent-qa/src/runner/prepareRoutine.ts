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
import { counterTerminal } from '../day/sites';
import type { Lookup } from '../day/prepare';
import { buildBankStatement, entryMethodFor, statementFile, type BankItemKind, type LedgerItem } from '../tools/mockBank';

export type RoutinePreparation = 'crew' | 'self' | 'register' | 'stock' | 'purchase-orders' | 'bank-accounts' | 'bank-statement' | 'bank-reconciliation' | 'vendor-bills';

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
  /** The statement balance a bank account's first statement opens at (QA_BANK_OPENING_BALANCE). */
  bankOpeningBalance?: number;
  /** The change float each front-counter register goes live with (QA_REGISTER_FLOAT); 0 or unset puts none on the books. */
  registerFloat?: number;
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
  // The work session stays offered: the routine still starts or stops it.
  self: ['people-contact.PeopleAPIApi.getCurrentPerson'],
  register: ['people-contact.PeopleAPIApi.getCurrentPerson'],
  // Paging the whole stock to find the lowest is what the agent did with this read (36 pages of 5 on one run).
  stock: ['inventory.InventoryStockApi.listStock'],
  // Finding the order to receive is where receive-delivery spent its budget: 9 listings and each order read 2-3 times.
  'purchase-orders': ['order.PurchaseOrdersApi.listPurchaseOrders'],
  'bank-accounts': ['accounting.BankAccountsApi.listBankAccounts'],
  // The statement is built in code from the ledger, so none of the reading that feeds it is left to do.
  'bank-statement': [
    'accounting.BankAccountsApi.listBankAccounts',
    'accounting.BankStatementsApi.listBankStatements',
    'accounting.FinancialReportingApi.generateGeneralLedger',
    'accounting.JournalEntriesApi.listJournalEntries',
    'accounting.JournalEntriesApi.getJournalEntry',
    'accounting.GLAccountsApi.getGLAccountBalance',
  ],
  'bank-reconciliation': [
    'accounting.BankAccountsApi.listBankAccounts',
    'accounting.BankStatementsApi.listBankStatements',
    'accounting.BankReconciliationApi.listReconciliations',
    'accounting.BankReconciliationApi.listReconciliationAdjustmentTypes',
  ],
  // The routine reads the stages again at its end, so they stay offered.
  'vendor-bills': [],
};

/** Tools a preparation makes redundant: the statement routine's bank is consulted in code. */
export const PREPARED_TOOLS: Partial<Record<RoutinePreparation, readonly string[]>> = {
  'bank-statement': ['bank_statement'],
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

const DAY_MS = 86_400_000;

/** YYYY-MM-DD `days` after `day` (negative for before). */
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The Sunday that ended last week: yesterday on a Monday, a week ago on a Sunday. */
export function lastSunday(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -(weekday === 0 ? 7 : weekday));
}

const day = (value: unknown): string | undefined => iso(value)?.slice(0, 10);

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const roundCents = (amount: number): number => Math.round(amount * 100) / 100;

const json = (value: unknown): string => JSON.stringify(value);

/** A general-ledger line on a bank account, signed so money into the account is positive. */
export interface BankLedgerLine {
  date: string;
  amount: number;
  sourceEventType?: string;
  description?: string;
  entryNumber?: string;
  /** Cumulative signed balance through this line. */
  runningBalance?: number;
}

/** The lines of a general-ledger report, oldest first. */
export function bankLedgerLines(report: unknown): BankLedgerLine[] {
  return listOf(report, 'accounts')
    .flatMap((section) => listOf(section['lines']))
    .map((line) => ({
      date: day(line['transactionDate']) ?? '',
      amount: roundCents((num(line['debitAmount']) ?? 0) - (num(line['creditAmount']) ?? 0)),
      sourceEventType: text(line['sourceEventType']),
      description: text(line['description']),
      entryNumber: text(line['entryNumber']),
      runningBalance: num(line['runningBalance']),
    }))
    .filter((line) => line.date !== '');
}

const OPENING_BALANCE = 'OPENING_BALANCE';

/**
 * How the bank treats a ledger line, which decides when it clears. Read from what
 * posted it: a deposit, a customer's check or transfer, a payment to a vendor.
 */
export function bankItemKind(line: Pick<BankLedgerLine, 'amount' | 'sourceEventType' | 'description'>): BankItemKind {
  const what = `${line.sourceEventType ?? ''} ${line.description ?? ''}`.toUpperCase();
  if (line.amount > 0 && /DEPOSIT/.test(what)) {
    return 'CASH_DEPOSIT';
  }
  if (line.amount < 0) {
    return /AP_|VENDOR|PAYABLE|BILL|PAYMENT|CHECK/.test(what) ? 'VENDOR_PAYMENT' : 'OTHER';
  }
  if (/CHECK|CHEQUE/.test(what)) {
    return 'CUSTOMER_CHECK';
  }
  return /PAYMENT|RECEIPT|TRANSFER|ACH|WIRE|REMIT/.test(what) ? 'CUSTOMER_TRANSFER' : 'OTHER';
}

interface BankAccountRef {
  glAccountId: string;
  code: string;
  label: string;
}

/** The first two bank accounts, read as the routine's persona or the controller. */
async function bankAccountRefs(
  lookup: Lookup,
  context: RoutineContext,
): Promise<{ accounts: BankAccountRef[]; reader?: string; note?: string } | undefined> {
  const read = await readAs(lookup, 'accounting.BankAccountsApi.listBankAccounts', {}, context, ['controller']);
  if (!read.ok) {
    return undefined;
  }
  const accounts = listOf(read.body, 'accounts', 'content')
    .map((account) => {
      const glAccountId = text(account['glAccountId']);
      const code = text(account['accountCode']) ?? '?';
      return glAccountId
        ? { glAccountId, code, label: `${text(account['accountName']) ?? 'bank account'} (code ${code}, glAccountId ${glAccountId})` }
        : undefined;
    })
    .filter((account): account is BankAccountRef => account !== undefined)
    .slice(0, 2);
  return { accounts, reader: read.persona, note: readerNote('the bank accounts, statements and reconciliations', read, context) };
}

const asPersona = (reader: string | undefined): string => (reader ? ` with sdk_call as persona "${reader}"` : '');

/** The account's committed statements, latest end first; undefined when they could not be read. */
async function committedStatements(lookup: Lookup, glAccountId: string, reader: string | undefined): Promise<Record<string, unknown>[] | undefined> {
  const read = await lookup('accounting.BankStatementsApi.listBankStatements', { glAccountId, page: 0, size: 50 }, reader);
  if (!read.ok) {
    return undefined;
  }
  return listOf(read.body, 'statements', 'content')
    .filter((statement) => statement['status'] === undefined || statement['status'] === 'COMMITTED')
    .sort((a, b) => (day(b['endDate']) ?? '').localeCompare(day(a['endDate']) ?? ''));
}

/**
 * Last week's bank statement, built in code. The period continues from the latest
 * statement (or, the first time, from the account's opening balance, or last week),
 * the ledger's lines on the account are classified by what posted them, and the
 * bank (tools/mockBank.ts) returns the statement it would have sent. The agent is
 * left the bookkeeper's part: put a first opening balance on the books, enter the
 * statement as given, read it back.
 */
async function bankStatement(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  const found = await bankAccountRefs(lookup, context);
  if (!found) {
    return [];
  }
  const facts: string[] = found.note ? [found.note] : [];
  if (found.accounts.length === 0) {
    return [...facts, 'There is no bank account to enter a statement for.'];
  }
  const { reader } = found;
  const periodEnd = lastSunday(context.date);
  const policy = await lookup('accounting.AccountingPeriodsApi.getBankReconciliationPolicy', {}, reader);
  const currency = (policy.ok ? text(asRecord(policy.body)['currency']) : undefined) ?? 'USD';

  for (const account of found.accounts) {
    const statements = await committedStatements(lookup, account.glAccountId, reader);
    if (!statements) {
      facts.push(`${account.label}: its statements could not be read; work this account from the steps above.`);
      continue;
    }
    const latest = statements[0];
    let periodStart: string;
    let openingBalance: number | undefined;
    let openingToEstablish: { asOfDate: string; statementBalance: number } | undefined;
    let ledger: BankLedgerLine[] | undefined;

    if (latest && day(latest['endDate'])) {
      periodStart = addDays(day(latest['endDate']) as string, 1);
      openingBalance = num(latest['closingBalance']);
    } else {
      // No statement yet: continue from the opening balance if the books have one.
      const history = await lookup(
        'accounting.FinancialReportingApi.generateGeneralLedger',
        { accountId: account.glAccountId, startDate: '2000-01-01', endDate: periodEnd },
        reader,
      );
      if (!history.ok) {
        facts.push(`${account.label}: no statement yet, and its ledger could not be read; work this account from the steps above.`);
        continue;
      }
      ledger = bankLedgerLines(history.body);
      const opened = ledger.filter((line) => line.sourceEventType === OPENING_BALANCE).pop();
      if (opened) {
        periodStart = addDays(opened.date, 1);
        // The opening balance has no outstanding items, so the book balance it left is the bank's.
        openingBalance = [...ledger].filter((line) => line.date <= opened.date).pop()?.runningBalance;
      } else if (context.bankOpeningBalance !== undefined) {
        periodStart = addDays(periodEnd, -6);
        openingBalance = context.bankOpeningBalance;
        openingToEstablish = { asOfDate: addDays(periodStart, -1), statementBalance: context.bankOpeningBalance };
      } else {
        facts.push(`${account.label}: no statement and no opening balance yet; work this account from the steps above.`);
        continue;
      }
    }
    if (openingBalance === undefined) {
      facts.push(`${account.label}: the balance the next statement opens at could not be worked out; work this account from the steps above.`);
      continue;
    }
    if (periodStart > periodEnd) {
      facts.push(`${account.label}: statements already cover last week (through ${addDays(periodStart, -1)}). Nothing to enter; skip it.`);
      continue;
    }

    const windowStart = addDays(periodStart, -5);
    if (!ledger) {
      const read = await lookup(
        'accounting.FinancialReportingApi.generateGeneralLedger',
        { accountId: account.glAccountId, startDate: windowStart, endDate: periodEnd },
        reader,
      );
      if (!read.ok) {
        facts.push(`${account.label}: its ledger could not be read; work this account from the steps above.`);
        continue;
      }
      ledger = bankLedgerLines(read.body);
    }
    const items: LedgerItem[] = ledger
      .filter((line) => line.sourceEventType !== OPENING_BALANCE && line.date >= windowStart && line.date <= periodEnd)
      .map((line) => ({
        date: line.date,
        amount: line.amount,
        kind: bankItemKind(line),
        reference: line.entryNumber,
        description: line.description,
      }));
    const statement = buildBankStatement({ account: account.code, periodStart, periodEnd, openingBalance, items });

    const lines: string[] = [];
    const first = statements.length === 0;
    const gapAcknowledgement = first
      ? `First statement for account ${account.code}: there is no earlier statement for this one to continue.`
      : undefined;
    if (openingToEstablish) {
      lines.push(
        `${account.label} has no opening balance on the books. Put it on first: call ` +
          `accounting.BankAccountsApi.establishBankOpeningBalance${asPersona(reader)} with exactly this input: ` +
          json({
            glAccountId: account.glAccountId,
            bankOpeningBalanceRequest: {
              asOfDate: openingToEstablish.asOfDate,
              currencyCode: currency,
              statementBalance: openingToEstablish.statementBalance,
              outstandingItems: [],
              justification: `Statement balance of ${openingToEstablish.statementBalance.toFixed(2)} is the bank balance at the start of this run.`,
            },
          }),
      );
    }
    const header = {
      startDate: periodStart,
      endDate: periodEnd,
      openingBalance: statement.statement.openingBalance,
      closingBalance: statement.statement.closingBalance,
    };
    if (statement.transactions.length === 0) {
      lines.push(
        `${account.label}: nothing cleared the bank from ${periodStart} to ${periodEnd}, so the bank sent no statement ` +
          '(accounting refuses one with no lines). Enter none; the next statement will start where the last one ended.',
      );
    } else if (entryMethodFor(periodEnd) === 'keyed-by-hand') {
      lines.push(
        `The bank's statement for ${account.label}, ${periodStart} to ${periodEnd}, opening ${header.openingBalance.toFixed(2)}, ` +
          `closing ${header.closingBalance.toFixed(2)}, ${statement.transactions.length} line(s). Key it in by hand: call ` +
          `accounting.BankStatementsApi.createBankStatement${asPersona(reader)} with exactly this input: ` +
          json({
            bankStatementCreateRequest: {
              glAccountId: account.glAccountId,
              currency,
              ...(gapAcknowledgement ? { gapAcknowledgement } : {}),
              statement: header,
              transactions: statement.transactions,
            },
          }),
      );
    } else {
      const { fileName, contentType, formatCode, signConvention, columnMapping, content } = statementFile(statement);
      lines.push(
        `The bank's statement for ${account.label}, ${periodStart} to ${periodEnd}, opening ${header.openingBalance.toFixed(2)}, ` +
          `closing ${header.closingBalance.toFixed(2)}, ${statement.transactions.length} line(s), comes as a file. Upload it: call ` +
          `accounting.BankImportsApi.createBankImport${asPersona(reader)} with exactly this input: ` +
          json({
            bankImportCreateRequest: {
              glAccountId: account.glAccountId,
              currency,
              ...(gapAcknowledgement ? { gapAcknowledgement } : {}),
              formatCode,
              fileName,
              contentType,
              signConvention,
              columnMapping,
              content,
              statement: header,
            },
          }) +
          ' Then read the import (getBankImport) and its rows (listBankImportRows), and commit it (commitBankImport).',
      );
    }
    if (statement.transactions.length > 0) {
      lines.push('Enter it exactly as given: do not change an amount to make it agree with the books. Then read the statement back.');
      const pending = statement.notYetCleared.map((item) => `${item.reference ?? item.kind} ${item.amount.toFixed(2)} (clears ${item.clearsOn})`);
      lines.push(
        pending.length === 0
          ? 'Every ledger item in the period cleared; the bank has nothing outstanding.'
          : `Not yet cleared by the bank (${pending.length}): ${pending.join('; ')}.`,
      );
    }
    facts.push(lines.join(' '));
  }
  return facts;
}

/**
 * Where each bank account's reconciliation stands: its latest committed statement,
 * and whether that statement has a reconciliation, finalized or still open.
 */
async function bankReconciliation(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  const found = await bankAccountRefs(lookup, context);
  if (!found) {
    return [];
  }
  const facts: string[] = found.note ? [found.note] : [];
  if (found.accounts.length === 0) {
    return [...facts, 'There is no bank account to reconcile.'];
  }
  const { reader } = found;
  for (const account of found.accounts) {
    const statements = await committedStatements(lookup, account.glAccountId, reader);
    if (!statements) {
      facts.push(`${account.label}: its statements could not be read; work this account from the steps above.`);
      continue;
    }
    const latest = statements[0];
    if (!latest) {
      facts.push(`${account.label} has no committed statement: there is nothing to reconcile. Skip it.`);
      continue;
    }
    const statementId = text(latest['statementId']);
    const period = `${day(latest['startDate']) ?? '?'} to ${day(latest['endDate']) ?? '?'}`;
    const about =
      `${account.label}: the latest committed statement is statementId ${statementId ?? '?'}, ${period}, opening ` +
      `${String(num(latest['openingBalance']) ?? '?')}, closing ${String(num(latest['closingBalance']) ?? '?')}, ` +
      `${String(num(latest['bankTransactionCount']) ?? '?')} line(s).`;
    const reconciliations = await lookup(
      'accounting.BankReconciliationApi.listReconciliations',
      { glAccountId: account.glAccountId, page: 0, size: 50 },
      reader,
    );
    const forStatement = reconciliations.ok
      ? listOf(reconciliations.body, 'reconciliations', 'content').filter((rec) => text(rec['statementId']) === statementId)
      : listOf(latest['reconciliations']);
    const finalized = forStatement.find((rec) => rec['status'] === 'FINALIZED');
    const open = forStatement.find((rec) => rec['status'] === 'IN_PROGRESS' || rec['status'] === 'SUBMITTED');
    if (finalized) {
      facts.push(`${about} Its reconciliation ${String(finalized['reconciliationId'])} is FINALIZED: nothing to do. Skip it.`);
    } else if (open) {
      const counts = ['countUnexplainedBank', 'countUnexplainedLedger', 'difference', 'version']
        .filter((key) => open[key] !== undefined)
        .map((key) => `${key} ${String(open[key])}`)
        .join(', ');
      facts.push(
        `${about} Its reconciliation ${String(open['reconciliationId'])} is ${String(open['status'])}${counts ? ` (${counts})` : ''}: ` +
          'carry on with that one; do not open another.',
      );
    } else {
      facts.push(
        `${about} It has no reconciliation yet. Open one: call accounting.BankReconciliationApi.createReconciliation` +
          `${asPersona(reader)} with exactly this input: ${json({ reconciliationCreateRequest: { glAccountId: account.glAccountId, statementId } })}`,
      );
    }
  }
  facts.push(
    'Adjustment types for lines only the bank has: BANK_FEE for a service charge, INTEREST_EARNED for interest paid, ' +
      'NSF_FEE for a returned-item fee, TRANSFER or OTHER for anything else.',
  );
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

/**
 * The routine's own login: its personId and its clock state, so the agent can
 * read and close its own work session without guessing an id.
 */
async function self(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  const persona = context.roleMode ? context.persona : undefined;
  const me = await lookup('people-contact.PeopleAPIApi.getCurrentPerson', {}, persona);
  const person = asRecord(me.body);
  const personId = me.ok ? text(person['id']) : undefined;
  if (!personId) {
    return [];
  }
  const name = [text(person['firstName']), text(person['lastName'])].filter(Boolean).join(' ');
  const state = await lookup('people.WorkSessionsAPIApi.getCurrentWorkSession', { personId }, persona);
  const session = asRecord(state.body);
  const parts = [`You are ${name || 'this login'}, personId ${personId}`];
  if (state.ok) {
    parts.push(text(session['clockState']) ?? 'clock state unknown');
    const since = iso(session['clockedInAt']);
    if (since) {
      parts.push(`since ${localDate(since, context.timeZone)} ${localTime(since, context.timeZone)}`);
    }
    if (text(session['workSessionId'])) {
      parts.push(`workSessionId ${String(session['workSessionId'])}`);
    }
  }
  return [`${parts.join(', ')}. Use this personId for your own work session.`];
}

/**
 * Puts the site's front-counter register float on the books once, as the
 * controller (go-live float: Dr 1080 Register Float / Cr 3900 Opening Balance
 * Equity), so a session opens with change in the drawer. A register that already
 * has one answers 409 FLOAT_ALREADY_ESTABLISHED, which is the normal case after
 * the first day. Then the routine's own identity, as for `self`.
 */
async function register(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  const facts: string[] = [];
  const amount = context.registerFloat ?? 0;
  if (context.site && amount > 0) {
    const controller = context.roleMode ? 'controller' : undefined;
    const policy = await lookup('accounting.AccountingPeriodsApi.getBankReconciliationPolicy', {}, controller);
    const currencyCode = (policy.ok ? text(asRecord(policy.body)['currency']) : undefined) ?? 'USD';
    const registerId = counterTerminal(context.site);
    const goLive = await lookup(
      'accounting.AccountingRegisterFloatApi.establishGoLiveRegisterFloat',
      {
        registerId,
        registerFloatGoLiveRequest: {
          locationId: context.site.id,
          amount,
          currencyCode,
          goLiveDate: context.date,
          justification: `Front-counter change float for ${context.site.name}, put on the books at go-live`,
        },
      },
      controller,
    );
    if (goLive.ok) {
      facts.push(
        `The front-counter register ${registerId} went live just now with a ${amount} ${currencyCode} change float ` +
          '(the controller put it on the books). A session opened from now on starts with it.',
      );
    }
  }
  return [...facts, ...(await self(lookup, context))];
}

/** How many of the lowest-stocked SKUs the brief names, and how many stock pages the read follows. */
const STOCK_SHORTLIST = 6;
const STOCK_MAX_PAGES = 10;

/**
 * The site's stock by SKU, read in full in code and cut to the lowest available,
 * each matched to its catalog product (the id a purchase-order line takes as
 * skuId). With nothing flagged by replenishment, the agent's only other way to
 * find the lowest on hand is to page the whole stock list, which the result
 * budget shows it a few rows at a time.
 */
async function stock(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  if (!context.site) {
    return [];
  }
  const persona = context.roleMode ? context.persona : undefined;
  const rows: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < STOCK_MAX_PAGES; page++) {
    const answer = await lookup(
      'inventory.InventoryStockApi.listStock',
      { scope: context.site.id, groupBy: 'item', pageSize: 200, ...(pageToken ? { pageToken } : {}) },
      persona,
    );
    if (!answer.ok) {
      break;
    }
    rows.push(...listOf(answer.body, 'items'));
    pageToken = text(asRecord(answer.body)['nextPageToken']);
    if (!pageToken) {
      break;
    }
  }
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const stocked = rows.filter((row) => text(row['sku']));
  if (stocked.length === 0) {
    return [];
  }
  const lowest = [...stocked]
    .sort((a, b) => count(a['available']) - count(b['available']) || count(a['onHand']) - count(b['onHand']) || String(a['sku']).localeCompare(String(b['sku'])))
    .slice(0, STOCK_SHORTLIST);

  const lines = [
    `Stock on hand at ${context.site.name}, read just now: ${stocked.length} SKUs stocked. The ${lowest.length} with the least ` +
      'available, lowest first (productId is what a purchase-order line takes as skuId):',
  ];
  for (const row of lowest) {
    const sku = String(row['sku']);
    const found = await lookup('catalog.ProductsAPIApi.searchCatalogProducts', { q: sku, limit: 5 }, persona);
    const product = found.ok ? listOf(found.body, 'data', 'items').find((item) => item['sku'] === sku) : undefined;
    const name = product ? text(product['name']) : undefined;
    const productId = product ? text(product['productId']) : undefined;
    const status = text(row['statusReason']) ?? text(row['status']);
    lines.push(
      `  ${sku}${name ? ` — ${name}` : ''}: ${productId ? `productId ${productId}, ` : 'no catalog product matched, '}` +
        `available ${count(row['available'])}, on hand ${count(row['onHand'])}, inbound ${count(row['inbound'])}` +
        (status ? `, ${status}` : ''),
    );
  }
  return [lines.join('\n')];
}

/** How far back a purchase order counts as this delivery's before older ones are considered at all. */
const RECENT_ORDER_DAYS = 7;

const isoDay = (value: unknown): string | undefined => iso(value)?.slice(0, 10);

/**
 * The purchase order today's delivery is for, picked in code: approved or partly
 * received, still open, not ordered for a workorder (those are received against
 * the job), and the oldest raised in the last week, preferring one nothing has
 * been received against yet over the remainder a short delivery left (the oldest
 * of all when none is that recent). Its lines come with what is still open and what the
 * delivery brings, so the ship notice and the receipt agree with the order.
 */
async function purchaseOrders(lookup: Lookup, context: RoutineContext): Promise<string[]> {
  if (!context.site) {
    return [];
  }
  const persona = context.roleMode ? context.persona : undefined;
  const orders: Record<string, unknown>[] = [];
  for (const status of ['APPROVED', 'PARTIALLY_RECEIVED']) {
    const answer = await lookup(
      'order.PurchaseOrdersApi.listPurchaseOrders',
      { locationId: context.site.id, status, size: 100, sort: ['createdAt,asc'] },
      persona,
    );
    if (!answer.ok) {
      return [];
    }
    orders.push(...listOf(answer.body, 'content', 'items'));
  }
  const quantity = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const openLines = (order: Record<string, unknown>) =>
    listOf(order['lines']).filter((line) => quantity(line['openQuantityDecimal']) > 0);
  const forWorkorder = (order: Record<string, unknown>): boolean =>
    /workorder/i.test(text(order['comment']) ?? '') || listOf(order['lines']).some((line) => text(line['workorderId']));
  const open = orders
    .filter((order) => !forWorkorder(order) && openLines(order).length > 0)
    .sort((a, b) => (iso(a['createdAt']) ?? '').localeCompare(iso(b['createdAt']) ?? ''));

  if (open.length === 0) {
    return [
      `No purchase order shipping to ${context.site.name} is approved and still open, other than any ordered for a ` +
        'workorder: there is nothing on this truck to receive against an order.',
    ];
  }
  // createdAt, not poDate: on an accelerated clock poDate is virtual, and a months-old test order reads as this week's.
  const since = new Date(Date.parse(`${context.date}T00:00:00Z`) - RECENT_ORDER_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent = open.filter((order) => (isoDay(order['createdAt']) ?? '') >= since);
  // A truck brings what was ordered: a whole recent order before the one unit a past delivery left short.
  const untouched = recent.filter((order) => text(order['status']) === 'APPROVED');
  const order = (untouched.length > 0 ? untouched : recent.length > 0 ? recent : open)[0]!;
  const lines = openLines(order);
  const comment = text(order['comment']);
  const facts = [
    `The purchase order this delivery is for: PO ${text(order['poNumber']) ?? '?'} (purchaseOrderId ` +
      `${text(order['purchaseOrderId']) ?? '?'}, vendorId ${text(order['vendorId']) ?? '?'}), ${text(order['status']) ?? '?'}, ` +
      `raised ${isoDay(order['poDate']) ?? isoDay(order['createdAt']) ?? '?'}${comment ? `, comment "${comment}"` : ''}. ` +
      `Its open lines (skuId is the catalog productId), with what arrives on this truck:`,
  ];
  lines.forEach((line, index) => {
    const openQuantity = quantity(line['openQuantityDecimal']);
    const short = lines.length > 1 && index === lines.length - 1 && openQuantity > 1;
    facts.push(
      `  line ${quantity(line['lineNumber'])} (lineId ${text(line['lineId']) ?? '?'}): skuId ${text(line['skuId']) ?? '?'}` +
        `${text(line['description']) ? ` — ${text(line['description'])}` : ''}; ordered ${quantity(line['quantityDecimal'])}, ` +
        `open ${openQuantity}, unit cost ${quantity(line['unitCostMinor'])} minor ${text(order['currency']) ?? ''}`.trimEnd() +
        `; arrives ${short ? `${openQuantity - 1} (one short)` : openQuantity}`,
    );
  });
  const others = open.length - 1;
  if (others > 0) {
    facts.push(`  (${others} other open order${others === 1 ? '' : 's'} here can wait for a later truck.)`);
  }
  return [facts.join('\n')];
}

/** Runs the routine's preparation and returns the facts it established. Never throws for a failed read. */
export async function prepareRoutine(kind: RoutinePreparation, lookup: Lookup, context: RoutineContext): Promise<string[]> {
  switch (kind) {
    case 'crew':
      return crew(lookup, context);
    case 'self':
      return self(lookup, context);
    case 'register':
      return register(lookup, context);
    case 'stock':
      return stock(lookup, context);
    case 'purchase-orders':
      return purchaseOrders(lookup, context);
    case 'bank-accounts':
      return bankAccounts(lookup, context);
    case 'bank-statement':
      return bankStatement(lookup, context);
    case 'bank-reconciliation':
      return bankReconciliation(lookup, context);
    case 'vendor-bills':
    default:
      return vendorBills(lookup, context);
  }
}
