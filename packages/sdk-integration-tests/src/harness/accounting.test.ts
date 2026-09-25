import type { JournalEntryResponse } from '@durion-sdk/accounting';
import { serverDate, shapeOf, wallDate } from './accounting';

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
