import type { Lookup } from '../day/prepare';
import { SCENARIOS } from '../scenarios/library';
import { bankItemKind, bankLedgerLines, lastSunday, prepareRoutine, renderFacts, type RoutineContext } from './prepareRoutine';

type Answer = (input: Record<string, unknown>, persona?: string) => { ok: boolean; body?: unknown } | unknown;

/** Canned answers by operation; an answer of `{ ok: false }` is a refusal. Records each call. */
function fakeLookup(answers: Record<string, Answer>): { lookup: Lookup; calls: Array<{ operationId: string; input: Record<string, unknown>; persona?: string }> } {
  const calls: Array<{ operationId: string; input: Record<string, unknown>; persona?: string }> = [];
  const lookup: Lookup = async (operationId, input, persona) => {
    calls.push({ operationId, input, persona });
    const answer = answers[operationId]?.(input, persona);
    if (answer === undefined) {
      return { ok: false, body: undefined };
    }
    const shaped = answer as { ok?: boolean; body?: unknown };
    return shaped.ok === false ? { ok: false, body: undefined } : { ok: true, body: answer };
  };
  return { lookup, calls };
}

const SITE = { id: 'site-1', name: 'Main Street', code: 'MAIN' };
const CONTEXT: RoutineContext = { site: SITE, persona: 'manager', roleMode: true, date: '2026-03-10', timeZone: 'America/New_York' };

describe('prepareRoutine: crew', () => {
  const ROLL = [
    { personId: 'p-2', firstName: 'Zed', lastName: 'Young', role: 'TECHNICIAN', assignmentStatus: 'ACTIVE', clockState: 'CLOCKED_OUT' },
    { personId: 'p-1', firstName: 'Amber', lastName: 'Nguyen', role: 'TECHNICIAN', assignmentStatus: 'ACTIVE', clockState: 'CLOCKED_OUT' },
    { personId: 'p-3', firstName: 'Mia', lastName: 'Lopez', role: 'SHOP_MANAGER', assignmentStatus: 'ACTIVE' },
    { personId: 'p-9', firstName: 'Gone', lastName: 'Away', role: 'TECHNICIAN', assignmentStatus: 'INACTIVE' },
  ];
  const SESSIONS: Record<string, unknown> = {
    'p-1': { personId: 'p-1', clockState: 'CLOCKED_IN', clockedInAt: new Date('2026-03-10T12:02:00Z'), workSessionId: 'ws-1' },
    'p-2': {
      personId: 'p-2',
      clockState: 'ON_BREAK',
      clockedInAt: new Date('2026-03-09T12:00:00Z'),
      breakStartedAt: new Date('2026-03-10T16:00:00Z'),
      workSessionId: 'ws-2',
    },
    'p-3': { personId: 'p-3', clockState: 'CLOCKED_OUT' },
  };
  const answers = {
    'people.PeopleAvailabilityAPIApi.listPeopleAvailability': () => ROLL,
    'people-contact.PeopleAPIApi.getCurrentPerson': () => ({ id: 'p-3', username: 'mia.lopez' }),
    'people.WorkSessionsAPIApi.getCurrentWorkSession': (input: Record<string, unknown>) => SESSIONS[String(input['personId'])],
  };

  it('lists the active crew alphabetically with live clock state, missed clock-outs, breaks and who you are', async () => {
    const { lookup, calls } = fakeLookup(answers);
    const [facts] = await prepareRoutine('crew', lookup, CONTEXT);
    const lines = facts.split('\n');
    expect(lines[1]).toBe('  Amber Nguyen — TECHNICIAN, personId p-1, CLOCKED_IN, since 08:02, workSessionId ws-1');
    expect(lines[2]).toBe('  Mia Lopez — SHOP_MANAGER, personId p-3, CLOCKED_OUT, this is you');
    expect(lines[3]).toMatch(
      /^ {2}Zed Young — TECHNICIAN, personId p-2, ON_BREAK, since 2026-03-09 08:00 — a session left open from a previous day \(missed clock-out\), on break since 12:00, workSessionId ws-2$/,
    );
    expect(lines[4]).toBe('In all: 1 CLOCKED_IN, 1 CLOCKED_OUT, 1 ON_BREAK; 2 with an open work session.');
    expect(facts).not.toContain('Gone Away');
    expect(calls[0]).toMatchObject({ input: { locationId: 'site-1', date: '2026-03-10' }, persona: 'admin' });
  });

  it('establishes nothing for a routine with no site, or when the roll cannot be read', async () => {
    expect(await prepareRoutine('crew', fakeLookup(answers).lookup, { ...CONTEXT, site: undefined })).toEqual([]);
    expect(await prepareRoutine('crew', fakeLookup({}).lookup, CONTEXT)).toEqual([]);
  });
});

