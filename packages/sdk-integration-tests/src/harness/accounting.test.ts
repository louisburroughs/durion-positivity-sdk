import type { JournalEntryResponse } from '@durion-sdk/accounting';
import { journalEntryOf, serverDate, shapeOf, wallDate } from './accounting';
import type { DomainClients } from './personas';

describe('accounting read-back helpers', () => {
  it('reduces a loss entry to its accounts, totals and the signed 1300 movement', () => {
    const entry: JournalEntryResponse = {
      lines: [
        { accountCode: '5100', debitAmount: 50, creditAmount: 0 },
        { accountCode: '1300', debitAmount: 0, creditAmount: 50 },
      ],
    };

    expect(shapeOf(entry)).toEqual({
      lineCount: 2,
      debitAccounts: ['5100'],
      creditAccounts: ['1300'],
      totalDebits: 50,
      totalCredits: 50,
      inventoryNet: -50,
    });
  });

  it('signs a gain as an increase on 1300', () => {
    const entry: JournalEntryResponse = {
      lines: [
        { accountCode: '1300', debitAmount: 37.5 },
        { accountCode: '5100', creditAmount: 37.5 },
      ],
    };

    expect(shapeOf(entry).inventoryNet).toBe(37.5);
    expect(shapeOf({}).lineCount).toBe(0);
  });

  it('reads a zone-less transaction date back as the wall date the server wrote', () => {
    // The generated client parses a LocalDateTime string as local time.
    expect(wallDate(new Date('2026-09-25T23:30:00'))).toBe('2026-09-25');
    expect(wallDate(new Date('2026-01-01T00:00:00'))).toBe('2026-01-01');
  });

  it('dates an instant in the backend zone, UTC', () => {
    expect(serverDate(new Date('2026-09-25T23:30:00Z'))).toBe('2026-09-25');
    expect(serverDate(new Date('2026-09-26T00:30:00+02:00'))).toBe('2026-09-25');
  });
});

describe('journalEntryOf', () => {
  const clientsWith = (entry: JournalEntryResponse, codes: Record<string, string>) => {
    const getGLAccount = jest.fn(async ({ glAccountId }: { glAccountId: string }) => ({
      accountCode: codes[glAccountId],
    }));
    const clients = {
      accounting: {
        journalEntriesApi: { getJournalEntry: jest.fn(async () => structuredClone(entry)) },
        glAccountsApi: { getGLAccount },
      },
    } as unknown as DomainClients;
    return { clients, getGLAccount };
  };

  it('fills a missing account code from the line\'s GL account, once per account', async () => {
    const { clients, getGLAccount } = clientsWith(
      {
        lines: [
          { glAccountId: 'gl-shrink-test', debitAmount: 50 },
          { glAccountId: 'gl-asset-test', creditAmount: 50 },
        ],
      },
      { 'gl-shrink-test': '5100', 'gl-asset-test': '1300' },
    );

    const first = await journalEntryOf(clients, 'je-1');
    expect(first.lines?.map((line) => line.accountCode)).toEqual(['5100', '1300']);
    expect(getGLAccount).toHaveBeenCalledTimes(2);

    // A second entry on the same accounts is served from the cache.
    await journalEntryOf(clients, 'je-2');
    expect(getGLAccount).toHaveBeenCalledTimes(2);
  });

  it('keeps an account code the backend already sent, without a lookup', async () => {
    const { clients, getGLAccount } = clientsWith(
      { lines: [{ glAccountId: 'gl-sent-test', accountCode: '5000', debitAmount: 1 }] },
      {},
    );

    const entry = await journalEntryOf(clients, 'je-3');
    expect(entry.lines?.[0].accountCode).toBe('5000');
    expect(getGLAccount).not.toHaveBeenCalled();
  });
});
