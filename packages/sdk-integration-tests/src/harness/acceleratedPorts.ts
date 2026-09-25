/**
 * The day runner's collaborators, backed by real SDK clients.
 *
 * The runner itself is pure-ish and unit-tested against fakes; this file is the
 * part that talks to a backend. Everything here is *assertive*: a step that the
 * backend refuses raises rather than logging and carrying on, which is the whole
 * difference between this and the seeder's simulators, that these are otherwise
 * modelled on.
 *
 * What a raise then costs is the day runner's decision, not this file's, and it
 * is not the same for every port:
 *
 *   - `ShiftPort.clockIn` and `MaintenancePort` end the virtual day, and with it
 *     the run. A shop that cannot staff itself writes no labor and no payroll,
 *     and a day carried on past that records work nobody was there to do.
 *   - `AppointmentPort.book` and `convertDue` are caught by the runner, recorded
 *     on the day's report and carried past. A day that cannot book its intake is
 *     a bad day, not a non-day, and these are the first two calls of every day —
 *     left fatal, one 409 ended a year that had already worked 39 good days. The
 *     failure still reaches `result.failures`, so Z2 fails the run at the end.
 *
 * Raise here regardless. Deciding that a refusal is survivable is the runner's
 * job, and a port that swallowed one would take the choice away from it.
 */
import { CreateScrapRequestReasonCodeEnum } from '@durion-sdk/inventory';
import { ListTimeEntriesStatusEnum } from '@durion-sdk/people';
import { SEED_VENDOR_ID } from '@durion-sdk/seeder';
import type { ReferenceCache } from '@durion-sdk/seeder';
import { readNumber, readString, requireField, type BuilderContext } from './builders';
import { call, formatError, isHttpStatus, readAllPages, retryWhileReplicating } from './http';
import type { DomainClients } from './personas';
import type { ShopCalendar } from './shopCalendar';
import {
  PartialProgressError,
  type AppointmentPort,
  type DiscoveryPort,
  type MaintenancePort,
  type ShiftPort,
} from './acceleratedDayRunner';
import { buildRoster, type StaffingView } from '../runs/shopFloorRoster';
import type { SiteRoster } from '../runs/shopFloorPlan';

const log = (message: string): void => console.log(`[accel] ${message}`);

/**
 * Sites with a usable dispatch board, as `shopFloorLoad` discovers them.
 *
 * Deliberately the same two reads and the same pure mapping: the board is the
 * source for positions because it lists every ACTIVE bay and mobile unit with the
 * open workorder holding it, and people availability is the side that knows a
 * person's role. A site whose board reports `dataQualityWarning` is dropped for
 * the day — placing work on a board that may be incomplete is how a double
 * booking happens, and `buildRoster` already refuses it.
 */
export function createDiscoveryPort(admin: DomainClients, manager: DomainClients): DiscoveryPort {
  return {
    async rosters(at: Date): Promise<SiteRoster[]> {
      const locations = await call('listLocations', () => admin.location.locationApi.listLocations());
      const rosters: SiteRoster[] = [];

      for (const location of locations) {
        const locationId = location.id;
        if (!locationId) {
          continue;
        }
        const code = location.code ?? locationId;

        let board;
        try {
          board = await manager.workorder.dailyDispatchBoardDashboardApi.getDispatchDashboard({ locationId });
        } catch (error) {
          log(`${code}: no dispatch board today — ${await formatError(error)}`);
          continue;
        }

        let staffing: StaffingView[];
        try {
          staffing = await admin.people.peopleAvailabilityApi.listPeopleAvailability({ locationId });
        } catch (error) {
          log(`${code}: no staffing today — ${await formatError(error)}`);
          continue;
        }

        // The board is aggregated for one date, and `at` is virtual time: the same
        // instant decides which PTO counts, so a technician on leave on the
        // *virtual* date is the one excluded.
        const outcome = buildRoster({ locationId, code, name: location.name ?? code }, board, staffing, at);
        if (outcome.kind === 'skipped') {
          log(`${code}: skipped — ${outcome.reason}`);
          continue;
        }
        if (outcome.roster.freePositions.length === 0 && outcome.roster.occupiedPositions.length === 0) {
          continue;
        }
        rosters.push(outcome.roster);
      }
      return rosters;
    },
  };
}

