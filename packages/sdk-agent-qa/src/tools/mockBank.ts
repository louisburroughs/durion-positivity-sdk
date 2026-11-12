/**
 * The bank.
 *
 * Alpha has books but no bank, and a reconciliation needs the bank's side of
 * the story. This plays that part: given what the ledger says moved through a
 * bank account, it produces the statement a bank would have sent for a period.
 *
 * It is code, not a prompt, because a bank is exact and indifferent: every
 * line clears on a rule, and opening balance plus activity equals closing
 * balance to the cent — a statement that does not tie is refused on intake. The
 * agent's part is the bookkeeper's: read the ledger, hand over what it found,
 * and enter the statement that comes back.
 *
 * What makes it worth reconciling is that the bank and the books disagree in
 * the ordinary ways:
 *
 * - **Timing.** A check or transfer is recorded at the shop on the day it is
 *   received, with its number; the bank shows it only once it clears. An item
 *   that has not cleared by the end of the period is left off — a deposit in
 *   transit or an outstanding payment — and appears on a later statement.
 * - **Bank-only lines.** A service charge and a little interest at month end,
 *   which the books learn of from the statement.
 * - **One error.** Now and then the bank counts a cash deposit a few dollars
 *   differently from the slip.
 *
 * Clearing is a pure function of an item's date and kind, so an item lands on
 * exactly one statement however the periods are cut.
 */
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import type { QaTool } from './toolkit';

export const BANK_ITEM_KINDS = ['CASH_DEPOSIT', 'CUSTOMER_CHECK', 'CUSTOMER_TRANSFER', 'VENDOR_PAYMENT', 'OTHER'] as const;
export type BankItemKind = (typeof BANK_ITEM_KINDS)[number];

/** Business days between the books recording an item and the bank showing it. */
export const CLEARING_DAYS: Record<BankItemKind, number> = {
  /** Night-drop cash is counted the next business day. */
  CASH_DEPOSIT: 1,
  /** A paper check is deposited and then has to clear. */
  CUSTOMER_CHECK: 2,
  CUSTOMER_TRANSFER: 1,
  /** An ACH leaves the account a couple of days after it is sent. */
  VENDOR_PAYMENT: 2,
  OTHER: 0,
};

export interface LedgerItem {
  /** YYYY-MM-DD the books recorded it. */
  date: string;
  /** Signed, positive = money into the account. */
  amount: number;
  kind: BankItemKind;
  /** Check number, transfer number, deposit or payment reference. */
  reference?: string;
  description?: string;
}

export interface StatementLine {
  date: string;
  signedAmount: number;
  description: string;
  reference?: string;
  checkNumber?: string;
}

export interface BankStatementInput {
  /** Any stable label for the account; it seeds the bank's small variations. */
  account: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  items: LedgerItem[];
}

export interface BankStatement {
  statement: { startDate: string; endDate: string; openingBalance: number; closingBalance: number };
  transactions: StatementLine[];
  /** Ledger items the bank has not shown yet, with the day each will clear. */
  notYetCleared: Array<LedgerItem & { clearsOn: string; why: string }>;
  /** Ledger items that cleared before this period began: they belong to an earlier statement. */
  clearedEarlier: LedgerItem[];
  /** Lines the bank added that the books do not have. */
  bankOnly: StatementLine[];
  /** A line where the bank's amount differs from the books', when there is one. */
  bankError?: { reference?: string; booksAmount: number; bankAmount: number };
}

const cents = (amount: number): number => Math.round(amount * 100);
const money = (minor: number): number => minor / 100;
const toDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const toIso = (date: Date): string => date.toISOString().slice(0, 10);

export function addBusinessDays(iso: string, days: number): string {
  const date = toDate(iso);
  // A weekend entry is not seen by the bank until Monday, even with no delay.
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  for (let left = days; left > 0; ) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      left -= 1;
    }
  }
  return toIso(date);
}

/** The last weekday on or before the last day of the month containing `iso`. */
function lastBusinessDayOfMonth(iso: string): string {
  const date = toDate(iso);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  while (last.getUTCDay() === 0 || last.getUTCDay() === 6) {
    last.setUTCDate(last.getUTCDate() - 1);
  }
  return toIso(last);
}

