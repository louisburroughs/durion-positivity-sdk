import type { AccountingEventResponse, JournalEntryResponse } from '@durion-sdk/accounting';
import { call } from './http';
import type { DomainClients } from './personas';
import { waitFor } from './waitFor';

/**
 * The accounting consequence of an inventory fact, read back through the REST
 * ingestion read model.
 *
 * pos-accounting consumes `inventory.adjustment.posted` and `inventory.scrap.posted`
 * off `inventory.events.v1` and writes one terminal `AccountingEvent` per fact:
 * `PROCESSED` with the journal entry it posted, or `SKIPPED` with
 * `UNCOSTED_FACT` when inventory could not cost the movement. The business id —
 * the adjustment id or the scrap id — is the record's `domainKeyId`, which
 * `listAccountingEvents` filters on, so a suite that holds the id it approved can
 * follow it to the ledger without a new endpoint
 * (durion `domains/accounting/SPEC-inventory-adjustment-gl-posting.md` §4.9, §6).
 *
 * Deliberately free of Jest: the year run's ports import from the harness under
 * plain ts-node, so the suites own the `expect`s and this module only reads.
 */

export const ADJUSTMENT_POSTED = 'inventory.adjustment.posted';
export const SCRAP_POSTED = 'inventory.scrap.posted';

/** Inventory Shrinkage: the debit of a loss, scrap or count shortfall. */
export const SHRINKAGE_ACCOUNT = '5100';
/** Inventory: the asset every on-hand change moves. */
export const INVENTORY_ACCOUNT = '1300';
/**
 * The credit of a count or adjustment gain. Owner decision D2 on
 * durion-positivity-backend#2186 seeds `ADJUSTMENT_GAIN` to 5100, so over and short
 * net in one account; a change of that decision is a change here.
 */
export const ADJUSTMENT_GAIN_ACCOUNT = '5100';

/** The statuses a Kafka-consumed fact ends in. It is never written FAILED or SUSPENDED. */
const TERMINAL = new Set<string>(['PROCESSED', 'SKIPPED']);

/** Every ingestion record for one business id, newest first as the endpoint returns them. */
export async function accountingEventsFor(
  clients: DomainClients,
  eventType: string,
  domainKeyId: string,
): Promise<AccountingEventResponse[]> {
  const page = await call(`listAccountingEvents ${eventType} ${domainKeyId}`, () =>
    clients.accounting.accountingEventsApi.listAccountingEvents({ eventType, domainKeyId, size: 50 }),
  );
  return page.content ?? [];
}

/**
 * Waits for the fact behind `domainKeyId` to reach a terminal ingestion record.
 *
 * The fact travels outbox → Kafka → consumer after the inventory call has
 * returned, so the record is polled for rather than read once. A timeout is a
 * failure, never a skip: an absent consumer, a producer that emitted nothing, and
 * a fact parked on the DLQ (a closed period, a missing mapping) all look the same
 * from here, and every one of them is a finding.
 */
export async function awaitAccountingEvent(
  clients: DomainClients,
  eventType: string,
  domainKeyId: string,
  timeoutMs: number,
): Promise<AccountingEventResponse> {
  return waitFor(
    async () => {
      const events = await accountingEventsFor(clients, eventType, domainKeyId);
      return events.find((event) => TERMINAL.has(String(event.status)));
    },
    {
      timeoutMs,
      intervalMs: 1_000,
      description: `a terminal ${eventType} ingestion record for ${domainKeyId}`,
    },
  );
}

/** GL account id → account code, stable for a run. */
const accountCodes = new Map<string, string>();

/**
 * A journal entry with every line's `accountCode` filled in.
 *
 * The line response declares `accountCode`, but pos-accounting's
 * `JournalEntryMapper.toLineResponse` sets only `glAccountId`, so the code
 * arrives empty (durion-positivity-backend#2238). A line missing it is resolved through `getGLAccount` —
 * the id is what the posting actually wrote, so the assertion loses nothing.
 */
export async function journalEntryOf(clients: DomainClients, journalEntryId: string): Promise<JournalEntryResponse> {
  const entry = await call(`getJournalEntry ${journalEntryId}`, () =>
    clients.accounting.journalEntriesApi.getJournalEntry({ journalEntryId }),
  );
  for (const line of entry.lines ?? []) {
    if (line.accountCode || !line.glAccountId) continue;
    const glAccountId = line.glAccountId;
    let code = accountCodes.get(glAccountId);
    if (code === undefined) {
      const account = await call(`getGLAccount ${glAccountId}`, () =>
        clients.accounting.glAccountsApi.getGLAccount({ glAccountId }),
      );
      code = account.accountCode ?? '?';
      accountCodes.set(glAccountId, code);
    }
    line.accountCode = code;
  }
  return entry;
}

/** A journal entry reduced to what a two-line posting is asserted on. */
export interface TwoLineShape {
  lineCount: number;
  debitAccounts: string[];
  creditAccounts: string[];
  totalDebits: number;
  totalCredits: number;
  /** Signed movement on 1300 Inventory: debits minus credits. */
  inventoryNet: number;
}

export function shapeOf(entry: JournalEntryResponse): TwoLineShape {
  const lines = entry.lines ?? [];
  const debits = lines.filter((line) => Number(line.debitAmount ?? 0) > 0);
  const credits = lines.filter((line) => Number(line.creditAmount ?? 0) > 0);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const inventory = lines.filter((line) => line.accountCode === INVENTORY_ACCOUNT);
  return {
    lineCount: lines.length,
    debitAccounts: debits.map((line) => line.accountCode ?? '?'),
    creditAccounts: credits.map((line) => line.accountCode ?? '?'),
    totalDebits: sum(debits.map((line) => Number(line.debitAmount))),
    totalCredits: sum(credits.map((line) => Number(line.creditAmount))),
    inventoryNet: sum(inventory.map((line) => Number(line.debitAmount ?? 0) - Number(line.creditAmount ?? 0))),
  };
}

/**
 * The calendar date of a journal entry's `transactionDate`.
 *
 * The backend holds it as a zone-less `LocalDateTime`, which the generated client
 * parses as the *test machine's* local time; the local getters therefore give back
 * exactly the wall-clock fields the server wrote, whatever zone this runs in.
 */
export function wallDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * The date an instant falls on in the backend's zone, which is UTC in every
 * deployment the suites run against: the consumer dates the entry
 * `LocalDateTime.ofInstant(occurredAt, clock.getZone())`.
 */
export function serverDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
