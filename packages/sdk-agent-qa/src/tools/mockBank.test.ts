import { addBusinessDays, bankStatementInputSchema, buildBankStatement, mockBankTool, requestIdTool, statementCsv, uuidv7, type LedgerItem } from './mockBank';

/** The week of Monday 9 to Sunday 15 March 2026. */
const WEEK = { account: '1010', periodStart: '2026-03-09', periodEnd: '2026-03-15', openingBalance: 50_000 };
const item = (date: string, amount: number, kind: LedgerItem['kind'], reference?: string): LedgerItem => ({ date, amount, kind, reference });
const sum = (amounts: number[]): number => Math.round(amounts.reduce((total, amount) => total + amount * 100, 0)) / 100;

describe('addBusinessDays', () => {
  it('skips the weekend', () => {
    expect(addBusinessDays('2026-03-12', 1)).toBe('2026-03-13'); // Thursday → Friday
    expect(addBusinessDays('2026-03-13', 1)).toBe('2026-03-16'); // Friday → Monday
    expect(addBusinessDays('2026-03-13', 2)).toBe('2026-03-17');
  });

  it('treats something recorded at the weekend as arriving on Monday', () => {
    expect(addBusinessDays('2026-03-14', 0)).toBe('2026-03-16');
    expect(addBusinessDays('2026-03-14', 1)).toBe('2026-03-17');
  });
});

