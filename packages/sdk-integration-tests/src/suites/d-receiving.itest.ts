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
import { call, expectHttpError, isHttpStatus } from '../harness/http';
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

    it('D6 — staging-based receiving is unavailable: the source lookup is a disabled stub', async () => {
      const secondPo = await createApprovedPo(parts, manager, ctx, SEED_VENDOR_ID, [
        {
          skuId: product.productEntityId,
          quantity: SESSION_QUANTITY,
          unitCostMinor: UNIT_COST_MINOR,
        },
      ]);

      // A receiving session is built from the source document's lines, which
      // pos-inventory fetches through SourceDocumentStubClient. That client is
      // gated on pos.inventory.receiving.stub.enabled, false by default, and its
      // path points at a /stub/... service that does not exist - the real
      // upstream client was never written. So the session cannot be created, and
      // with it the staging and cross-dock steps this suite was specified to
      // cover. Asserted rather than skipped, so the day it starts working this
      // test fails and says so.
      const status = await expectHttpError(
        parts.inventory.receivingApi.createReceivingSession({
          createReceivingSessionRequest: { sourceDocumentId: secondPo.purchaseOrderId },
        }),
        404,
      );
      console.log(
        `[D6] createReceivingSession for an approved PO -> HTTP ${status}: no receiving lines from pos-order`,
      );
    }, 240_000);
  });

  describe('part 2 — receiving for a workorder that is short', () => {
    let shortProduct: CreatedProduct;
    let workorderId: string;
    let partLineId: string | undefined;
    let shortagePo: CreatedPo;

    it('D7 — a workorder for an unstocked part raises no shortage signal', async () => {
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
      // unfulfillable pick task. This backend raises neither. Nothing allocates
      // against a promoted workorder on its own - pick tasks require a pick list
      // that must be requested (Suite C, C6) - so a workorder for a part with no
      // stock simply sits there, and the shortage is invisible until somebody
      // looks at availability. Asserted so that the day either signal appears,
      // this test fails and says so.
      const backorders = await parts.inventory.backordersApi.listBackorders({
        sku: shortProduct.productEntityId,
      });
      const pickTasks = await tech.workorder.workorderPickFacadeApi
        .getPickTasks({ workorderId })
        .catch((error) => {
          if (isHttpStatus(error, 404)) return [];
          throw error;
        });
      const availability = await readAvailability(parts, shortProduct.productEntityId, locationId);

      console.log(
        `[D7] ${shortProduct.sku}: ${backorders.length} backorder(s), ${pickTasks.length} pick task(s), ` +
          `availability ${availability ? JSON.stringify(availability) : 'absent (404)'}`,
      );
      expect(backorders).toHaveLength(0);
      expect(pickTasks).toHaveLength(0);
      expect(availability?.onHandQty ?? 0).toBe(0);
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
      await receiveFully(shortagePo, shortProduct, SHORTAGE_QUANTITY);

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

    it('D9 — cross-docking needs a receiving session, which this backend cannot build', async () => {
      // The cross-dock endpoint addresses a session line: {sessionId, lineId}.
      // With sessions unavailable (D6) there is no line to cross-dock, so what
      // is asserted is the shape of the refusal for ids that cannot exist,
      // rather than pretending the happy path ran.
      const status = await expectHttpError(
        parts.inventory.receivingApi.crossDockReceivingLine({
          sessionId: '00000000-0000-0000-0000-000000000000',
          lineId: '00000000-0000-0000-0000-000000000000',
          crossDockRequest: {
            workorderId,
            workorderLineId: partLineId as string,
            quantity: SHORTAGE_QUANTITY,
            notes: `Integration test cross-dock [${context.runId}]`,
          },
        }),
        400,
        404,
        409,
        422,
      );
      console.log(`[D9] cross-dock against an unbuildable session -> HTTP ${status}`);
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

      // 999 against a PO line of 1. Some backends reject it, some accept it as an
      // over-receipt; the test records which this one does rather than presuming.
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
        overReceipt = `rejected with HTTP ${(error as { response?: { status?: number } }).response?.status}`;
      }
      console.log(`[D11] receiving 999 against a PO line of 1 -> ${overReceipt}`);
      expect(overReceipt).toBeTruthy();

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
