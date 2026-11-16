import type { Lookup } from '../day/prepare';
import { SCENARIOS } from '../scenarios/library';
import { prepareRoutine, renderFacts, type RoutineContext } from './prepareRoutine';

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
      'weekly-bank-statement': 'bank-accounts',
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