describe('prepareRoutine: bank accounts', () => {
  const ACCT: RoutineContext = { persona: 'acct', roleMode: true, date: '2026-03-10', timeZone: 'America/New_York' };

  it('reads as controller when acct is refused, says so, and summarises each account\'s statements', async () => {
    const { lookup, calls } = fakeLookup({
      'accounting.BankAccountsApi.listBankAccounts': (_input, persona) =>
        persona === 'controller'
          ? { accounts: [{ accountCode: '1000', accountName: 'Cash', glAccountId: 'gl-1', profileExists: false }, { accountName: 'Payroll', accountCode: '1010', glAccountId: 'gl-2' }] }
          : { ok: false },
      'accounting.BankStatementsApi.listBankStatements': (input) =>
        input['glAccountId'] === 'gl-2'
          ? { statements: [{ statementId: 's-1', periodEnd: '2026-03-01', closingBalance: 100 }, { statementId: 's-2', periodEnd: '2026-03-08', closingBalance: 250, lines: [] }] }
          : { statements: [] },
    });
    const facts = await prepareRoutine('bank-accounts', lookup, ACCT);
    expect(facts[0]).toMatch(/^acct is refused \(403\) on the bank accounts and statements; controller can read it/);
    expect(facts[1]).toBe('Bank account Cash (code 1000, glAccountId gl-1), no bank profile yet: no statements yet.');
    expect(facts[2]).toBe('Bank account Payroll (code 1010, glAccountId gl-2): 2 statement(s); the latest: statementId s-2, periodEnd 2026-03-08, closingBalance 250.');
    expect(calls.filter((call) => call.operationId === 'accounting.BankStatementsApi.listBankStatements').every((call) => call.persona === 'controller')).toBe(true);
  });

  it('says nothing about personas when the routine\'s own login can read', async () => {
    const { lookup } = fakeLookup({
      'accounting.BankAccountsApi.listBankAccounts': () => ({ accounts: [] }),
    });
    expect(await prepareRoutine('bank-accounts', lookup, ACCT)).toEqual([]);
  });
});

describe('prepareRoutine: vendor bills', () => {
  it('reports the stages, the bills waiting on a match and the purchase orders received since yesterday', async () => {
    const { lookup } = fakeLookup({
      'accounting.VendorBillAPIApi.getVendorBillStageCounts': (_input, persona) =>
        persona === 'controller' ? { check: 1, approve: 0, pay: 4, done: 0, asOf: '2026-03-10T15:00:00Z' } : { ok: false },
      'accounting.VendorBillAPIApi.listVendorBillsByStage': () => ({ content: [{ vendorBillId: 'vb-1' }] }),
      'order.PurchaseOrdersApi.listPurchaseOrders': (input, persona) =>
        persona !== 'parts'
          ? { ok: false }
          : input['status'] === 'RECEIVED'
            ? {
                content: [
                  { poNumber: 'PO-7', purchaseOrderId: 'po-7', vendorId: 'v-1', updatedAt: new Date('2026-03-09T20:00:00Z') },
                  { poNumber: 'PO-1', purchaseOrderId: 'po-1', vendorId: 'v-1', updatedAt: new Date('2026-02-01T20:00:00Z') },
                ],
              }
            : { content: [] },
    });
    const facts = await prepareRoutine('vendor-bills', lookup, { persona: 'acct', roleMode: true, date: '2026-03-10', timeZone: 'America/New_York' });
    expect(facts).toEqual([
      expect.stringMatching(/^acct is refused \(403\) on the vendor bill stages; controller can read it/),
      'Bills to pay, by stage: check 1, approve 0, pay 4, done 0.',
      'Bills in the CHECK stage: vb-1.',
      'acct cannot list purchase orders; parts can: read them with sdk_call and persona "parts".',
      'Purchase orders received today or yesterday: PO-7 (purchaseOrderId po-7, RECEIVED, vendorId v-1, updated 2026-03-09T20:00).',
    ]);
  });
});