describe('buildBankStatement', () => {
  it('ties: opening balance plus every line is the closing balance, to the cent', () => {
    const statement = buildBankStatement({
      ...WEEK,
      items: [
        item('2026-03-09', 1234.56, 'CASH_DEPOSIT', 'DEP-1'),
        item('2026-03-10', 0.1, 'CUSTOMER_TRANSFER', 'TRF-1'),
        item('2026-03-10', 0.2, 'CUSTOMER_TRANSFER', 'TRF-2'),
        item('2026-03-10', -987.65, 'VENDOR_PAYMENT', 'PAY-1'),
      ],
    });
    const { openingBalance, closingBalance } = statement.statement;
    expect(closingBalance).toBe(sum([openingBalance, ...statement.transactions.map((line) => line.signedAmount)]));
    expect(statement.transactions.every((line) => Number.isInteger(Math.round(line.signedAmount * 100)))).toBe(true);
  });

  it('shows a check two business days after the shop received it, and a transfer the next', () => {
    const statement = buildBankStatement({
      ...WEEK,
      items: [item('2026-03-09', 400, 'CUSTOMER_CHECK', '10457'), item('2026-03-09', 250, 'CUSTOMER_TRANSFER', 'TRF-88')],
    });
    expect(statement.transactions).toEqual([
      { date: '2026-03-10', signedAmount: 250, description: 'INCOMING TRANSFER', reference: 'TRF-88', checkNumber: undefined },
      { date: '2026-03-11', signedAmount: 400, description: 'CHECK DEPOSIT', reference: '10457', checkNumber: '10457' },
    ]);
  });

  it('leaves off what has not cleared by the end of the period, and says when it will', () => {
    const statement = buildBankStatement({
      ...WEEK,
      items: [
        item('2026-03-12', 400, 'CUSTOMER_CHECK', '10458'), // Thursday: clears Monday
        item('2026-03-13', 300, 'CUSTOMER_TRANSFER', 'TRF-89'), // Friday: clears Monday
        item('2026-03-12', -1500, 'VENDOR_PAYMENT', 'PAY-7'), // Thursday ACH: leaves Monday
        item('2026-03-11', 200, 'CUSTOMER_CHECK', '10459'), // Wednesday: clears Friday, in the period
      ],
    });
    expect(statement.transactions.map((line) => line.reference)).toEqual(['10459']);
    expect(statement.notYetCleared.map((entry) => [entry.reference, entry.clearsOn])).toEqual([
      ['10458', '2026-03-16'],
      ['TRF-89', '2026-03-16'],
      ['PAY-7', '2026-03-16'],
    ]);
    expect(statement.notYetCleared[0].why).toMatch(/deposit in transit/);
    expect(statement.notYetCleared[2].why).toMatch(/outstanding/);
    expect(statement.statement.closingBalance).toBe(50_200);
  });

  it('puts every item on exactly one statement, however the weeks fall', () => {
    const items = [
      item('2026-03-06', 100, 'CUSTOMER_CHECK', 'A'), // Friday before: clears Tuesday the 10th
      item('2026-03-05', 110, 'CUSTOMER_TRANSFER', 'B'), // clears Friday the 6th: an earlier statement
      item('2026-03-12', 120, 'CUSTOMER_CHECK', 'C'), // clears Monday the 16th: the next statement
      item('2026-03-13', -130, 'VENDOR_PAYMENT', 'D'), // clears Tuesday the 17th: the next statement
      item('2026-03-10', 140, 'CASH_DEPOSIT', 'E'),
    ];
    const thisWeek = buildBankStatement({ ...WEEK, items });
    const nextWeek = buildBankStatement({ account: '1010', periodStart: '2026-03-16', periodEnd: '2026-03-22', openingBalance: thisWeek.statement.closingBalance, items });
    const lastWeek = buildBankStatement({ account: '1010', periodStart: '2026-03-02', periodEnd: '2026-03-08', openingBalance: 0, items });

    expect(thisWeek.transactions.map((line) => line.reference).sort()).toEqual(['A', 'E']);
    expect(thisWeek.clearedEarlier.map((entry) => entry.reference)).toEqual(['B']);
    expect(nextWeek.transactions.map((line) => line.reference).sort()).toEqual(['C', 'D']);
    expect(lastWeek.transactions.map((line) => line.reference)).toEqual(['B']);
    // The statements chain: next week opens where this week closed.
    expect(nextWeek.statement.openingBalance).toBe(thisWeek.statement.closingBalance);
  });

  it('adds a service charge and interest on the statement that contains the last business day of the month', () => {
    const march = buildBankStatement({ account: '1010', periodStart: '2026-03-30', periodEnd: '2026-04-05', openingBalance: 1000, items: [] });
    expect(march.bankOnly.map((line) => [line.date, line.description, line.reference])).toEqual([
      ['2026-03-31', 'MONTHLY SERVICE CHARGE', 'FEE-2026-03'],
      ['2026-03-31', 'INTEREST PAID', 'INT-2026-03'],
    ]);
    expect(march.bankOnly[0].signedAmount).toBe(-18);
    expect(march.bankOnly[1].signedAmount).toBeGreaterThan(0);
    expect(march.statement.closingBalance).toBe(sum([1000, ...march.bankOnly.map((line) => line.signedAmount)]));
    expect(buildBankStatement({ ...WEEK, items: [] }).bankOnly).toEqual([]);
  });

  it('charges each month once, whichever statement its last business day falls on', () => {
    // A long first statement covering two month ends is charged for both.
    const long = buildBankStatement({ account: '1010', periodStart: '2026-01-15', periodEnd: '2026-03-10', openingBalance: 0, items: [] });
    expect(long.bankOnly.map((line) => line.reference)).toEqual(['FEE-2026-01', 'INT-2026-01', 'FEE-2026-02', 'INT-2026-02']);
    // Consecutive weeks around a month end: exactly one of them carries the charge.
    const weeks = [
      ['2026-05-18', '2026-05-24'],
      ['2026-05-25', '2026-05-31'],
      ['2026-06-01', '2026-06-07'],
    ].map(([periodStart, periodEnd]) => buildBankStatement({ account: '1010', periodStart, periodEnd, openingBalance: 0, items: [] }));
    expect(weeks.map((statement) => statement.bankOnly.filter((line) => line.reference?.startsWith('FEE')).length)).toEqual([0, 1, 0]);
    // May 31 2026 is a Sunday: the charge lands on Friday the 29th.
    expect(weeks[1].bankOnly[0].date).toBe('2026-05-29');
  });

  it('sometimes counts a cash deposit a few dollars differently, and still ties', () => {
    const items = (): LedgerItem[] => [
      item('2026-03-09', 812.4, 'CASH_DEPOSIT', 'DEP-1'),
      item('2026-03-10', 640, 'CASH_DEPOSIT', 'DEP-2'),
      item('2026-03-10', 95, 'CUSTOMER_TRANSFER', 'TRF-1'),
    ];
    const outcomes = Array.from({ length: 30 }, (_, index) => buildBankStatement({ ...WEEK, account: `acct-${index}`, items: items() }));
    const withError = outcomes.filter((statement) => statement.bankError);
    expect(withError.length).toBeGreaterThan(3);
    expect(withError.length).toBeLessThan(27);
    for (const statement of withError) {
      const { booksAmount, bankAmount } = statement.bankError!;
      expect(Math.abs(bankAmount - booksAmount)).toBeGreaterThanOrEqual(1);
      expect(Math.abs(bankAmount - booksAmount)).toBeLessThanOrEqual(9);
      expect(statement.statement.closingBalance).toBe(sum([50_000, ...statement.transactions.map((line) => line.signedAmount)]));
    }
    // Checks and transfers are never the ones miscounted: the customer's paper says what they are.
    expect(withError.every((statement) => statement.bankError?.reference?.startsWith('DEP-'))).toBe(true);
  });

  it('is the same statement every time for the same account and period', () => {
    const input = { ...WEEK, items: [item('2026-03-09', 812.4, 'CASH_DEPOSIT', 'DEP-1'), item('2026-03-10', 640, 'CASH_DEPOSIT', 'DEP-2'), item('2026-03-10', 95, 'CUSTOMER_TRANSFER', 'T')] };
    expect(buildBankStatement(structuredClone(input))).toEqual(buildBankStatement(structuredClone(input)));
  });

  it('ignores zero entries and refuses a backwards period', () => {
    expect(buildBankStatement({ ...WEEK, items: [item('2026-03-09', 0, 'OTHER')] }).transactions).toEqual([]);
    expect(() => buildBankStatement({ ...WEEK, periodEnd: '2026-03-01', items: [] })).toThrow(/before periodStart/);
  });
});

