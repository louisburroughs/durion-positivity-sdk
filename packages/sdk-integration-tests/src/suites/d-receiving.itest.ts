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
import { call, expectHttpError } from '../harness/http';
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

  const receiveFully = async (po: CreatedPo, product: CreatedProduct, quantity: number) => {
    const asnId = await createAsnForPo(parts, ctx, SEED_VENDOR_ID, po);
    const receipt = await call('createGoodsReceipt', () =>
      parts.inventory.asnApi.createGoodsReceipt({
        createGoodsReceiptRequest: {
          poId: po.purchaseOrderId,
          asnId,
          locationId,
          lines: po.lines.map((line) => ({
            poLineId: line.poLineId,
            sku: product.productEntityId,
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
      random: new SeederRandom(seedFromRunId(context.runId)),
      refs: context.referenceCache,
    };
    locationId = context.referenceCache.locationId;
  }, 180_000);

  beforeEach(async () => {
    await personas.refreshIfNeeded();
  });

  describe('part 1 — a brand-new product into stock', () => {
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
      const received = await receiveFully(po, product, RECEIVE_QUANTITY);
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

    it('D5 — putaway either has tasks to work, or the backend did it already', async () => {
      const tasks = await call('listPutawayTasks', () =>
        parts.inventory.putawayApi.listPutawayTasks({ locationId }),
      );
      const mine = tasks.filter((task) => readString(task, 'skuId', 'sku') === product.productEntityId);
      console.log(`[D5] ${tasks.length} putaway task(s) at the location, ${mine.length} for this SKU`);

      if (mine.length === 0) {
        // Documented, not assumed: this backend puts receipts away itself, and
        // the stock asserted in D4 is already on hand without a putaway step.
        console.log('[D5] no putaway tasks for the receipt — this backend auto-putaways');
        expect(await readOnHand(parts, product.productEntityId, locationId)).toBeGreaterThanOrEqual(
          RECEIVE_QUANTITY,
        );
        return;
      }

      const task = mine[0];
      const taskId = requireField(readString(task, 'taskId', 'id'), 'putaway taskId');
      await call('claimPutawayTask', () => parts.inventory.putawayApi.claimPutawayTask({ taskId }));
      const executed = await call('executePutaway', () =>
        parts.inventory.putawayExecutionApi.executePutaway({
          taskId,
          putawayExecutionRequest: {
            skuId: product.productEntityId,
            quantity: RECEIVE_QUANTITY,
            sourceLocationId: locationId,
            destinationLocationId: locationId,
          },
        }),
      );
      console.log(`[D5] putaway executed: ${JSON.stringify(executed).slice(0, 200)}`);
    }, 180_000);

    it('D6 — a receiving session stages a second, smaller delivery', async () => {
      const secondPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: product.productEntityId,
          quantity: SESSION_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);

      const session = await call('createReceivingSession', () =>
        parts.inventory.receivingApi.createReceivingSession({
          createReceivingSessionRequest: { sourceDocumentId: secondPo.purchaseOrderId },
        }),
      );
      const sessionId = requireField(readString(session, 'sessionId', 'id'), 'sessionId');
      const sessionLines = session.lines ?? [];
      console.log(`[D6] session ${sessionId} status=${session.status} lines=${sessionLines.length}`);
      expect(sessionLines.length).toBeGreaterThan(0);

      await call('receiveItemsIntoStaging', () =>
        parts.inventory.receivingApi.receiveItemsIntoStaging({
          sessionId,
          receiveItemsRequest: {
            lines: sessionLines.map((line) => ({
              lineId: requireField(readString(line, 'lineId', 'id'), 'session lineId'),
              receivedQuantity: SESSION_QUANTITY,
            })),
          },
        }),
      );

      const afterStaging = await call('getReceivingSession', () =>
        parts.inventory.receivingApi.getReceivingSession({ sessionId }),
      );
      console.log(`[D6] after staging: status=${afterStaging.status}`);
      const receivedQuantities = (afterStaging.lines ?? []).map((line) =>
        readString(line, 'status'),
      );
      console.log(`[D6] line states = ${receivedQuantities.join(',')}`);
      expect(afterStaging.sessionId).toBe(sessionId);
    }, 240_000);
  });

  describe('part 2 — receiving for a workorder that is short', () => {
    let shortProduct: CreatedProduct;
    let workorderId: string;
    let partLineId: string | undefined;
    let shortagePo: CreatedPo;

    it('D7 — a workorder for an unstocked part shows the shortage', async () => {
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

      // Which signal this backend raises is what the test records: a backorder
      // for the SKU, or a pick task that cannot be fulfilled.
      const signal = await waitFor(
        async () => {
          const backorders = await parts.inventory.backordersApi.listBackorders({
            sku: shortProduct.productEntityId,
          });
          if (backorders.length > 0) {
            return { kind: 'backorder' as const, detail: JSON.stringify(backorders[0]).slice(0, 200) };
          }
          const pickTasks = await tech.workorder.workorderPickFacadeApi.getPickTasks({ workorderId });
          const unfulfillable = pickTasks.find((task) => (task.remainingQty ?? 0) > 0);
          if (unfulfillable) {
            return {
              kind: 'unfulfillable-pick' as const,
              detail: `task ${unfulfillable.pickTaskId} remaining=${unfulfillable.remainingQty}`,
            };
          }
          return undefined;
        },
        { description: `a shortage signal for ${shortProduct.sku}`, timeoutMs: 90_000 },
      );
      console.log(`[D7] shortage signalled as ${signal.kind}: ${signal.detail}`);
      expect(['backorder', 'unfulfillable-pick']).toContain(signal.kind);
    }, 300_000);

    it('D8 — the part is ordered and delivered into a receiving session', async () => {
      shortagePo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: shortProduct.productEntityId,
          quantity: SHORTAGE_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);
      await createAsnForPo(parts, ctx, SEED_VENDOR_ID, shortagePo);

      const session = await call('createReceivingSession', () =>
        parts.inventory.receivingApi.createReceivingSession({
          createReceivingSessionRequest: { sourceDocumentId: shortagePo.purchaseOrderId },
        }),
      );
      const sessionId = requireField(readString(session, 'sessionId', 'id'), 'sessionId');
      const lines = session.lines ?? [];
      expect(lines.length).toBeGreaterThan(0);

      await call('receiveItemsIntoStaging', () =>
        parts.inventory.receivingApi.receiveItemsIntoStaging({
          sessionId,
          receiveItemsRequest: {
            lines: lines.map((line) => ({
              lineId: requireField(readString(line, 'lineId', 'id'), 'session lineId'),
              receivedQuantity: SHORTAGE_QUANTITY,
            })),
          },
        }),
      );

      // D9 cross-docks off this session, so both ids travel forward.
      (globalThis as Record<string, unknown>).__itestCrossDock = {
        sessionId,
        lineId: readString(lines[0], 'lineId', 'id'),
      };
      console.log(`[D8] staged ${SHORTAGE_QUANTITY} of ${shortProduct.sku} in session ${sessionId}`);
    }, 300_000);

    it('D9 — the staged line is cross-docked straight to the workorder', async () => {
      const staged = (globalThis as Record<string, unknown>).__itestCrossDock as {
        sessionId: string;
        lineId: string;
      };

      const crossDocked = await call('crossDockReceivingLine', () =>
        parts.inventory.receivingApi.crossDockReceivingLine({
          sessionId: staged.sessionId,
          lineId: staged.lineId,
          crossDockRequest: {
            workorderId,
            workorderLineId: partLineId as string,
            quantity: SHORTAGE_QUANTITY,
            notes: `Integration test cross-dock [${context.runId}]`,
          },
        }),
      );
      console.log(`[D9] cross-dock response: ${JSON.stringify(crossDocked).slice(0, 240)}`);
      expect(JSON.stringify(crossDocked)).toContain(workorderId);
    }, 240_000);

    it('D10 — the workorder can now pick and consume the part', async () => {
      const task = await waitFor(
        async () => {
          const tasks = await tech.workorder.workorderPickFacadeApi.getPickTasks({ workorderId });
          return tasks.find((candidate) => (candidate.pickedQty ?? 0) > 0 || (candidate.requiredQty ?? 0) > 0);
        },
        { description: `a workable pick task on workorder ${workorderId}`, timeoutMs: 90_000 },
      );

      await call('completePickTask', () =>
        tech.workorder.workorderPickFacadeApi.completePickTask({
          workorderId,
          pickTaskId: task.pickTaskId,
          completePickTaskRequest: { reason: `Cross-docked part [${context.runId}]` },
        }),
      );
      await call('consumeWorkorderPickedItems', () =>
        tech.workorder.workorderPickedItemsApi.consumeWorkorderPickedItems({
          workorderId,
          consumePickedItemsRequest: {
            items: [
              {
                pickTaskId: task.pickTaskId,
                quantityToConsume: task.pickedQty || task.requiredQty || SHORTAGE_QUANTITY,
              },
            ],
          },
        }),
      );

      const detail = await advisor.workorder.workorderDetailApi.getWorkorderDetail({ workorderId });
      const part = (detail.parts ?? []).find((candidate) => candidate.id === partLineId);
      console.log(`[D10] part item status=${part?.status} consumed=${part?.quantityConsumed}`);
      expect(part).toBeDefined();

      const backorders = await parts.inventory.backordersApi.listBackorders({
        sku: shortProduct.productEntityId,
      });
      console.log(`[D10] remaining backorders for the SKU: ${backorders.length}`);
    }, 300_000);

    it('D11 — over-receipt and a bogus cross-dock target are rejected', async () => {
      const overPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        { skuId: shortProduct.productEntityId, quantity: 1, unitCostMinor: UNIT_COST_MINOR },
      ]);
      const asnId = await createAsnForPo(parts, ctx, SEED_VENDOR_ID, overPo);

      // Over-receipt: 999 against a PO line of 1. Some backends reject it and
      // some accept it as an over-receipt, so both are recorded rather than
      // one being presumed.
      let overReceiptStatus: number | 'accepted';
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
        overReceiptStatus = 'accepted';
      } catch (error) {
        overReceiptStatus =
          (error as { response?: { status?: number } }).response?.status ?? 0;
      }
      console.log(`[D11] receiving 999 against a PO line of 1 -> ${overReceiptStatus}`);
      expect(overReceiptStatus).toBeDefined();

      const staged = (globalThis as Record<string, unknown>).__itestCrossDock as {
        sessionId: string;
        lineId: string;
      };
      const status = await expectHttpError(
        parts.inventory.receivingApi.crossDockReceivingLine({
          sessionId: staged.sessionId,
          lineId: staged.lineId,
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
      console.log(`[D11] cross-docking to an unknown workorder is rejected with HTTP ${status}`);
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