describe('prepareRoutine: bank statement', () => {
  // Tuesday 2026-03-17: last week ran Monday 03-09 to Sunday 03-15 (an odd week: keyed by hand).
  const ACCT: RoutineContext = { persona: 'acct', roleMode: true, date: '2026-03-17', timeZone: 'America/New_York', bankOpeningBalance: 50_000 };
  const ACCOUNT = { glAccountId: 'gl-1000', accountCode: '1000', accountName: 'Cash' };
  const gl = (lines: Array<Record<string, unknown>>) => ({ accounts: [{ accountId: 'gl-1000', lines }] });
  const line = (date: string, amount: number, sourceEventType: string, entryNumber: string, runningBalance?: number) => ({
    transactionDate: new Date(`${date}T00:00:00Z`),
    ...(amount >= 0 ? { debitAmount: amount } : { creditAmount: -amount }),
    sourceEventType,
    entryNumber,
    runningBalance,
    direction: amount >= 0 ? 'INCREASE' : 'DECREASE',
  });
  const answers = (statements: unknown[], ledger: Array<Record<string, unknown>>) => ({
    'accounting.BankAccountsApi.listBankAccounts': (_input: Record<string, unknown>, persona?: string) =>
      persona === 'controller' ? { accounts: [ACCOUNT] } : { ok: false },
    'accounting.AccountingPeriodsApi.getBankReconciliationPolicy': () => ({ currency: 'USD' }),
    'accounting.BankStatementsApi.listBankStatements': () => ({ statements }),
    'accounting.FinancialReportingApi.generateGeneralLedger': () => gl(ledger),
  });

  it('reads last Sunday as the end of last week', () => {
    expect(lastSunday('2026-03-16')).toBe('2026-03-15');
    expect(lastSunday('2026-03-17')).toBe('2026-03-15');
    expect(lastSunday('2026-03-15')).toBe('2026-03-08');
  });

  it('classifies ledger lines by what posted them', () => {
    expect(bankItemKind({ amount: 900, sourceEventType: 'BANK_DEPOSIT' })).toBe('CASH_DEPOSIT');
    expect(bankItemKind({ amount: 300, sourceEventType: 'PAYMENT_RECEIVED', description: 'Check 1042' })).toBe('CUSTOMER_CHECK');
    expect(bankItemKind({ amount: 300, sourceEventType: 'PAYMENT_RECEIVED' })).toBe('CUSTOMER_TRANSFER');
    expect(bankItemKind({ amount: -450, sourceEventType: 'AP_PAYMENT' })).toBe('VENDOR_PAYMENT');
    expect(bankItemKind({ amount: 5, sourceEventType: 'MANUAL' })).toBe('OTHER');
    expect(bankLedgerLines(gl([line('2026-03-10', -12.5, 'AP_PAYMENT', 'JE-2')]))).toEqual([
      { date: '2026-03-10', amount: -12.5, sourceEventType: 'AP_PAYMENT', description: undefined, entryNumber: 'JE-2', runningBalance: undefined },
    ]);
  });

  it('continues from the latest statement and hands over the statement to key in, read as the controller', async () => {
    const { lookup, calls } = fakeLookup(
      answers(
        [{ statementId: 's-1', status: 'COMMITTED', startDate: new Date('2026-03-09'), endDate: new Date('2026-03-15'), closingBalance: 51_000 }],
        [line('2026-03-12', 400, 'BANK_DEPOSIT', 'JE-1'), line('2026-03-18', 900, 'BANK_DEPOSIT', 'JE-3'), line('2026-03-20', -250, 'AP_PAYMENT', 'JE-4')],
      ),
    );
    // Tuesday 03-24: last week ran 03-16 to 03-22, a week keyed in by hand.
    const facts = await prepareRoutine('bank-statement', lookup, { ...ACCT, date: '2026-03-24' });

    expect(facts[0]).toMatch(/^acct is refused \(403\) on the bank accounts, statements and reconciliations; controller can read it/);
    expect(calls.find((call) => call.operationId === 'accounting.FinancialReportingApi.generateGeneralLedger')).toMatchObject({
      input: { accountId: 'gl-1000', startDate: '2026-03-11', endDate: '2026-03-22' },
      persona: 'controller',
    });
    expect(facts[1]).toContain('Cash (code 1000, glAccountId gl-1000), 2026-03-16 to 2026-03-22, opening 51000.00');
    expect(facts[1]).toContain('accounting.BankStatementsApi.createBankStatement with sdk_call as persona "controller" with exactly this input: ');
    const body = JSON.parse(facts[1].split('exactly this input: ')[1].split(' Enter it exactly')[0]) as {
      bankStatementCreateRequest: { glAccountId: string; gapAcknowledgement?: string; statement: Record<string, unknown>; transactions: Array<Record<string, unknown>> };
    };
    expect(body.bankStatementCreateRequest.glAccountId).toBe('gl-1000');
    expect(body.bankStatementCreateRequest.gapAcknowledgement).toBeUndefined();
    expect(body.bankStatementCreateRequest.statement).toMatchObject({ startDate: '2026-03-16', endDate: '2026-03-22', openingBalance: 51_000 });
    // The 03-12 deposit cleared on 03-13, inside the previous statement's period.
    expect(body.bankStatementCreateRequest.transactions.map((entry) => entry['reference'])).toEqual(['JE-3']);
    expect(facts[1]).toContain('Not yet cleared by the bank (1): JE-4 -250.00 (clears 2026-03-24).');
  });

  it('hands over the statement as a file to import in the other weeks', async () => {
    const { lookup } = fakeLookup(
      answers(
        [{ statementId: 's-1', status: 'COMMITTED', endDate: new Date('2026-03-08'), closingBalance: 51_000 }],
        [line('2026-03-11', 900, 'BANK_DEPOSIT', 'JE-3')],
      ),
    );
    const [, fact] = await prepareRoutine('bank-statement', lookup, ACCT);
    expect(fact).toContain('comes as a file. Upload it: call accounting.BankImportsApi.createBankImport');
    const body = JSON.parse(fact.split('exactly this input: ')[1].split(' Then read the import')[0]) as {
      bankImportCreateRequest: { content: string; formatCode: string; statement: Record<string, unknown> };
    };
    expect(body.bankImportCreateRequest.formatCode).toBe('CSV');
    expect(Buffer.from(body.bankImportCreateRequest.content, 'base64').toString('utf8')).toContain('2026-03-12,DEPOSIT,900.00,JE-3');
    expect(body.bankImportCreateRequest.statement).toEqual({ startDate: '2026-03-09', endDate: '2026-03-15', openingBalance: 51_000, closingBalance: 51_900 });
    expect(fact).toContain('commit it (commitBankImport)');
  });

  it('puts a first opening balance on the books before the first statement', async () => {
    const { lookup } = fakeLookup(answers([], [line('2026-03-11', 900, 'BANK_DEPOSIT', 'JE-3')]));
    const [, fact] = await prepareRoutine('bank-statement', lookup, ACCT);

    expect(fact).toContain('has no opening balance on the books. Put it on first: call accounting.BankAccountsApi.establishBankOpeningBalance');
    expect(fact).toContain('"asOfDate":"2026-03-08","currencyCode":"USD","statementBalance":50000');
    expect(fact).toContain('"gapAcknowledgement":"First statement for account 1000');
    expect(fact).toContain('"openingBalance":50000');
  });

  it('continues a first statement from an opening balance already on the books', async () => {
    const { lookup } = fakeLookup(
      answers([], [line('2026-03-01', 50_000, 'OPENING_BALANCE', 'JE-0', 50_000), line('2026-03-11', 900, 'BANK_DEPOSIT', 'JE-3', 50_900)]),
    );
    const [, fact] = await prepareRoutine('bank-statement', lookup, ACCT);

    expect(fact).not.toContain('establishBankOpeningBalance');
    expect(fact).toContain('2026-03-02 to 2026-03-15, opening 50000.00');
  });

  it('enters nothing for a week where nothing cleared', async () => {
    const { lookup } = fakeLookup(
      answers([{ statementId: 's-1', status: 'COMMITTED', endDate: new Date('2026-03-08'), closingBalance: 50_000 }], []),
    );
    const [, fact] = await prepareRoutine('bank-statement', lookup, ACCT);
    expect(fact).toContain('nothing cleared the bank from 2026-03-09 to 2026-03-15');
    expect(fact).not.toContain('createBankStatement');
  });

  it('skips an account whose statements already reach last Sunday', async () => {
    const { lookup } = fakeLookup(answers([{ statementId: 's-2', status: 'COMMITTED', endDate: new Date('2026-03-15'), closingBalance: 1 }], []));
    const [, fact] = await prepareRoutine('bank-statement', lookup, ACCT);
    expect(fact).toContain('statements already cover last week (through 2026-03-15). Nothing to enter; skip it.');
  });
});