/** A stable number in [0, 1) from text: the bank's "randomness" is the same every time for the same statement. */
function chance(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0) / 0x1_0000_0000;
}

const DESCRIPTIONS: Record<BankItemKind, string> = {
  CASH_DEPOSIT: 'DEPOSIT',
  CUSTOMER_CHECK: 'CHECK DEPOSIT',
  CUSTOMER_TRANSFER: 'INCOMING TRANSFER',
  VENDOR_PAYMENT: 'ACH DEBIT',
  OTHER: 'MISC',
};

export function buildBankStatement(input: BankStatementInput): BankStatement {
  const { periodStart, periodEnd } = input;
  if (periodEnd < periodStart) {
    throw new Error('periodEnd is before periodStart');
  }
  const seed = `${input.account}|${periodStart}|${periodEnd}`;
  const cleared: Array<{ item: LedgerItem; on: string }> = [];
  const notYetCleared: BankStatement['notYetCleared'] = [];
  const clearedEarlier: LedgerItem[] = [];

  for (const item of input.items) {
    if (cents(item.amount) === 0) {
      continue; // a bank has no zero lines
    }
    const on = addBusinessDays(item.date, CLEARING_DAYS[item.kind]);
    if (on > periodEnd) {
      notYetCleared.push({
        ...item,
        clearsOn: on,
        why: item.amount > 0 ? 'deposit in transit: received, not yet shown by the bank' : 'outstanding: sent, not yet cleared',
      });
    } else if (on < periodStart) {
      clearedEarlier.push(item);
    } else {
      cleared.push({ item, on });
    }
  }

  // Now and then the bank's count of a cash deposit differs from the slip by a few dollars.
  let bankError: BankStatement['bankError'];
  const deposits = cleared.filter((entry) => entry.item.kind === 'CASH_DEPOSIT' && cents(entry.item.amount) > 2000);
  if (cleared.length >= 3 && deposits.length > 0 && chance(`${seed}|error?`) < 0.5) {
    const target = deposits[Math.floor(chance(`${seed}|which`) * deposits.length)];
    const off = (1 + Math.floor(chance(`${seed}|by`) * 9)) * 100 * (chance(`${seed}|sign`) < 0.5 ? -1 : 1);
    const bankAmount = money(cents(target.item.amount) + off);
    bankError = { reference: target.item.reference, booksAmount: target.item.amount, bankAmount };
    target.item = { ...target.item, amount: bankAmount };
  }

  const transactions: StatementLine[] = cleared.map(({ item, on }) => ({
    date: on,
    signedAmount: money(cents(item.amount)),
    description: `${DESCRIPTIONS[item.kind]}${item.description ? ` ${item.description}` : ''}`.slice(0, 120),
    reference: item.reference,
    checkNumber: item.kind === 'CUSTOMER_CHECK' ? item.reference : undefined,
  }));

  // Month end brings the bank's own lines. A period can straddle months (or, for a long first
  // statement, cover several), so every month it touches is looked at.
  const bankOnly: StatementLine[] = [];
  const cursor = toDate(`${periodStart.slice(0, 7)}-01`);
  for (; toIso(cursor) <= periodEnd; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    const monthEnd = lastBusinessDayOfMonth(toIso(cursor));
    if (monthEnd >= periodStart && monthEnd <= periodEnd) {
      const month = monthEnd.slice(0, 7);
      bankOnly.push(
        { date: monthEnd, signedAmount: -18, description: 'MONTHLY SERVICE CHARGE', reference: `FEE-${month}` },
        {
          date: monthEnd,
          signedAmount: money(100 + Math.floor(chance(`${input.account}|${month}|interest`) * 900)),
          description: 'INTEREST PAID',
          reference: `INT-${month}`,
        },
      );
    }
  }

  const all = [...transactions, ...bankOnly].sort((a, b) => a.date.localeCompare(b.date));
  const closing = all.reduce((sum, line) => sum + cents(line.signedAmount), cents(input.openingBalance));
  return {
    statement: {
      startDate: periodStart,
      endDate: periodEnd,
      openingBalance: money(cents(input.openingBalance)),
      closingBalance: money(closing),
    },
    transactions: all,
    notYetCleared,
    clearedEarlier,
    bankOnly,
    bankError,
  };
}