describe('statementCsv', () => {
  it('is the file the bank would offer, quoted where it must be', () => {
    const statement = buildBankStatement({ ...WEEK, items: [{ date: '2026-03-09', amount: 250, kind: 'CUSTOMER_TRANSFER', reference: 'TRF-88', description: 'ACME, "Inc"' }] });
    expect(statementCsv(statement)).toBe('date,description,amount,reference,checkNumber\n2026-03-10,"INCOMING TRANSFER ACME, ""Inc""",250.00,TRF-88,\n');
  });
});

describe('the tools', () => {
  it('returns the statement ready to enter, with its file, request ids and what the bank left off — but not the bank\'s error', async () => {
    const tool = mockBankTool(() => Date.UTC(2026, 2, 16, 12));
    const input = tool.schema.parse({
      ...WEEK,
      items: [
        { date: '2026-03-09', amount: 812.4, kind: 'CASH_DEPOSIT', reference: 'DEP-1' },
        { date: '2026-03-13', amount: 300, kind: 'CUSTOMER_CHECK', reference: '10460' },
      ],
    });
    const result = (await tool.execute(input)) as Record<string, any>;
    expect(result['statement']).toMatchObject({ startDate: '2026-03-09', endDate: '2026-03-15', openingBalance: 50_000 });
    expect(['file-import', 'keyed-by-hand']).toContain(result['enterIt']);
    expect(Buffer.from(result['file'].content, 'base64').toString('utf8')).toMatch(/^date,description,amount,reference,checkNumber\n2026-03-10,DEPOSIT,/);
    expect(result['file']).toMatchObject({ formatCode: 'CSV', signConvention: 'SIGNED_AMOUNT', contentType: 'text/csv' });
    expect(result['requestIds']).toHaveLength(3);
    expect(new Set(result['requestIds']).size).toBe(3);
    expect(result['notOnThisStatement']).toEqual([expect.objectContaining({ reference: '10460', clearsOn: '2026-03-17' })]);
    // The bookkeeper is not told where the bank went wrong: finding that is the reconciliation.
    expect(JSON.stringify(result)).not.toMatch(/bankError|booksAmount/);
  });

  it('alternates between entering by file and by hand from one week to the next', async () => {
    const tool = mockBankTool();
    const how = async (start: string, end: string): Promise<string> =>
      ((await tool.execute({ account: 'a', periodStart: start, periodEnd: end, openingBalance: 0, items: [] })) as { enterIt: string }).enterIt;
    expect(await how('2026-03-09', '2026-03-15')).not.toBe(await how('2026-03-16', '2026-03-22'));
  });

  it('rejects a malformed request before the bank sees it', () => {
    expect(bankStatementInputSchema.safeParse({ ...WEEK, items: [{ date: '09/03/2026', amount: 1, kind: 'CASH_DEPOSIT' }] }).success).toBe(false);
    expect(bankStatementInputSchema.safeParse({ ...WEEK, items: [{ date: '2026-03-09', amount: 1, kind: 'WIRE' }] }).success).toBe(false);
  });

  it('mints request ids that are UUID version 7, unique and time-ordered', async () => {
    const tool = requestIdTool(() => Date.UTC(2026, 2, 16));
    const { requestIds } = (await tool.execute(tool.schema.parse({ count: 5 }))) as { requestIds: string[] };
    expect(requestIds).toHaveLength(5);
    expect(new Set(requestIds).size).toBe(5);
    for (const id of requestIds) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect([...requestIds].sort()).toEqual(requestIds);
    expect(uuidv7(Date.UTC(2026, 0, 1)) < uuidv7(Date.UTC(2026, 0, 2))).toBe(true);
  });
});