/**
 * The payroll clock: who is in the building, and for how long.
 *
 * Distinct from the workorder service's per-service labor timers — this is the
 * shift, and it is what makes a virtual day look like a worked day rather than a
 * burst of API traffic.
 */
export function createShiftPort(
  admin: DomainClients,
  manager: DomainClients,
  refs: ReferenceCache,
): ShiftPort {
  // Everyone the day might need. Drawn once: the roster the reference bootstrap
  // produced is stable for the run.
  const everyone = [
    ...new Set(
      [
        ...refs.employees.technicians,
        ...refs.employees.serviceWriters,
        refs.employees.manager,
        refs.employees.partsClerk,
      ].filter((id) => typeof id === 'string' && id.length > 0),
    ),
  ];
  let onTheClock: string[] = [];

  /**
   * Closes the given sessions in parallel, returning the ids actually closed.
   *
   * Parallel for the same reason the clock-out fan-out is — the backend stamps each
   * `endAtUtc` when its own call runs — and tolerant of the 404 that means the session was
   * already closed, so a retry after a partial failure is safe.
   */
  const closeSessions = async (
    personIds: readonly string[],
  ): Promise<{ closed: string[]; failures: string[] }> => {
    const outcomes = await Promise.allSettled(
      personIds.map(async (personId) => {
        try {
          await admin.people.workSessionsAPIApi.stopWorkSession({ workSessionRequest: { personId } });
        } catch (error) {
          if (!isHttpStatus(error, 404)) {
            throw new Error(`stopWorkSession ${personId} failed: ${await formatError(error)}`);
          }
        }
        return personId;
      }),
    );
    return {
      closed: outcomes
        .filter((outcome): outcome is PromiseFulfilledResult<string> => outcome.status === 'fulfilled')
        .map((outcome) => outcome.value),
      // Kept, not discarded: a swallowed rejection here was how a 500 from the backend
      // became a clean day.
      failures: outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome) => (outcome.reason as Error).message),
    };
  };

  /** A stale session from an interrupted run is closed before a fresh one opens. */
  const closeStale = async (personId: string): Promise<void> => {
    try {
      await admin.people.workSessionsAPIApi.stopWorkSession({ workSessionRequest: { personId } });
    } catch (error) {
      // 404 is the happy path: no session was open.
      if (!isHttpStatus(error, 404)) {
        throw new Error(`could not close a stale work session for ${personId}: ${await formatError(error)}`);
      }
    }
  };

  return {
    /**
     * Opens the shift for everyone, in parallel.
     *
     * Parallel because the virtual clock makes a sequential fan-out expensive in a way
     * it never is on a normal clock: at scale 8,760 one 200ms gateway call is about 29
     * *virtual* minutes, so clocking ten people in one at a time — two calls each —
     * would spend most of a working day before any work started, and would push every
     * bound derived afterwards past the window. Per person the two calls stay ordered,
     * because the stale session has to be closed before a fresh one opens.
     */
    async clockIn(at: Date): Promise<string[]> {
      if (everyone.length === 0) {
        throw new Error(
          '[accel] the reference bootstrap produced no employees, so nobody can clock in. ' +
            'A virtual day with no staff writes no labor and no payroll.',
        );
      }
      // allSettled, not all: `Promise.all` rejects on the first failure while the other
      // calls are still in flight, so `onTheClock` would never be assigned and people the
      // backend really did clock in would be recorded nowhere — left open for the audit to
      // find with nothing to close them.
      const outcomes = await Promise.allSettled(
        everyone.map(async (personId) => {
          await closeStale(personId);
          const started = await call(`startWorkSession ${personId}`, () =>
            admin.people.workSessionsAPIApi.startWorkSession({ workSessionRequest: { personId } }),
          );
          if (!readString(started, 'sessionId')) {
            throw new Error(`startWorkSession for ${personId} returned no sessionId — the shift was not opened`);
          }
          return personId;
        }),
      );

      // Recorded before anything is thrown, so whoever is on the clock can be clocked out.
      onTheClock = outcomes
        .filter((outcome): outcome is PromiseFulfilledResult<string> => outcome.status === 'fulfilled')
        .map((outcome) => outcome.value);

      const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
      if (failures.length > 0) {
        // Closed here, not left to the caller: this throw propagates out of runDay and
        // stops the run, so nothing downstream would ever clock these people out. They
        // would stay open until some later run's `closeStale` found them.
        const opened = [...onTheClock];
        const { closed } = await closeSessions(opened);
        onTheClock = [];
        throw new Error(
          `[accel] ${failures.length} of ${everyone.length} could not be clocked in (` +
            failures
              .map((outcome) => ((outcome as PromiseRejectedResult).reason as Error).message)
              .join('; ') +
            `). The ${closed.length} of ${opened.length} session(s) that did open have been closed again.`,
        );
      }
      log(`${at.toISOString().slice(0, 16)} — ${onTheClock.length} on the clock`);
      return onTheClock;
    },

    /**
     * Closes the shift for everyone, in parallel — and this one is load-bearing.
     *
     * The backend stamps each `endAtUtc` from its own accelerated clock at the moment
     * its `stopWorkSession` runs, so a sequential fan-out puts the last person's entry
     * N calls past the first. At scale 4,380 that is about 15 virtual minutes per call:
     * ten people sequentially is 146 virtual minutes, past the 90-minute grace, and the
     * end-of-run payroll audit fails on the tail — for a run that did nothing wrong.
     * In parallel the whole fan-out costs about one call.
     */
    async clockOut(): Promise<string[]> {
      const { closed, failures } = await closeSessions(onTheClock);
      // Pruned rather than cleared, so a retry does not re-stop people already stopped.
      onTheClock = onTheClock.filter((personId) => !closed.includes(personId));
      if (failures.length > 0) {
        // Thrown, after closing everyone who could be closed. A warning here was silent
        // at the level that matters: the open entry has no endAtUtc, the audit skips
        // it, and the day passes — and the next morning's closeStale stamps it shut at
        // opening time, recording a bogus overnight shift the audit also accepts.
        throw new Error(
          `[accel] ${failures.length} of ${closed.length + failures.length} session(s) could not be ` +
            `closed (${failures.join('; ')}). ${onTheClock.length} still on the clock: ${onTheClock.join(', ')}.`,
        );
      }
      return closed;
    },

    /**
     * The day's reported time goes to the manager — the entries there are to
     * decide, and no others.
     *
     * This used to send `{decisions: []}` on the claim that an empty batch was
     * what the seeder sends and what the backend accepts. It is not:
     * `TimeEntryDecisionBatchRequest.decisions` carries `@NotEmpty`, so an empty
     * batch is invalid by contract and answers 400 VALIDATION_ERROR. Unguarded at
     * shift close, that one call ended a virtual year on its first day, after the
     * day had booked, staffed, clocked in and worked.
     *
     * So the queue is read first and only a real batch is sent. Nothing in either
     * service currently writes a decidable entry — pos-workorder's `time_entry`
     * has an approve and a reject endpoint and no writer, and pos-people's
     * `timekeeping_entry` is fed by an event that is published nowhere outside its
     * own unit tests (see Suite F's header) — so in practice this finds none and
     * says so once. When that bridge lands, this starts approving real time
     * without another change here.
     */
    async approveTime(at: Date): Promise<void> {
      // Every page, driven by the page count the backend reports. `size` defaults
      // to 20 and is capped at 100 (TimeEntryApprovalController), and a loop that
      // stopped at an arbitrary bound would approve part of a busy day while the log
      // claimed the shift's time had been approved.
      const pending = await readAllPages('listTimeEntries(SUBMITTED)', (page) =>
        manager.people.timeEntryApprovalAPIApi.listTimeEntries({
          // The generated enum, not the string: the client narrows this param.
          status: ListTimeEntriesStatusEnum.Submitted,
          locationId: refs.locationId,
          workDate: at,
          timeZone: 'UTC',
          page,
          size: 100,
        }),
      );
      const ids = pending
        .map((entry) => readString(entry, 'timeEntryId'))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const decisions = ids.map((timeEntryId) => ({ timeEntryId }));

      if (decisions.length === 0) {
        // Not a failure, and not silent either: a day that approved nothing is
        // the expected state today, and the count is what will show it changing.
        log(`${at.toISOString().slice(0, 10)}: no submitted time entries to approve`);
        return;
      }

      await call('approveTimeEntriesBatch', () =>
        manager.people.timeEntryApprovalAPIApi.approveTimeEntriesBatch({
          timeEntryDecisionBatchRequest: { decisions },
        }),
      );
      log(`${at.toISOString().slice(0, 10)}: approved ${decisions.length} time entr(ies)`);
    },
  };
}

