import { SeederRandom } from '@durion-sdk/seeder';
import { AddEstimateItemRequestItemTypeEnum } from '@durion-sdk/workorder';
import {
  addLaborLine,
  addPartLine,
  createPersonAccount,
  promoteWhenPromotable,
  createVehicle,
  readNumber,
  readString,
  requireField,
  seedFromRunId,
  type BuilderContext,
  type CreatedCustomer,
} from '../harness/builders';
import { call, expectHttpError } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { Personas, type DomainClients } from '../harness/personas';

const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite B — the estimate lifecycle, from draft to promoted workorder.
 *
 * Prices are chosen by the test rather than randomised: B3 asserts the exact
 * arithmetic the backend must produce, which is only meaningful against known
 * inputs.
 */
describe('Suite B — estimates', () => {
  const LABOR_ONE_PRICE = 129.95;
  const LABOR_TWO_PRICE = 84.5;
  const PART_PRICE = 24.25;
  const PART_QUANTITY = 2;
  const EXPECTED_SUBTOTAL = LABOR_ONE_PRICE + LABOR_TWO_PRICE + PART_PRICE * PART_QUANTITY;

  let context: ItestContext;
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let tech: DomainClients;
  let customer: CreatedCustomer;
  let vehicleId: string;
  let serviceIds: string[];
  let productId: string;

  /** A fresh party + vehicle + draft estimate, for the steps that need their own. */
  const freshEstimate = async (): Promise<{ estimateId: string; customer: CreatedCustomer }> => {
    const party = await createPersonAccount(advisor, ctx);
    const vehicle = await createVehicle(admin, ctx, party.partyId);
    const estimateId = await call('createEstimate', async () => {
      const estimate = await advisor.workorder.estimateAPIApi.createEstimate({
        createEstimateRequest: {
          customerId: party.partyId,
          vehicleId: vehicle,
          crmPartyId: party.partyId,
          crmVehicleId: vehicle,
          crmContactIds: [],
          currencyUomId: 'USD',
          locationId: context.referenceCache.locationId,
        },
      });
      return requireField(readString(estimate, 'id', 'estimateId'), 'estimateId');
    });
    return { estimateId, customer: party };
  };

  const statusOf = async (estimateId: string): Promise<string> => {
    const estimate = await call('getEstimate', () =>
      advisor.workorder.estimateAPIApi.getEstimate({ estimateId }),
    );
    return estimate.status;
  };

  beforeAll(async () => {
    context = loadContext();
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    advisor = personas.as('advisor');
    admin = personas.as('admin');
    tech = personas.as('tech');
    ctx = {
      runId: context.runId,
      // Seeded per suite, not per run: a shared seed makes every suite generate
      // the same VIN, and VINs are globally unique across active vehicles.
      random: new SeederRandom(seedFromRunId(`${context.runId}:b-estimates`)),
      refs: context.referenceCache,
    };

    customer = await createPersonAccount(advisor, ctx);
    vehicleId = await createVehicle(admin, ctx, customer.partyId);
    serviceIds = context.referenceCache.serviceEntityIds.slice(0, 2);
    productId = context.referenceCache.productEntityIds[0];
  }, 180_000);

  beforeEach(async () => {
    await personas.refreshIfNeeded();
  });

  describe('the happy path, from draft to workorder', () => {
    let estimateId: string;
    let laborLineIds: string[];
    let partLineId: string | undefined;
    let workorderId: string;

    it('B1 — creates a draft estimate for a fresh party and vehicle', async () => {
      estimateId = await call('createEstimate', async () => {
        const estimate = await advisor.workorder.estimateAPIApi.createEstimate({
          createEstimateRequest: {
            customerId: customer.partyId,
            vehicleId,
            crmPartyId: customer.partyId,
            crmVehicleId: vehicleId,
            crmContactIds: [],
            currencyUomId: 'USD',
            locationId: context.referenceCache.locationId,
          },
        });
        return requireField(readString(estimate, 'id', 'estimateId'), 'estimateId');
      });
      expect(estimateId).toBeTruthy();

      const created = await advisor.workorder.estimateAPIApi.getEstimate({ estimateId });
      expect(created.crmPartyId ?? created.customerId).toBe(customer.partyId);
      console.log(`[B1] draft estimate status = ${created.status}`);
    });

    it('B2 — adds two labor lines and one part line, each returning an id', async () => {
      const laborOne = await addLaborLine(advisor, ctx, estimateId, serviceIds[0], LABOR_ONE_PRICE);
      const laborTwo = await addLaborLine(advisor, ctx, estimateId, serviceIds[1], LABOR_TWO_PRICE);
      partLineId = await addPartLine(advisor, ctx, estimateId, productId, PART_QUANTITY, PART_PRICE);

      laborLineIds = [laborOne, laborTwo];
      expect(laborOne).toBeTruthy();
      expect(laborTwo).toBeTruthy();
      expect(laborOne).not.toBe(laborTwo);
      expect(partLineId).toBeTruthy();
    });

    it('B3 — totals equal the arithmetic sum of those lines', async () => {
      const totals = await call('calculateEstimateTotals', () =>
        advisor.workorder.estimateAPIApi.calculateEstimateTotals({ estimateId }),
      );

      // calculateEstimateTotals is declared as a bare `object`, so its fields
      // are read rather than typed.
      const subtotal = readNumber(totals, 'subtotal');
      const taxAmount = readNumber(totals, 'taxAmount') ?? 0;
      const total = readNumber(totals, 'total');

      expect(subtotal).toBeCloseTo(EXPECTED_SUBTOTAL, 2);

      // Tax handling is the backend's to decide; this records what it does
      // rather than presuming a rate.
      console.log(`[B3] subtotal=${subtotal} taxAmount=${taxAmount} total=${total}`);
      expect(total).toBeCloseTo(EXPECTED_SUBTOTAL + taxAmount, 2);
    });

    it('B4 — submits for approval and moves off draft', async () => {
      const before = await statusOf(estimateId);
      await call('submitEstimateForApproval', () =>
        advisor.workorder.estimateAPIApi.submitEstimateForApproval({ estimateId }),
      );
      const after = await statusOf(estimateId);

      expect(after).not.toBe(before);
      console.log(`[B4] submit moved the estimate ${before} -> ${after}`);
    });

    it('B5 — approves with the customer signature', async () => {
      await call('approveEstimate', () =>
        advisor.workorder.estimateAPIApi.approveEstimate({
          estimateId,
          approveEstimateRequest: {
            customerId: customer.partyId,
            signatureData: ctx.random.base64(32),
            signerName: customer.fullName,
            signatureMimeType: 'image/png',
          },
        }),
      );

      const approved = await advisor.workorder.estimateAPIApi.getEstimate({ estimateId });
      expect(approved.status.toUpperCase()).toContain('APPROV');
      expect(approved.signerName).toBe(customer.fullName);
      console.log(`[B5] approved status = ${approved.status}`);
    });

    it('B7 — promotes to a workorder carrying every line', async () => {
      // Through the builder's helper, which tolerates the transient empty-bodied
      // 400 that a freshly created customer provokes (see promoteWhenPromotable).
      const promoted = await promoteWhenPromotable(advisor, estimateId);
      workorderId = requireField(readString(promoted, 'id', 'workorderId'), 'workorderId');

      const detail = await call('getWorkorderDetail', () =>
        advisor.workorder.workorderDetailApi.getWorkorderDetail({ workorderId }),
      );

      const serviceEntityIds = (detail.services ?? []).map((service) => service.serviceEntityId);
      expect(serviceEntityIds).toEqual(expect.arrayContaining(serviceIds));
      expect(detail.services ?? []).toHaveLength(laborLineIds.length);

      const part = (detail.parts ?? []).find((candidate) => candidate.productEntityId === productId);
      expect(part).toBeDefined();
      expect(part?.quantity).toBe(PART_QUANTITY);
    });

    it('B8 — a promoted estimate can no longer be approved or extended', async () => {
      const approveStatus = await expectHttpError(
        advisor.workorder.estimateAPIApi.approveEstimate({
          estimateId,
          approveEstimateRequest: {
            customerId: customer.partyId,
            signatureData: ctx.random.base64(16),
            signerName: customer.fullName,
            signatureMimeType: 'image/png',
          },
        }),
        400,
        409,
        422,
      );

      const addStatus = await expectHttpError(
        advisor.workorder.estimateAPIApi.addEstimateItem({
          estimateId,
          addEstimateItemRequest: {
            itemType: AddEstimateItemRequestItemTypeEnum.Labor,
            quantity: 1,
            unitPrice: 10,
            serviceId: serviceIds[0],
            description: `Late addition [${context.runId}]`,
          },
        }),
        400,
        409,
        422,
      );

      console.log(`[B8] approve-after-promote = HTTP ${approveStatus}, add-after-promote = HTTP ${addStatus}`);
    });
  });

  describe('B6 — the decline path', () => {
    it('declines a submitted estimate, and a declined estimate cannot be promoted', async () => {
      const { estimateId, customer: party } = await freshEstimate();
      await addLaborLine(advisor, ctx, estimateId, serviceIds[0], LABOR_ONE_PRICE);
      await call('calculateEstimateTotals', () =>
        advisor.workorder.estimateAPIApi.calculateEstimateTotals({ estimateId }),
      );
      await call('submitEstimateForApproval', () =>
        advisor.workorder.estimateAPIApi.submitEstimateForApproval({ estimateId }),
      );

      await call('declineEstimate', () =>
        advisor.workorder.estimateAPIApi.declineEstimate({
          estimateId,
          reason: `Customer ${party.fullName} declined [${context.runId}]`,
        }),
      );

      const declined = await advisor.workorder.estimateAPIApi.getEstimate({ estimateId });
      expect(declined.status.toUpperCase()).toContain('DECLIN');

      const status = await expectHttpError(
        advisor.workorder.estimateAPIApi.promoteEstimate({ estimateId }),
        400,
        409,
        422,
      );
      console.log(`[B6] declined status = ${declined.status}; promote rejected with HTTP ${status}`);
    }, 180_000);
  });

  describe('role-mode negatives', () => {
    itInRoleMode('a technician cannot approve an estimate', async () => {
      const { estimateId, customer: party } = await freshEstimate();
      await addLaborLine(advisor, ctx, estimateId, serviceIds[0], LABOR_ONE_PRICE);
      await advisor.workorder.estimateAPIApi.calculateEstimateTotals({ estimateId });
      await advisor.workorder.estimateAPIApi.submitEstimateForApproval({ estimateId });

      await expectHttpError(
        tech.workorder.estimateAPIApi.approveEstimate({
          estimateId,
          approveEstimateRequest: {
            customerId: party.partyId,
            signatureData: ctx.random.base64(16),
            signerName: party.fullName,
            signatureMimeType: 'image/png',
          },
        }),
        401,
        403,
      );
    }, 180_000);
  });
});