describe('prepareRoutine: bank reconciliation', () => {
  const CONTROLLER: RoutineContext = { persona: 'controller', roleMode: true, date: '2026-03-16', timeZone: 'America/New_York' };
  const statement = { statementId: 's-1', status: 'COMMITTED', startDate: new Date('2026-03-09'), endDate: new Date('2026-03-15'), openingBalance: 100, closingBalance: 150, bankTransactionCount: 3 };
  const run = async (reconciliations: unknown[], statements: unknown[] = [statement]) => {
    const { lookup } = fakeLookup({
      'accounting.BankAccountsApi.listBankAccounts': () => ({ accounts: [{ glAccountId: 'gl-1000', accountCode: '1000', accountName: 'Cash' }] }),
      'accounting.BankStatementsApi.listBankStatements': () => ({ statements }),
      'accounting.BankReconciliationApi.listReconciliations': () => ({ reconciliations }),
    });
    return prepareRoutine('bank-reconciliation', lookup, CONTROLLER);
  };

  it('gives the create call for a statement with no reconciliation, and the adjustment types', async () => {
    const facts = await run([]);
    expect(facts[0]).toContain('the latest committed statement is statementId s-1, 2026-03-09 to 2026-03-15, opening 100, closing 150, 3 line(s).');
    expect(facts[0]).toContain('{"reconciliationCreateRequest":{"glAccountId":"gl-1000","statementId":"s-1"}}');
    expect(facts[1]).toContain('BANK_FEE for a service charge, INTEREST_EARNED for interest paid');
  });

  it('carries on with a reconciliation in progress', async () => {
    const [fact] = await run([{ reconciliationId: 'r-1', statementId: 's-1', status: 'IN_PROGRESS', countUnexplainedBank: 2, difference: 18 }]);
    expect(fact).toContain('Its reconciliation r-1 is IN_PROGRESS (countUnexplainedBank 2, difference 18): carry on with that one; do not open another.');
  });

  it('skips a statement already reconciled, and an account with no statement', async () => {
    expect((await run([{ reconciliationId: 'r-0', statementId: 's-1', status: 'FINALIZED' }]))[0]).toContain('is FINALIZED: nothing to do. Skip it.');
    expect((await run([], []))[0]).toContain('has no committed statement: there is nothing to reconcile. Skip it.');
  });
});