/**
 * Weekly cycle counts and monthly restocks, on their due virtual days.
 *
 * Same calls as the seeder's InventoryMaintenanceSimulator, with the failures
 * raised instead of logged, and dated from virtual time rather than `Date.now()`
 * so a purchase order raised in the virtual November is not stamped with today.
 */
export function createMaintenancePort(
  parts: DomainClients,
  manager: DomainClients,
  ctx: BuilderContext,
): MaintenancePort {
  const refs = ctx.refs;
  const RESTOCK_QUANTITY = 50;
  const RESTOCK_UNIT_COST_MINOR = 1_000;
  /** Products examined for a write-off, and how many of them may actually be scrapped. */
  const SCRAP_CANDIDATES = 5;
  const SCRAP_PER_RUN = 2;
  const SCRAP_REASONS = [
    CreateScrapRequestReasonCodeEnum.Damaged,
    CreateScrapRequestReasonCodeEnum.Expired,
    CreateScrapRequestReasonCodeEnum.Lost,
    CreateScrapRequestReasonCodeEnum.Contaminated,
  ];

  return {
    async cycleCount(at: Date, onApproved?: (adjustmentId: string) => void): Promise<void> {
      const candidates = ctx.random.pickN(refs.productEntityIds, Math.min(3, refs.productEntityIds.length));
      if (candidates.length === 0) {
        throw new Error('[accel] the cycle count has no products to count — the catalog bootstrap produced none');
      }

      for (const productId of candidates) {
        const productName = refs.productNameById.get(productId) ?? productId;

        // Counted against what is actually on the shelf, not against an assumed 50.
        //
        // The old figure was a literal, and a count is a claim about stock: with two
        // on hand and a claimed fifty, a variance of -5 posts an outbound of five and
        // the ledger refuses to drive stock negative —
        //
        //   NegativeStockPolicyViolationException: COUNT_VARIANCE_OUT … would take
        //   on-hand to -3.0000; counts and adjustments may zero stock but never
        //   drive it negative
        //
        // which surfaced as 500 ADJUSTMENT_LEDGER_POST_FAILED and left sixteen
        // adjustments FAILED across one virtual year
        // (durion-positivity-backend#2167). Suite E does not hit it because it
        // seeds the quantity it then counts; the year run counts what the shop has.
        //
        // Stock items are keyed by SKU, which equals the productEntityId.
        // Unwrapped, because the 404 is the answer rather than a failure: the
        // endpoint "returns 404 when the SKU has no stock-summary rows", which is
        // the ordinary state of a product never received. `call` would rewrite it
        // as a plain Error and the whole weekly count would abort on the first
        // unstocked candidate instead of counting an empty shelf.
        let quantityOnHandBefore = 0;
        try {
          const availability = await parts.inventory.inventoryAvailabilityApi.getAvailabilityBySku({
            productSku: productId,
            locationId: refs.locationId,
          });
          quantityOnHandBefore = Math.max(
            0,
            Math.trunc(readNumber(availability, 'onHandQuantity', 'onHandQty') ?? 0),
          );
        } catch (error) {
          if (!isHttpStatus(error, 404)) {
            throw new Error(`getAvailabilityBySku ${productName} failed: ${await formatError(error)}`);
          }
        }

        // A downward variance may empty the shelf and no more: zeroing stock is a
        // real count, driving it negative is a fiction the ledger is right to
        // refuse.
        //
        // And never a variance of nothing. `countedQuantity` must differ from
        // `quantityOnHandBefore` — a zero variance is rejected — so an empty shelf
        // is only ever counted upward, where a downward swing would have clamped to
        // zero and failed about half the counts on a never-received product.
        const swing = ctx.random.int(1, 5);
        const variance =
          quantityOnHandBefore === 0 || ctx.random.chance(0.5)
            ? swing
            : -Math.min(swing, quantityOnHandBefore);

        const adjustment = await call(`createCycleCountAdjustment ${productName}`, () =>
          parts.inventory.cycleCountAdjustmentsApi.createCycleCountAdjustment({
            createAdjustmentRequest: {
              stockItemId: productId,
              reasonCode: 'CYCLE_COUNT',
              countedQuantity: Math.max(0, quantityOnHandBefore + variance),
              quantityOnHandBefore,
              costAtTimeOfAdjustment: 100,
              createdByUserId: refs.employees.partsClerk || refs.employees.manager,
            },
          }),
        );
        const adjustmentId = requireField(adjustment.adjustmentId, 'adjustmentId');

        // Counting and approving are different people: the count is the parts
        // clerk's, the write-off is the manager's.
        await call(`approveCycleCountAdjustment ${adjustmentId}`, () =>
          manager.inventory.cycleCountAdjustmentsApi.approveCycleCountAdjustment({
            adjustmentId,
            approveAdjustmentRequest: {
              approverUserId: refs.employees.manager,
              notes: `Weekly cycle count on ${at.toISOString().slice(0, 10)} [${ctx.runId}]`,
            },
          }),
        );
        onApproved?.(adjustmentId);
      }
      log(`cycle count approved for ${candidates.length} item(s) on ${at.toISOString().slice(0, 10)}`);
    },

    async restock(at: Date): Promise<void> {
      const products = ctx.random.pickN(refs.productEntityIds, Math.min(5, refs.productEntityIds.length));
      if (products.length === 0) {
        throw new Error('[accel] the monthly restock has no products to order');
      }

      const po = await call('createPurchaseOrder', () =>
        parts.order.purchaseOrdersApi.createPurchaseOrder({
          createPurchaseOrderRequest: {
            vendorId: SEED_VENDOR_ID,
            // Virtual time, not today: a year of purchase orders all stamped with
            // the real date would make the financial history unreadable.
            poDate: new Date(at),
            currency: 'USD',
            shipToLocationId: refs.locationId,
            requestedBy: refs.employees.partsClerk,
            comment: `Monthly restock ${at.toISOString().slice(0, 10)} [${ctx.runId}]`,
            lines: products.map((productId, index) => ({
              lineNumber: index + 1,
              skuId: productId,
              description: `Restock ${refs.productNameById.get(productId) ?? productId} [${ctx.runId}]`,
              quantity: RESTOCK_QUANTITY,
              unitCostMinor: RESTOCK_UNIT_COST_MINOR,
            })),
          },
        }),
      );
      const purchaseOrderId = requireField(po.purchaseOrderId, 'purchaseOrderId');

      await call('approvePurchaseOrder', () =>
        manager.order.purchaseOrdersApi.approvePurchaseOrder({
          poId: purchaseOrderId,
          approvePurchaseOrderRequest: { approvalNotes: `Monthly restock approval [${ctx.runId}]` },
        }),
      );

      const poLines = po.lines ?? [];
      const lineRef = (index: number) => readString(poLines[index], 'poLineId', 'lineId', 'id');

      // pos-order owns the purchase order and publishes it on order.events.v1;
      // pos-inventory folds it into ext_purchase_order on its next poll, so an ASN
      // issued straight after approval loses that race.
      const asn = await retryWhileReplicating(
        () =>
          parts.inventory.asnApi.createAsn({
            createAsnRequest: {
              vendorId: SEED_VENDOR_ID,
              // The id's tail, not its head: purchase order ids are UUIDv7 and
              // share their leading characters within the same time window.
              asnReferenceNumber: `ASN-${ctx.runId}-${purchaseOrderId.slice(-12)}`,
              relatedPoIds: [purchaseOrderId],
              shipDate: new Date(at),
              expectedArrivalDate: new Date(at.getTime() + 3 * 86_400_000),
              lineItems: products.map((productId, index) => ({
                poId: purchaseOrderId,
                poLineId: lineRef(index),
                sku: productId,
                quantityShipped: RESTOCK_QUANTITY,
                unitCostMinor: RESTOCK_UNIT_COST_MINOR,
              })),
            },
          }),
        {
          markers: ['INVALID_PO_REFERENCE'],
          description: `creating a restock ASN for purchase order ${purchaseOrderId}`,
          timeoutMs: 60_000,
        },
      );
      const asnId = requireField(asn.asnId, 'asnId');

      await call('createGoodsReceipt', () =>
        parts.inventory.asnApi.createGoodsReceipt({
          createGoodsReceiptRequest: {
            poId: purchaseOrderId,
            asnId,
            locationId: refs.locationId,
            lines: products.map((productId, index) => ({
              poLineId: lineRef(index),
              sku: productId,
              quantityReceived: RESTOCK_QUANTITY,
              unitCostMinor: RESTOCK_UNIT_COST_MINOR,
            })),
          },
        }),
      );
      log(`monthly restock received on ${at.toISOString().slice(0, 10)}: PO ${purchaseOrderId}`);
    },

    /**
     * Writes off damaged, expired or lost stock.
     *
     * Deliberately not a cycle-count adjustment. The two settle different facts —
     * an adjustment reconciles a count against the shelf, a scrap is a decision to
     * destroy value — and the backend treats them differently: a posted scrap emits
     * `ScrapPostedV1`, which pos-accounting posts on the shrinkage mapping, while an
     * approved adjustment emits `InventoryAdjustedV1`, posted on the adjustment
     * mapping (durion-positivity-backend#2186). A year that only ever adjusts
     * therefore exercises none of the scrap path.
     */
    async scrap(at: Date): Promise<void> {
      const candidates = ctx.random.pickN(
        refs.productEntityIds,
        Math.min(SCRAP_CANDIDATES, refs.productEntityIds.length),
      );
      if (candidates.length === 0) {
        throw new Error('[accel] the scrap run has no products to write off — the catalog bootstrap produced none');
      }

      let posted = 0;
      let pending = 0;
      let bare = 0;

      for (const productId of candidates) {
        if (posted + pending >= SCRAP_PER_RUN) break;
        const productName = refs.productNameById.get(productId) ?? productId;

        // Written off against what is on the shelf, for the reason the count is:
        // scrapping more than is held answers 422 SCRAP_INSUFFICIENT_STOCK, and the
        // override that would force it needs `inventory:adjustment:override`, which
        // the parts clerk does not hold. A 404 here is a product never received,
        // which is the ordinary state of most of the catalog — unwrapped so the
        // status stays readable, since `call` would flatten it into a plain Error
        // and abort the whole write-off on the first unstocked candidate.
        let onHand = 0;
        try {
          const availability = await parts.inventory.inventoryAvailabilityApi.getAvailabilityBySku({
            productSku: productId,
            locationId: refs.locationId,
          });
          onHand = Math.max(0, Math.trunc(readNumber(availability, 'onHandQuantity', 'onHandQty') ?? 0));
        } catch (error) {
          if (!isHttpStatus(error, 404)) {
            throw new Error(`getAvailabilityBySku ${productName} failed: ${await formatError(error)}`);
          }
        }

        // An empty shelf is not a write-off. Unlike a count, which may legitimately
        // find stock that the system did not know about, there is nothing to destroy.
        if (onHand <= 0) {
          bare += 1;
          continue;
        }

        const quantity = Math.min(onHand, ctx.random.int(1, 3));
        // OTHER is excluded on purpose: it is the one reason code that requires
        // notes, and a 400 for a missing note would be the harness's fault rather
        // than a finding.
        const reasonCode = ctx.random.pickOne(SCRAP_REASONS);

        const created = await call(`createScrap ${productName}`, () =>
          parts.inventory.scrapsApi.createScrap({
            createScrapRequest: {
              stockItemId: productId,
              locationId: refs.locationId,
              quantity,
              reasonCode,
              // Never forced. A run that overrode the negative-stock policy would
              // stop testing the policy.
              negativeStockOverride: false,
              // Replenishment is the restock's job; a scrap that quietly reordered
              // would make the monthly purchase order impossible to read.
              shouldReplenish: false,
              notes: `Scrap on ${at.toISOString().slice(0, 10)} [${ctx.runId}]`,
            },
          }),
        );
        const scrapId = requireField(created.scrapId, 'scrapId');

        // Value decides the path, not the harness: under the approval thresholds the
        // backend auto-approves and posts SCRAP_OUT in the same transaction; over
        // them, or when no cost can be derived, it parks in PENDING_APPROVAL for a
        // manager. Both are real outcomes, so both are driven to a terminal state —
        // and creating is the clerk's, approving the manager's.
        let status = readString(created, 'status');
        if (status === 'PENDING_APPROVAL') {
          const approved = await call(`approveScrap ${scrapId}`, () =>
            manager.inventory.scrapsApi.approveScrap({
              scrapId,
              approveScrapRequest: { negativeStockOverride: false },
            }),
          );
          status = readString(approved, 'status');
        }

        if (status === 'POSTED' || status === 'AUTO_APPROVED' || status === 'APPROVED') {
          posted += 1;
        } else {
          pending += 1;
          log(`scrap ${scrapId} for ${productName} ended ${status ?? 'an unknown status'} rather than posted`);
        }
      }

      // A day on which every candidate was bare is worth saying out loud. It is not
      // a failure — early in a run, before the first delivery, it is the truth about
      // the shop — but a year of it means the write-off is testing nothing, and
      // Z8b's total is what makes that visible at the end.
      if (posted + pending === 0) {
        log(`no stock to write off on ${at.toISOString().slice(0, 10)}: all ${bare} candidate(s) were empty`);
        return;
      }
      log(
        `scrap on ${at.toISOString().slice(0, 10)}: ${posted} posted, ${pending} unposted, ` +
          `${bare} candidate(s) had nothing on the shelf`,
      );
    },
  };
}

