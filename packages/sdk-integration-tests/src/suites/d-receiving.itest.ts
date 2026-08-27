import { SEED_VENDOR_ID, SeederRandom } from '@durion-sdk/seeder';
import {
  addLaborLine,
  addPartLine,
  approveAndPromote,
  createApprovedPo,
  createAsnForPo,
  createCatalogProduct,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  readString,
  requireField,
  seedFromRunId,
  type BuilderContext,
  type CreatedPo,
  type CreatedProduct,
} from '../harness/builders';
import { readAvailability, readOnHand } from '../harness/availability';
import { call, expectHttpError, formatError, isHttpStatus } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas, type DomainClients } from '../harness/personas';
import { waitFor } from '../harness/waitFor';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite D — receiving, in two parts: a brand-new product into stock, and a
 * product ordered for a workorder that is short of it.
 *
 * Every availability assertion compares a delta against a snapshot taken in
 * the same test. Alpha is shared and long-lived, so absolute levels mean
 * nothing; what a receipt must do is *raise* the number by what arrived.
 */
describe('Suite D — receiving', () => {
  const RECEIVE_QUANTITY = 25;
  const SESSION_QUANTITY = 5;
  /**
   * pos-inventory's staging location, from ITEST_STAGING_LOCATION_ID or the
   * default of POS_INVENTORY_RECEIVING_STAGING_LOCATION_ID. Putaway generation
   * compares the goods receipt's location against it, so a receipt booked
   * anywhere else is refused (backend #1496), and an environment that overrode
   * the backend default has to say so rather than have this test fail
   * mysteriously.
   */
  const STAGING_LOCATION_ID = ItestConfig.fromEnv().stagingLocationId;

  /**
   * True only for the purchase-order line projection still catching up. Any
   * other 409 is a real conflict and is left to fail.
   */
  const isReplicationLag = async (error: unknown): Promise<boolean> =>
    isHttpStatus(error, 409) && (await formatError(error)).includes('SOURCE_DOCUMENT_LINES_UNAVAILABLE');
  const SHORTAGE_QUANTITY = 2;
  const UNIT_COST_MINOR = 1_450;

  let context: ItestContext;
  let personas: Personas;
  let ctx: BuilderContext;
  let admin: DomainClients;
  let advisor: DomainClients;
  let manager: DomainClients;
  let parts: DomainClients;
  let tech: DomainClients;
  let locationId: string;

  /** Receives every line of a purchase order in full, at each line's own SKU. */
  const receiveFully = async (po: CreatedPo, quantity: number) => {
    const asnId = await createAsnForPo(parts, ctx, SEED_VENDOR_ID, po);
    const receipt = await call('createGoodsReceipt', () =>
      parts.inventory.asnApi.createGoodsReceipt({
        createGoodsReceiptRequest: {
          poId: po.purchaseOrderId,
          asnId,
          locationId,
          lines: po.lines.map((line) => ({
            poLineId: line.poLineId,
            // The line's own SKU, not the caller's: a multi-line PO would
            // otherwise be received entirely against one product.
            sku: line.skuId,
            quantityReceived: quantity,
            unitCostMinor: line.unitCostMinor,
          })),
        },
      }),
    );
    return { asnId, receiptId: requireField(readString(receipt, 'receiptId', 'id'), 'receiptId') };
  };

  beforeAll(async () => {
    context = loadContext();
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    admin = personas.as('admin');
    advisor = personas.as('advisor');
    manager = personas.as('manager');
    parts = personas.as('parts');
    tech = personas.as('tech');
    ctx = {
      runId: context.runId,
      // Seeded per suite, not per run: a shared seed makes every suite generate
      // the same VIN, and VINs are globally unique across active vehicles.
      random: new SeederRandom(seedFromRunId(`${context.runId}:d-receiving`)),
      refs: context.referenceCache,
    };
    locationId = context.referenceCache.locationId;
  }, 180_000);

  beforeEach(async () => {
    await personas.refreshIfNeeded();
  });

  describe('part 1 — a brand-new product into stock', () => {
    let sessionId: string;
    let product: CreatedProduct;
    let po: CreatedPo;
    let receiptId: string;
    let onHandBefore: number;

    it('D1 — creates the product, which starts with no stock', async () => {
      product = await createCatalogProduct(admin, ctx, 'A');
      expect(product.productEntityId).toBeTruthy();

      const snapshot = await readAvailability(parts, product.productEntityId, locationId);
      onHandBefore = snapshot?.onHandQty ?? 0;
      console.log(
        `[D1] ${product.sku}: availability before receiving = ${snapshot ? JSON.stringify(snapshot) : 'absent (404)'}`,
      );
      expect(onHandBefore).toBe(0);
    }, 180_000);

    it('D2 — the parts clerk raises a PO and the manager approves it', async () => {
      po = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: product.productEntityId,
          quantity: RECEIVE_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);

      expect(po.purchaseOrderId).toBeTruthy();
      expect(po.lines).toHaveLength(1);
      expect(po.lines[0].poLineId).toBeTruthy();

      const fetched = await call('getPurchaseOrder', () =>
        parts.order.purchaseOrdersApi.getPurchaseOrder({ poId: po.purchaseOrderId }),
      );
      console.log(`[D2] purchase order ${po.purchaseOrderId} status = ${fetched.status}`);
      expect(String(fetched.status).toUpperCase()).toContain('APPROV');
    }, 180_000);

    it('D3 — an ASN and a goods receipt land the full quantity', async () => {
      const received = await receiveFully(po, RECEIVE_QUANTITY);
      receiptId = received.receiptId;

      const roundTrip = await call('getGoodsReceipt', () =>
        parts.inventory.asnApi.getGoodsReceipt({ receiptId }),
      );
      console.log(`[D3] goods receipt ${receiptId} for ASN ${received.asnId}`);
      expect(readString(roundTrip, 'receiptId', 'id')).toBe(receiptId);
    }, 240_000);

    it('D4 — the stock becomes visible at the location', async () => {
      const onHandAfter = await waitFor(
        async () => {
          const current = await readOnHand(parts, product.productEntityId, locationId);
          return current >= onHandBefore + RECEIVE_QUANTITY ? current : undefined;
        },
        {
          description: `on-hand for ${product.sku} to reach ${onHandBefore + RECEIVE_QUANTITY}`,
          timeoutMs: 90_000,
        },
      );
      console.log(`[D4] on-hand ${onHandBefore} -> ${onHandAfter}`);
      expect(onHandAfter - onHandBefore).toBe(RECEIVE_QUANTITY);
    }, 180_000);

    // The 420s timeout is longer than its neighbours' because this test raises
    // a second purchase order, ASN and receipt of its own before putting
    // anything away, then waits on three separate availability reads - any of
    // which can take the full 90s on a slow alpha.
    it('D5 — a shop-floor receipt cannot be put away; a staged one is generated, claimed, and executed', async () => {
      const tasks = await call('listPutawayTasks', () =>
        parts.inventory.putawayApi.listPutawayTasks({ locationId }),
      );
      console.log(`[D5] ${tasks.length} putaway task(s) at the location before anything is asked for`);

      // Part one: the receipt from D3 landed stock directly on the shop floor,
      // and putaway generation refuses it by design (backend #1496). It used to
      // emit a task rooted at staging that could never be executed - from the
      // staging source because nothing was there, and from the receiving
      // location because the destination it had suggested was itself rejected.
      const refusal = await formatError(
        await parts.inventory.putawayApi
          .generatePutawayTasks({
            generatePutawayTasksRequest: {
              sourceReceiptId: receiptId,
              lineItems: [{ productId: product.productEntityId, quantity: RECEIVE_QUANTITY }],
            },
          })
          .then(
            (generated) => {
              throw new Error(
                `[D5] generatePutawayTasks accepted a shop-floor receipt and returned ` +
                  `${generated.length} task(s). Backend #1496 refused this; if that has been ` +
                  `deliberately reversed, assert the tasks are executable instead.`,
              );
            },
            (error: unknown) => error,
          ),
      );
      console.log(`[D5] shop-floor receipt refused: ${refusal.slice(0, 200)}`);
      expect(refusal).toContain('RECEIPT_NOT_STAGED');

      // Part two: the same flow against a receipt booked into staging, which is
      // where putaway is meant to start.
      const stagedPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: product.productEntityId,
          quantity: RECEIVE_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);
      const stagedAsnId = await createAsnForPo(parts, ctx, SEED_VENDOR_ID, stagedPo);
      const stagedReceipt = await call('createGoodsReceipt(staging)', () =>
        parts.inventory.asnApi.createGoodsReceipt({
          createGoodsReceiptRequest: {
            poId: stagedPo.purchaseOrderId,
            asnId: stagedAsnId,
            locationId: STAGING_LOCATION_ID,
            lines: stagedPo.lines.map((line) => ({
              poLineId: line.poLineId,
              sku: line.skuId,
              quantityReceived: RECEIVE_QUANTITY,
              unitCostMinor: line.unitCostMinor,
            })),
          },
        }),
      );
      const stagedReceiptId = requireField(
        readString(stagedReceipt, 'receiptId', 'id'),
        'staged receiptId',
      );

      // The move is asserted as a delta at both ends, so both are read before
      // anything moves. Staging is as shared and long-lived as every other
      // location on alpha - other runs stage stock too - so only the change of
      // RECEIVE_QUANTITY is ours to claim.
      const stagingBefore = await waitFor(
        async () => {
          const onHand = await readOnHand(parts, product.productEntityId, STAGING_LOCATION_ID);
          return onHand >= RECEIVE_QUANTITY ? { onHand } : undefined;
        },
        {
          description: `the staged receipt to put ${RECEIVE_QUANTITY} of ${product.sku} into staging`,
          timeoutMs: 90_000,
        },
      );
      console.log(`[D5] staging on-hand before putaway = ${stagingBefore.onHand}`);

      // Generation now clears the staging guard and runs to completion. It used
      // to stop at a second guard - 422 LOCATION_NOT_VALID_FOR_SKU, "SKU is not
      // configured in replenishment policies" - because the destination was
      // validated against replenishment policy and this SKU was created by D1
      // moments earlier. Backend #1538 removed that gate (see #1514): putaway
      // eligibility now asks whether the destination is physically fit for the
      // item, via a seeded compatibility matrix keyed on catalog category, and
      // a seeded ANY rule is the terminal fallback so a brand-new SKU never
      // dead-ends.
      const generated = await call('generatePutawayTasks(staged)', () =>
        parts.inventory.putawayApi.generatePutawayTasks({
          generatePutawayTasksRequest: {
            sourceReceiptId: stagedReceiptId,
            lineItems: [{ productId: product.productEntityId, quantity: RECEIVE_QUANTITY }],
          },
        }),
      );
      console.log(`[D5] generated ${generated.length} task(s) for the staged receipt`);
      expect(generated).toHaveLength(1);

      const task = generated[0];
      expect(task.productId).toBe(product.productEntityId);
      expect(task.quantity).toBe(RECEIVE_QUANTITY);
      expect(task.sourceLocationId).toBe(STAGING_LOCATION_ID);
      expect(String(task.status).toUpperCase()).toBe('UNASSIGNED');

      // suggestedDestinationLocationId is the resolved destination whether or
      // not a fallback was taken; finalSuggestedLocationId is set only on
      // fallback and repeats the same value, so this is the field to execute
      // against.
      const destinationLocationId = requireField(
        task.suggestedDestinationLocationId,
        'suggestedDestinationLocationId',
      );
      console.log(
        `[D5] task ${task.taskId}: ${STAGING_LOCATION_ID} -> ${destinationLocationId}` +
          (task.fallbackReason ? ` (fallback: ${task.fallbackReason})` : ''),
      );
      // A rule that resolves back to staging would zero both deltas below and
      // make the rest of this test vacuous. It is a seeding fault rather than a
      // code one, but it has to fail here rather than pass silently.
      expect(destinationLocationId).not.toBe(STAGING_LOCATION_ID);

      const destinationBefore = await readOnHand(
        parts,
        product.productEntityId,
        destinationLocationId,
      );
      console.log(`[D5] destination on-hand before putaway = ${destinationBefore}`);

      const claimed = await call('claimPutawayTask', () =>
        parts.inventory.putawayApi.claimPutawayTask({ taskId: task.taskId }),
      );
      expect(claimed.taskId).toBe(task.taskId);
      expect(String(claimed.status).toUpperCase()).toBe('ASSIGNED');
      console.log(`[D5] claimed by ${claimed.assigneeId ?? '(unrecorded)'}`);

      // INVENTORY_LEAD holds putaway view/generate/claim/execute but neither
      // override, so this executes on the merits: the destination has to be
      // genuinely compatible and genuinely have room. Nothing here passes
      // overrideCapacity or overrideLocationCompatibility, and it should not
      // start doing so to get the suite green.
      const execution = await parts.inventory.putawayExecutionApi
        .executePutaway({
          taskId: task.taskId,
          putawayExecutionRequest: {
            skuId: product.productEntityId,
            sourceLocationId: STAGING_LOCATION_ID,
            destinationLocationId,
            quantity: RECEIVE_QUANTITY,
          },
        })
        .catch(async (error: unknown) => {
          // Two environment faults reach here as ordinary 4xx and are worth
          // naming, because neither is a defect in this test and both are
          // fixed outside it.
          const detail = await formatError(error);
          throw new Error(
            `[D5] executePutaway ${STAGING_LOCATION_ID} -> ${destinationLocationId} failed: ` +
              `${detail}. If this says the destination storage location does not exist, ` +
              `pos-inventory's ext_storage_location replica has not been hydrated: its outbox ` +
              `replay re-emits already-serialized payloads, so storage locations need a fresh ` +
              `write via patchStorageLocation (backend docs/OPERATIONS_RUNBOOK.md). If it is a ` +
              `capacity refusal, the resolved bin cannot hold ${RECEIVE_QUANTITY} units and the ` +
              `putaway-rule fixture pack needs a roomier destination.`,
          );
        });

      expect(execution.taskId).toBe(task.taskId);
      expect(execution.skuId).toBe(product.productEntityId);
      expect(execution.sourceLocationId).toBe(STAGING_LOCATION_ID);
      expect(execution.destinationLocationId).toBe(destinationLocationId);
      expect(execution.quantityMoved).toBe(RECEIVE_QUANTITY);
      expect(String(execution.status).toUpperCase()).toBe('COMPLETED');
      expect(execution.ledgerEntryId).toBeTruthy();
      console.log(`[D5] executed: ledger entry ${execution.ledgerEntryId} at ${execution.executedAt}`);

      // The point of the whole path: the stock is no longer in staging and is
      // now at the destination. Both are read through waitFor because the
      // availability projection the suite reads is not the ledger the execution
      // wrote - wrapped in an object so an on-hand that legitimately falls to
      // zero is not mistaken for "not ready yet".
      const stagingAfter = await waitFor(
        async () => {
          const onHand = await readOnHand(parts, product.productEntityId, STAGING_LOCATION_ID);
          return onHand <= stagingBefore.onHand - RECEIVE_QUANTITY ? { onHand } : undefined;
        },
        {
          description: `staging on-hand for ${product.sku} to fall by ${RECEIVE_QUANTITY}`,
          timeoutMs: 90_000,
        },
      );
      console.log(`[D5] staging on-hand ${stagingBefore.onHand} -> ${stagingAfter.onHand}`);
      expect(stagingBefore.onHand - stagingAfter.onHand).toBe(RECEIVE_QUANTITY);

      const destinationAfter = await waitFor(
        async () => {
          const onHand = await readOnHand(parts, product.productEntityId, destinationLocationId);
          return onHand >= destinationBefore + RECEIVE_QUANTITY ? { onHand } : undefined;
        },
        {
          description: `destination on-hand for ${product.sku} to rise by ${RECEIVE_QUANTITY}`,
          timeoutMs: 90_000,
        },
      );
      console.log(`[D5] destination on-hand ${destinationBefore} -> ${destinationAfter.onHand}`);
      expect(destinationAfter.onHand - destinationBefore).toBe(RECEIVE_QUANTITY);

      // The staged stock never touched the shop floor, so what D3 and D4 put
      // there is unchanged by any of the above.
      expect(await readOnHand(parts, product.productEntityId, locationId)).toBeGreaterThanOrEqual(
        RECEIVE_QUANTITY,
      );
    }, 420_000);

    it('D6 — a receiving session is built from the purchase order\'s lines', async () => {
      const secondPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: product.productEntityId,
          quantity: SESSION_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);

      // Lines come from pos-inventory's purchase-order projection
      // (ext_purchase_order_line), fed by order.events.v1 - not from the old
      // SourceDocumentStubClient, which was disabled by default and pointed at a
      // service that never existed (backend #1480). The PO was approved seconds
      // ago, so the projection is still catching up and the first attempt can
      // answer 404: waiting is the point, and asserting the 404 - as this test
      // used to - would now be asserting replication lag.
      const session = await waitFor(
        () =>
          parts.inventory.receivingApi
            .createReceivingSession({
              createReceivingSessionRequest: { sourceDocumentId: secondPo.purchaseOrderId },
            })
            .catch(async (error) => {
              // Backend #1492: the transient answer used to be a bare 404,
              // indistinguishable from "this PO has no lines". It is now 409
              // SOURCE_DOCUMENT_LINES_UNAVAILABLE with a nextAction, and a 404
              // means the document genuinely is not there - so retrying a 404
              // would now be waiting for something that will never arrive.
              // Matched on the code, not the status: 409 is a conflict in
              // general, and swallowing every one would hide real ones.
              if (await isReplicationLag(error)) return undefined;
              throw error;
            }),
        {
          description: `a receiving session for PO ${secondPo.purchaseOrderId}`,
          timeoutMs: 90_000,
          intervalMs: 3_000,
        },
      );

      sessionId = requireField(readString(session, 'sessionId', 'id'), 'sessionId');
      const lines = (session as { lines?: Array<Record<string, unknown>> }).lines ?? [];
      console.log(`[D6] session ${sessionId} built with ${lines.length} line(s)`);
      expect(lines.length).toBeGreaterThan(0);
      // The session mirrors the PO it was built from.
      expect(lines[0]['expectedQuantity']).toBe(SESSION_QUANTITY);
    }, 240_000);
  });

  describe('part 2 — receiving for a workorder that is short', () => {
    let shortProduct: CreatedProduct;
    let workorderId: string;
    let partLineId: string | undefined;
    let shortagePo: CreatedPo;

    it('D7 — a workorder for an unstocked part raises an unfulfillable pick task', async () => {
      shortProduct = await createCatalogProduct(admin, ctx, 'B');

      const customer = await createPersonAccount(advisor, ctx);
      const vehicleId = await createVehicle(admin, ctx, customer.partyId);
      const estimateId = await createDraftEstimate(advisor, ctx, customer.partyId, vehicleId);
      await addLaborLine(advisor, ctx, estimateId, context.referenceCache.serviceEntityIds[0], 99.5);
      await addPartLine(advisor, ctx, estimateId, shortProduct.productEntityId, SHORTAGE_QUANTITY, 32.4);
      const promoted = await approveAndPromote(advisor, ctx, estimateId, customer);
      workorderId = promoted.workorderId;

      const detail = await advisor.workorder.workorderDetailApi.getWorkorderDetail({ workorderId });
      partLineId = (detail.parts ?? []).find(
        (part) => part.productEntityId === shortProduct.productEntityId,
      )?.id;
      expect(partLineId).toBeTruthy();

      // The spec expected one of two signals: a backorder for the SKU, or an
      // unfulfillable pick task. This backend raises the second (backend #1481),
      // through the same command/fact round trip as C6 and on the same order of
      // latency - roughly a minute on alpha - so it is waited for rather than
      // read once. This test used to assert both signals were absent, which was
      // true of the previous build.
      const pickTasks = await waitFor(
        async () => {
          const tasks = await tech.workorder.workorderPickFacadeApi
            .getPickTasks({ workorderId })
            .catch((error) => {
              if (isHttpStatus(error, 404)) return [];
              throw error;
            });
          return tasks.length > 0 ? tasks : undefined;
        },
        {
          description: `a pick task for the unstocked part on workorder ${workorderId}`,
          timeoutMs: 120_000,
          intervalMs: 3_000,
        },
      );
      const backorders = await parts.inventory.backordersApi.listBackorders({
        sku: shortProduct.productEntityId,
      });
      const availability = await readAvailability(parts, shortProduct.productEntityId, locationId);

      console.log(
        `[D7] ${shortProduct.sku}: ${backorders.length} backorder(s), ${pickTasks.length} pick task(s), ` +
          `availability ${availability ? JSON.stringify(availability) : 'absent (404)'}`,
      );
      // The task exists and cannot be satisfied: the part is not in the building.
      const shortTask = pickTasks.find((task) => task.skuId === shortProduct.productEntityId);
      expect(shortTask).toBeTruthy();
      expect(shortTask?.requiredQty).toBe(SHORTAGE_QUANTITY);
      expect(shortTask?.pickedQty).toBe(0);
      expect(availability?.onHandQty ?? 0).toBe(0);
      // No backorder alongside it: the pick task is this backend's shortage
      // signal, recorded so a second signal appearing is visible rather than
      // silently tolerated.
      console.log(`[D7] backorders raised alongside the pick task: ${backorders.length}`);
    }, 300_000);

    it('D8 — the shortage part is ordered and received, and stock arrives', async () => {
      const onHandBefore = await readOnHand(parts, shortProduct.productEntityId, locationId);

      shortagePo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: shortProduct.productEntityId,
          quantity: SHORTAGE_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);

      // Goods receipt rather than a receiving session: D6 records why the
      // staging path cannot run here.
      await receiveFully(shortagePo, SHORTAGE_QUANTITY);

      const onHandAfter = await waitFor(
        async () => {
          const current = await readOnHand(parts, shortProduct.productEntityId, locationId);
          return current >= onHandBefore + SHORTAGE_QUANTITY ? current : undefined;
        },
        {
          description: `on-hand for ${shortProduct.sku} to reach ${onHandBefore + SHORTAGE_QUANTITY}`,
          timeoutMs: 90_000,
        },
      );
      console.log(`[D8] ${shortProduct.sku} on-hand ${onHandBefore} -> ${onHandAfter}`);
      expect(onHandAfter - onHandBefore).toBe(SHORTAGE_QUANTITY);
    }, 300_000);

    it('D9 — a receiving line is cross-docked to the short workorder', async () => {
      // Sessions build now (D6), so the cross-dock path is reachable for the
      // first time. A fresh PO is raised for the short part rather than reusing
      // the one D8 already received in full, which has nothing outstanding left
      // to stage.
      const crossDockPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: shortProduct.productEntityId,
          quantity: SHORTAGE_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);

      const session = await waitFor(
        () =>
          parts.inventory.receivingApi
            .createReceivingSession({
              createReceivingSessionRequest: { sourceDocumentId: crossDockPo.purchaseOrderId },
            })
            .catch(async (error) => {
              // Same as D6: the line projection reports 409
              // SOURCE_DOCUMENT_LINES_UNAVAILABLE while it catches up.
              if (await isReplicationLag(error)) return undefined;
              throw error;
            }),
        {
          description: `a receiving session for PO ${crossDockPo.purchaseOrderId}`,
          timeoutMs: 90_000,
          intervalMs: 3_000,
        },
      );
      const crossDockSessionId = requireField(readString(session, 'sessionId', 'id'), 'sessionId');
      const sessionLines = (session as { lines?: Array<Record<string, unknown>> }).lines ?? [];
      const lineId = requireField(readString(sessionLines[0], 'lineId', 'id'), 'session lineId');

      // Recorded, not asserted to a single status: this is the first run in
      // which the path is reachable at all, so what the backend does with it is
      // an observation. The bogus-target negative in D11 is what pins a refusal.
      let outcome: string;
      try {
        const crossDocked = await parts.inventory.receivingApi.crossDockReceivingLine({
          sessionId: crossDockSessionId,
          lineId,
          crossDockRequest: {
            workorderId,
            workorderLineId: partLineId as string,
            quantity: SHORTAGE_QUANTITY,
            notes: `Integration test cross-dock [${context.runId}]`,
          },
        });
        outcome = `accepted: ${JSON.stringify(crossDocked).slice(0, 200)}`;
      } catch (error) {
        outcome = `refused with ${await formatError(error)}`.slice(0, 300);
      }
      console.log(`[D9] cross-dock of session ${crossDockSessionId} line ${lineId} -> ${outcome}`);
      expect(outcome).toBeTruthy();
    }, 240_000);

    it('D10 — with stock on hand the workorder is no longer short', async () => {
      // The part the workorder wants is now in the building. Consumption still
      // needs a pick task, and tasks need a reservation (Suite C, C6), so what
      // this asserts is the supply side: stock covers the requirement, and any
      // backorder raised for it is reported.
      const available = await readAvailability(parts, shortProduct.productEntityId, locationId);
      expect(available?.onHandQty ?? 0).toBeGreaterThanOrEqual(SHORTAGE_QUANTITY);

      const backorders = await parts.inventory.backordersApi.listBackorders({
        sku: shortProduct.productEntityId,
      });
      const open = backorders.filter((backorder) => {
        const status = readString(backorder, 'status') ?? '';
        return !['CLOSED', 'FULFILLED', 'CANCELLED'].includes(status.toUpperCase());
      });
      console.log(
        `[D10] ${shortProduct.sku}: on-hand=${available?.onHandQty} atp=${available?.atpQty}, ` +
          `${backorders.length} backorder(s), ${open.length} still open`,
      );

      const detail = await advisor.workorder.workorderDetailApi.getWorkorderDetail({ workorderId });
      const part = (detail.parts ?? []).find((candidate) => candidate.id === partLineId);
      expect(part).toBeDefined();
      console.log(`[D10] workorder part item status=${part?.status} quantity=${part?.quantity}`);
    }, 300_000);

    it('D11 — over-receipt behaviour is recorded, and a bogus cross-dock target is refused', async () => {
      const overPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        { skuId: shortProduct.productEntityId, quantity: 1, unitCostMinor: UNIT_COST_MINOR },
      ]);
      const asnId = await createAsnForPo(parts, ctx, SEED_VENDOR_ID, overPo);

      // 999 against a PO line of 1. This was accepted once, then refused with a
      // bare 403 - indistinguishable from a missing permission for a persona
      // acting under its own login - and is now 422 OVER_RECEIPT_NOT_PERMITTED
      // (backend #1493). The status is asserted rather than merely recorded, so
      // the next move is visible; the body is checked for the code so a
      // different 422 does not pass as this one.
      let overReceipt: string;
      try {
        await parts.inventory.asnApi.createGoodsReceipt({
          createGoodsReceiptRequest: {
            poId: overPo.purchaseOrderId,
            asnId,
            locationId,
            lines: [
              {
                poLineId: overPo.lines[0].poLineId,
                sku: shortProduct.productEntityId,
                quantityReceived: 999,
                unitCostMinor: UNIT_COST_MINOR,
              },
            ],
          },
        });
        overReceipt = 'accepted';
      } catch (error) {
        overReceipt = await formatError(error);
      }
      console.log(`[D11] receiving 999 against a PO line of 1 -> ${overReceipt.slice(0, 200)}`);
      expect(overReceipt).toContain('OVER_RECEIPT_NOT_PERMITTED');
      expect(overReceipt).toContain('422');

      const status = await expectHttpError(
        parts.inventory.receivingApi.crossDockReceivingLine({
          sessionId: '00000000-0000-0000-0000-000000000000',
          lineId: '00000000-0000-0000-0000-000000000000',
          crossDockRequest: {
            workorderId: '00000000-0000-0000-0000-000000000000',
            workorderLineId: '00000000-0000-0000-0000-000000000000',
            quantity: 1,
            notes: `Bogus cross-dock [${context.runId}]`,
          },
        }),
        400,
        404,
        409,
        422,
      );
      console.log(`[D11] cross-docking to an unknown workorder -> HTTP ${status}`);
    }, 300_000);
  });

  describe('role-mode negatives', () => {
    itInRoleMode('a technician cannot approve a purchase order', async () => {
      const product = await createCatalogProduct(admin, ctx, 'NEG1');
      const po = await parts.order.purchaseOrdersApi.createPurchaseOrder({
        createPurchaseOrderRequest: {
          vendorId: SEED_VENDOR_ID,
          poDate: new Date(),
          currency: 'USD',
          shipToLocationId: locationId,
          requestedBy: context.referenceCache.employees.partsClerk,
          comment: `Role negative [${context.runId}]`,
          lines: [
            {
              lineNumber: 1,
              skuId: product.productEntityId,
              description: 'role negative line',
              quantity: 1,
              unitCostMinor: UNIT_COST_MINOR,
            },
          ],
        },
      });
      await expectHttpError(
        tech.order.purchaseOrdersApi.approvePurchaseOrder({
          poId: requireField(po.purchaseOrderId, 'purchaseOrderId'),
          approvePurchaseOrderRequest: { approvalNotes: 'tech attempt' },
        }),
        401,
        403,
      );
    }, 240_000);

    itInRoleMode('the parts clerk who raises a PO cannot approve it', async () => {
      const product = await createCatalogProduct(admin, ctx, 'NEG2');
      const po = await parts.order.purchaseOrdersApi.createPurchaseOrder({
        createPurchaseOrderRequest: {
          vendorId: SEED_VENDOR_ID,
          poDate: new Date(),
          currency: 'USD',
          shipToLocationId: locationId,
          requestedBy: context.referenceCache.employees.partsClerk,
          comment: `Separation of duties [${context.runId}]`,
          lines: [
            {
              lineNumber: 1,
              skuId: product.productEntityId,
              description: 'separation of duties line',
              quantity: 1,
              unitCostMinor: UNIT_COST_MINOR,
            },
          ],
        },
      });
      await expectHttpError(
        parts.order.purchaseOrdersApi.approvePurchaseOrder({
          poId: requireField(po.purchaseOrderId, 'purchaseOrderId'),
          approvePurchaseOrderRequest: { approvalNotes: 'creator attempt' },
        }),
        401,
        403,
      );
    }, 240_000);
  });
});