describe('routine preparation in the library', () => {
  it('is set on the crew, bank and vendor-bill routines, and the crew routines are per site', () => {
    const prepared = Object.fromEntries(SCENARIOS.filter((scenario) => scenario.prepare).map((scenario) => [scenario.id, scenario.prepare]));
    expect(prepared).toMatchObject({
      'crew-clock-in': 'crew',
      'crew-clock-out': 'crew',
      'lunch-out': 'crew',
      'lunch-back': 'crew',
      'timekeeping-review': 'crew',
      'vendor-bills': 'vendor-bills',
      'weekly-bank-statement': 'bank-statement',
      'weekly-bank-reconciliation': 'bank-reconciliation',
      'monthly-bank-reconciliation': 'bank-accounts',
    });
    for (const scenario of SCENARIOS.filter((entry) => entry.prepare === 'crew')) {
      expect([scenario.id, scenario.perSite]).toEqual([scenario.id, true]);
    }
  });

  it('renders facts as the brief\'s closing list, and nothing when there are none', () => {
    expect(renderFacts([])).toBe('');
    expect(renderFacts(['a', 'b'])).toMatch(/^\n\nThe reading this task starts with has been done for you, just now\. .*\n- a\n- b$/);
  });

  it('says outright when nobody has an open session, so there is nothing to clock out', async () => {
    const { lookup } = fakeLookup({
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability': () => [{ personId: 'p-1', firstName: 'Amber', lastName: 'Nguyen', role: 'TECHNICIAN', assignmentStatus: 'ACTIVE' }],
      'people.WorkSessionsAPIApi.getCurrentWorkSession': () => ({ personId: 'p-1', clockState: 'CLOCKED_OUT' }),
    });
    const [facts] = await prepareRoutine('crew', lookup, CONTEXT);
    expect(facts).toMatch(/In all: 1 CLOCKED_OUT\. Nobody here has an open work session right now\.$/);
  });
});