interface PendingAppointment {
  appointmentId: string;
  startAt: Date;
  partyId: string;
  vehicleId: string;
  converted: boolean;
}

/**
 * Appointments, booked ahead in virtual time and converted when the clock reaches
 * them.
 *
 * The seeder never books an appointment, and the non-accelerated suite books one
 * for a real future date it can never reach inside a test run. Only an
 * accelerated clock makes the whole path — book, wait for the slot to arrive,
 * convert to an estimate — observable, which is why this is the one part of the
 * accelerated suite with no non-accelerated twin.
 */
export function createAppointmentPort(options: {
  advisor: DomainClients;
  admin: DomainClients;
  ctx: BuilderContext;
  calendar: ShopCalendar;
  leadDaysMin: number;
  leadDaysMax: number;
  /** Books for a customer the caller supplies, so the port creates no CRM data of its own. */
  customerFor: () => Promise<{ partyId: string; vehicleId: string }>;
}): AppointmentPort & { pending(): number } {
  const pending: PendingAppointment[] = [];
  const SLOT_CONFLICT = 'already booked';

  /** A one-hour slot inside an open window `leadDays` virtual days ahead. */
  const slotFor = (now: Date, leadDays: number, jitterMinutes: number): { startAt: Date; endAt: Date } => {
    const target = new Date(now.getTime() + leadDays * 86_400_000);
    const open = options.calendar.nextOpen(target, 'BAY');
    const startAt = new Date(open.getTime() + jitterMinutes * 60_000);
    // Jitter can push past close on a short Saturday; fall back to the window's
    // own opening instant rather than booking into the evening.
    if (!options.calendar.isOpen(startAt, 'BAY')) {
      return { startAt: open, endAt: new Date(open.getTime() + 3_600_000) };
    }
    return { startAt, endAt: new Date(startAt.getTime() + 3_600_000) };
  };

  return {
    pending: () => pending.filter((appointment) => !appointment.converted).length,

    async book(at: Date, count: number): Promise<number> {
      // A counter the loop shares, not a return value: every appointment already
      // booked is on the backend, and a refusal on the third of five must still
      // report two. A local in this scope would read 0 on the throw, because the
      // loop's own total never comes back.
      const progress = { done: 0 };
      try {
        return await bookEach(at, count, progress);
      } catch (error) {
        throw progress.done > 0
          ? new PartialProgressError(
              `booking stopped after ${progress.done} of ${count}: ${error instanceof Error ? error.message : String(error)}`,
              progress.done,
              error,
            )
          : error;
      }
    },

    async convertDue(at: Date): Promise<number> {
      const progress = { done: 0 };
      try {
        return await convertEach(at, progress);
      } catch (error) {
        throw progress.done > 0
          ? new PartialProgressError(
              `conversion stopped after ${progress.done}: ${error instanceof Error ? error.message : String(error)}`,
              progress.done,
              error,
            )
          : error;
      }
    },
  };

  /** The booking loop itself, so the wrapper above owns only the partial-count report. */
  async function bookEach(at: Date, count: number, progress: { done: number }): Promise<number> {
    for (let index = 0; index < count; index += 1) {
        const customer = await options.customerFor();
        const leadDays = options.ctx.random.int(options.leadDaysMin, options.leadDaysMax);

        // A slot already taken is a refusal about the *slot*, not the request:
        // every appointment any previous run booked is still on this environment.
        // Answered by trying elsewhere, as Suite A does.
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          const { startAt, endAt } = slotFor(at, leadDays, options.ctx.random.int(0, 8) * 30);
          try {
            const created = await retryWhileReplicating(
              () =>
                options.advisor.shopManager.appointmentsApi.createAppointment({
                  appointmentCreateRequest: {
                    crmCustomerId: customer.partyId,
                    crmVehicleId: customer.vehicleId,
                    locationId: options.ctx.refs.locationId,
                    startAt,
                    endAt,
                    serviceRequestIds: options.ctx.refs.serviceEntityIds.slice(0, 2),
                  },
                }),
              {
                markers: ['CUSTOMER_NOT_FOUND', 'VEHICLE_NOT_FOUND'],
                description: `booking an appointment for party ${customer.partyId}`,
                timeoutMs: 60_000,
              },
            );
            pending.push({
              appointmentId: requireField(readString(created, 'appointmentId', 'id'), 'appointmentId'),
              startAt,
              partyId: customer.partyId,
              vehicleId: customer.vehicleId,
              converted: false,
            });
            progress.done += 1;
            break;
          } catch (error) {
            const detail = error instanceof Error ? error.message : await formatError(error);
            if (!detail.includes(SLOT_CONFLICT) || attempt === 6) {
              throw error;
            }
          }
        }
    }
    return progress.done;
  }

  /**
   * Every appointment whose start the clock has passed becomes an estimate.
     *
   * The bridge is idempotent on the **appointment id**:
   * `EstimateServiceImpl.createEstimateFromAppointment` looks up
   * `estimateRepository.findByAppointmentId` first and returns the existing
   * estimate with `created: false` when there is one. `idempotencyKey` is
   * logged and nothing else, so a fresh UUID per attempt is safe — a retried
   * conversion cannot produce a second estimate for one arrival.
   *
   * That matters now that a refused conversion no longer ends the run: the
   * appointment stays pending and is tried again on the next virtual day, and
   * a failure *after* the estimate was written is exactly the case the lookup
   * covers.
   */
  async function convertEach(at: Date, progress: { done: number }): Promise<number> {
    for (const appointment of pending) {
        if (appointment.converted || appointment.startAt.getTime() > at.getTime()) {
          continue;
        }
        const created = await call(`createEstimateFromAppointment ${appointment.appointmentId}`, () =>
          options.advisor.workorder.estimatesFromAppointmentsApi.createEstimateFromAppointment({
            createEstimateFromAppointmentRequest: {
              idempotencyKey: crypto.randomUUID(),
              appointmentId: appointment.appointmentId,
              customerId: appointment.partyId,
              vehicleId: appointment.vehicleId,
              locationId: options.ctx.refs.locationId,
              requestedServices: options.ctx.refs.serviceEntityIds
                .slice(0, 2)
                .map((id) => options.ctx.refs.serviceNameById.get(id) ?? id),
            },
          }),
        );
        if (!readString(created, 'estimateId', 'id')) {
          throw new Error(
            `the appointment bridge returned no estimate for appointment ${appointment.appointmentId}`,
          );
        }
      appointment.converted = true;
      progress.done += 1;
    }
    return progress.done;
  }
}