const csvCell = (value: string | number | undefined): string => {
  const text = value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The statement as the file a bank's website would offer for download. */
export function statementCsv(statement: BankStatement): string {
  const rows = statement.transactions.map((line) =>
    [line.date, line.description, line.signedAmount.toFixed(2), line.reference, line.checkNumber].map(csvCell).join(','),
  );
  return ['date,description,amount,reference,checkNumber', ...rows].join('\n') + '\n';
}

/** A UUID version 7: time-ordered, which the accounting intake requires of its request ids. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');

export const bankStatementInputSchema = z.strictObject({
  account: z.string().min(1).describe('The bank account, e.g. its GL account number or id'),
  periodStart: isoDay,
  periodEnd: isoDay,
  openingBalance: z.number().describe("The bank's balance at the start of the period: the previous statement's closing balance, or the opening balance for a first statement"),
  items: z
    .array(
      z.strictObject({
        date: isoDay.describe('The day the books recorded it'),
        amount: z.number().describe('Signed: positive is money into the bank account, negative is money out'),
        kind: z.enum(BANK_ITEM_KINDS),
        reference: z.string().optional().describe('Check number, transfer number, deposit or payment reference'),
        description: z.string().optional(),
      }),
    )
    .describe('Every entry on the bank account in the books from five days before periodStart through periodEnd'),
});

/**
 * The tool a bookkeeping task uses to get the bank's statement for a period.
 * @param now injected for tests
 */
export function mockBankTool(now: () => number = Date.now): QaTool {
  return {
    name: 'bank_statement',
    description:
      "Get the bank's statement for one account and period. Give it every entry the books show on the bank account, " +
      'including the five days before the period (items from then may have cleared in it). It returns the statement as the ' +
      'bank sent it — header, lines and the same lines as a CSV file — which will differ from the books: items not yet ' +
      'cleared are left off (they are listed separately so you know why), and the bank may add its own lines. Enter the ' +
      'statement exactly as returned; do not edit its amounts to make it agree with the books.',
    schema: bankStatementInputSchema,
    execute: async (input) => {
      const statement = buildBankStatement(input as BankStatementInput);
      const csv = statementCsv(statement);
      // Alternate how it is entered, so both intake paths get used: even ISO weeks by file, odd by hand.
      const week = Math.floor(toDate(statement.statement.endDate).getTime() / (7 * 86_400_000));
      return {
        statement: statement.statement,
        transactions: statement.transactions,
        enterIt: week % 2 === 0 ? 'file-import' : 'keyed-by-hand',
        file: {
          fileName: `statement-${statement.statement.startDate}-to-${statement.statement.endDate}.csv`,
          contentType: 'text/csv',
          formatCode: 'CSV',
          signConvention: 'SIGNED_AMOUNT',
          columnMapping: { date: 'date', description: 'description', amount: 'amount', reference: 'reference', checkNumber: 'checkNumber' },
          content: Buffer.from(csv, 'utf8').toString('base64'),
        },
        // Accounting's intake wants time-ordered request ids, which are not something to make up.
        requestIds: [uuidv7(now()), uuidv7(now() + 1), uuidv7(now() + 2)],
        notOnThisStatement: statement.notYetCleared,
        belongsToAnEarlierStatement: statement.clearedEarlier.length,
        addedByTheBank: statement.bankOnly,
      };
    },
  };
}

/** Mints request ids for accounting requests that require a UUIDv7. */
export function requestIdTool(now: () => number = Date.now): QaTool {
  let minted = 0;
  return {
    name: 'request_id',
    description:
      'Get fresh request ids (UUID version 7). Use one wherever an accounting request asks for a caller-generated UUIDv7 ' +
      'requestId; never invent one, and never reuse one for a different request.',
    schema: z.strictObject({ count: z.number().int().min(1).max(10).default(1) }),
    execute: async (input) => {
      const { count } = input as { count: number };
      return { requestIds: Array.from({ length: count }, () => uuidv7(now() + (minted += 1))) };
    },
  };
}
