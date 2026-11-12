import { buildCatalog } from '../catalog/buildCatalog';
import { continueVisit } from './carryOver';
import { buildDayPlan, type DayPlanOptions, type Visit } from './dayPlan';
import { harvestFacts, missingPrerequisite, stageScenario } from './visitScenarios';

const catalog = buildCatalog();
const OPTIONS: DayPlanOptions = {
  visitsMin: 30,
  visitsMax: 30,
  tenantMax: 1000,
  newCustomerRatio: 0.4,
  commercialRatio: 0.4,
  newVehicleRatio: 0.3,
  stockPartsRatio: 0.45,
  specialOrderRatio: 0.2,
  openTime: '08:00',
  closeTime: '17:30',
  seed: 0,
};
const SITE = { id: '0190aaaa-0000-7000-8000-00000000000a', code: 'MAIN', name: 'Main Street', slug: 'main', positions: 6 };
const visits = ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'].flatMap((date) => buildDayPlan(date, [SITE], OPTIONS).visits);
const find = (test: (visit: Visit) => boolean): Visit => {
  const visit = visits.find(test);
  if (!visit) {
    throw new Error('no such visit in the sample');
  }
  return visit;
};
const scenarioFor = (visit: Visit, stage: number, memory: Record<string, string> = {}, roleMode = false) =>
  stageScenario(visit, visit.stages[stage], memory, { roleMode });
/** The stage with this name, whatever position it has in the visit. */
const stageNamed = (visit: Visit, name: string, memory: Record<string, string> = {}, roleMode = false) => {
  const stage = visit.stages.find((entry) => entry.name === name);
  if (!stage) {
    throw new Error(`${visit.id} has no ${name} stage`);
  }
  return stageScenario(visit, stage, memory, { roleMode });
};

describe('stageScenario', () => {
  it('names only operations the generated clients have, none of them destructive, for every kind of visit', () => {
    const problems: string[] = [];
    const all = [...visits, ...visits.filter((visit) => visit.parts === 'special-order').map((visit) => continueVisit(visit, '2026-03-10', '2026-03-11', OPTIONS))];
    for (const visit of all) {
      for (const stage of visit.stages) {
        const scenario = stageScenario(visit, stage, {}, { roleMode: true });
        expect(scenario.id).toBe(stage.id);
        expect(scenario.operations.length).toBeLessThanOrEqual(21);
        for (const id of scenario.operations) {
          const operation = catalog.byId.get(id);
          if (!operation) {
            problems.push(`${stage.id}: unknown ${id}`);
          } else if (operation.risk === 'destructive') {
            problems.push(`${stage.id}: destructive ${id}`);
          }
        }
        for (const expectation of scenario.expect) {
          if (expectation.kind === 'call' && !scenario.operations.includes(expectation.operation)) {
            problems.push(`${stage.id}: expects unpinned ${expectation.operation}`);
          }
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('tells every stage which shop it is at, by id, and never asks the agent to choose one', () => {
    for (const visit of visits.slice(0, 40)) {
      for (const stage of visit.stages) {
        const scenario = stageScenario(visit, stage, { workorderId: 'w-1' }, { roleMode: false });
        expect([stage.id, scenario.goal.includes(`location id ${SITE.id}`)]).toEqual([stage.id, true]);
        expect(scenario.goal).not.toMatch(/[Pp]ick an active shop location/);
      }
    }
  });

  it('has a new individual created as a person, with the identity from the roster', () => {
    const visit = find((entry) => entry.kind === 'service' && entry.customer.status === 'new' && entry.customer.type === 'individual');
    const scenario = scenarioFor(visit, 0);
    expect(scenario.goal).toContain(`${visit.customer.person?.firstName} ${visit.customer.person?.lastName}`);
    expect(scenario.goal).toContain(visit.customer.person?.email);
    expect(scenario.operations).toContain('customer.CRMPersonsApi.createCrmPerson');
    expect(scenario.expect).toContainEqual({ kind: 'call', operation: 'customer.CRMPersonsApi.createCrmPerson', outcome: 'any' });
    expect(scenario.goal).toContain(visit.vehicle.details?.vin);
    expect(scenario.expect).toContainEqual({ kind: 'call', operation: 'vehicle-inventory.VehicleRegistryAPIApi.createVehicle', outcome: 'any' });
  });

  it('has a new business created as a commercial account with billing terms', () => {
    const visit = find((entry) => entry.kind === 'service' && entry.customer.status === 'new' && entry.customer.type === 'commercial');
    const scenario = scenarioFor(visit, 0);
    expect(scenario.goal).toContain(visit.customer.company?.legalName);
    expect(scenario.operations).toEqual(
      expect.arrayContaining(['customer.CRMAccountsApi.createCrmCommercialAccount', 'customer.CRMAccountsApi.listBillingTerms']),
    );
    expect(scenario.operations).not.toContain('customer.CRMPersonsApi.createCrmPerson');
  });

  it('has a returning customer found, never created', () => {
    const visit = find(
      (entry) => entry.kind === 'service' && entry.customer.status === 'existing' && entry.customer.type === 'commercial' && entry.vehicle.status === 'existing',
    );
    const scenario = scenarioFor(visit, 0);
    expect(scenario.goal).toMatch(/commercial account \(a business\) already on file/);
    expect(scenario.goal).toContain(`contains "${visit.customer.search?.fragment}"`);
    expect(scenario.goal).toMatch(/do not create one/);
    expect(scenario.operations).not.toContain('customer.CRMAccountsApi.createCrmCommercialAccount');
    expect(scenario.operations).not.toContain('customer.CRMPersonsApi.createCrmPerson');
    expect(scenario.goal).toMatch(/vehicles already on file/);
  });

  it('follows what the customer decides: promote on approval, decline otherwise', () => {
    const approves = scenarioFor(find((entry) => entry.kind === 'service' && entry.disposition === 'approves'), 0);
    expect(approves.expect).toContainEqual({ kind: 'call', operation: 'workorder.EstimateAPIApi.promoteEstimate', outcome: 'any' });
    expect(approves.operations).not.toContain('workorder.EstimateAPIApi.declineEstimate');

    const declines = scenarioFor(find((entry) => entry.disposition === 'declines' && entry.kind === 'service'), 0);
    expect(declines.expect).toContainEqual({ kind: 'call', operation: 'workorder.EstimateAPIApi.declineEstimate', outcome: 'any' });
    expect(declines.operations).not.toContain('workorder.EstimateAPIApi.promoteEstimate');
  });

  it('starts from the booked appointment when the customer arrives on one', () => {
    const scenario = scenarioFor(find((entry) => entry.arrival === 'appointment'), 0);
    expect(scenario.operations).toContain('workorder.EstimatesFromAppointmentsApi.createEstimateFromAppointment');
    expect(scenario.goal).toMatch(/arriving for an appointment/);
  });

  it('hands later stages what earlier ones established', () => {
    const visit = find((entry) => entry.kind === 'service' && entry.disposition === 'approves' && entry.parts !== 'special-order');
    const memory = { partyId: 'p-1', workorderId: 'w-7', customerName: 'Dana Ortiz' };
    const work = stageNamed(visit, 'work', memory);
    expect(work.persona).toBe('manager');
    expect(work.goal).toContain('- workorderId: w-7');
    expect(work.goal).toContain('- customerName: Dana Ortiz');
    expect(scenarioFor(visit, 0).goal).not.toContain('Already established');
  });

  it('raises a change request when more work is found on the lift', () => {
    const work = stageNamed(find((entry) => entry.disposition === 'approves-then-adds-work' && entry.kind === 'service' && entry.parts !== 'special-order'), 'work');
    expect(work.operations).toEqual(
      expect.arrayContaining(['workorder.ChangeRequestAPIApi.createChangeRequest', 'workorder.ChangeRequestAPIApi.approveChangeRequest']),
    );
    expect(work.goal).toMatch(/change request/);
  });

  it('tells the manager to act as the technician only when the technician has a login of their own', () => {
    const visit = find((entry) => entry.kind === 'service' && entry.disposition === 'approves' && entry.parts !== 'special-order');
    expect(stageNamed(visit, 'work', {}, true).goal).toMatch(/persona "tech"/);
    expect(stageNamed(visit, 'work', {}, false).goal).not.toMatch(/persona "tech"/);
  });

  it('takes cash from a customer who pays at pickup and bills an account customer instead', () => {
    const cash = stageNamed(find((entry) => entry.kind === 'service' && entry.payment === 'cash' && entry.stages.length === 3), 'checkout');
    expect(cash.goal).toMatch(/record a cash payment/);
    const account = stageNamed(find((entry) => entry.kind === 'service' && entry.payment === 'on-account' && entry.stages.length === 3), 'checkout');
    expect(account.goal).toMatch(/billed on account: do not take payment/);
  });

  it('puts a stock part on the estimate and has it picked and issued on the job', () => {
    const visit = find((entry) => entry.parts === 'stock' && entry.disposition === 'approves');
    const intake = stageNamed(visit, 'intake');
    expect(intake.goal).toMatch(/a part the shop keeps on the shelf/);
    expect(intake.operations).toContain('inventory.InventoryStockApi.listStock');
    const work = stageNamed(visit, 'work', { workorderId: 'w-1' });
    expect(work.goal).toMatch(/uses a part from the shop's stock/);
    expect(work.operations).toEqual(
      expect.arrayContaining(['workorder.WorkorderPickFacadeApi.getPickTasks', 'workorder.WorkorderPartsUsageApi.issueParts']),
    );
    expect(visit.stages.map((stage) => stage.name)).toEqual(['intake', 'work', 'checkout']);
  });

  it('leaves a labor-only job free of parts work', () => {
    const visit = find((entry) => entry.kind === 'service' && entry.parts === 'none' && entry.disposition === 'approves');
    expect(stageNamed(visit, 'intake').goal).not.toMatch(/part line/);
    expect(stageNamed(visit, 'work').operations).not.toContain('workorder.WorkorderPartsUsageApi.issueParts');
  });

  describe('a job that needs a part ordered in', () => {
    const visit = find((entry) => entry.parts === 'special-order' && entry.disposition === 'approves');
    /** The same job the next day, when the part is delivered. */
    const nextDay = continueVisit(visit, '2026-03-10', '2026-03-11', OPTIONS);
    const memory = { workorderId: 'w-1', partProductId: 'prod-9', purchaseOrderId: 'po-1', partLineId: 'line-3' };

    it('puts an unstocked part on the estimate', () => {
      const intake = stageNamed(visit, 'intake');
      expect(intake.goal).toMatch(/a part the shop does not keep in stock/);
      expect(intake.goal).toMatch(/arrive on the next working day/);
      expect(intake.goal).toMatch(/nothing on hand at this location/);
      expect(intake.operations).toEqual(
        expect.arrayContaining(['catalog.ProductsAPIApi.searchCatalogProducts', 'inventory.InventoryAvailabilityApi.getAvailabilityByProduct']),
      );
    });

    it('has the parts clerk raise a purchase order for the job and get it approved', () => {
      const order = stageNamed(visit, 'order', memory);
      expect(order.persona).toBe('parts');
      expect(order.goal).toContain('- workorderId: w-1');
      expect(order.goal).toMatch(/the workorder id set on the line/);
      expect(order.operations).toEqual(
        expect.arrayContaining(['order.PurchaseOrdersApi.createPurchaseOrder', 'order.PurchaseOrdersApi.approvePurchaseOrder']),
      );
      expect(order.expect).toContainEqual({ kind: 'call', operation: 'order.PurchaseOrdersApi.createPurchaseOrder', outcome: 'any' });
      // Separation of duties only when there is a second login to hold the other duty.
      expect(stageNamed(visit, 'order', memory, true).goal).toMatch(/persona "manager"/);
      expect(order.goal).not.toMatch(/persona "manager"/);
    });

    it('receives the delivery against the workorder, with a fallback into stock', () => {
      const receive = stageNamed(nextDay, 'receive', memory);
      expect(receive.id).toBe(`${nextDay.id}-receive`);
      expect(receive.goal).toMatch(/the part ordered on 2026-03-10 for a waiting job/);
      expect(receive.persona).toBe('parts');
      expect(receive.goal).toContain('- purchaseOrderId: po-1');
      expect(receive.goal).toMatch(/Receive it against the job, not into general stock/);
      expect(receive.operations).toEqual(
        expect.arrayContaining([
          'inventory.ReceivingApi.createReceivingSession',
          'inventory.ReceivingApi.crossDockReceivingLine',
          'inventory.ASNApi.createGoodsReceipt',
        ]),
      );
    });

    it('finishes the job only once the part is there', () => {
      const work = stageNamed(nextDay, 'work', { ...memory, partsStatus: 'received' });
      expect(work.goal).toMatch(/has been waiting since 2026-03-10 on a part ordered in/);
      expect(stageNamed(nextDay, 'checkout', memory).goal).toMatch(/first brought in on 2026-03-10/);
      expect(work.goal).toContain('- partsStatus: received');
      expect(work.goal).toMatch(/If the part has not arrived[\s\S]*waiting for parts/);
    });

    it('holds each stage back until what it depends on exists', () => {
      const stage = (name: string) => [...visit.stages, ...nextDay.stages].find((entry) => entry.name === name)!;
      expect(missingPrerequisite(stage('order'), {})).toMatch(/did not produce a workorder/);
      expect(missingPrerequisite(stage('order'), { workorderId: 'w-1' })).toBeUndefined();
      expect(missingPrerequisite(stage('receive'), { workorderId: 'w-1' })).toMatch(/no purchase order was raised/);
      expect(missingPrerequisite(stage('receive'), memory)).toBeUndefined();
    });
  });

  it('covers counter sales and phone bookings', () => {
    const sale = scenarioFor(find((entry) => entry.kind === 'counter-sale'), 0);
    expect(sale.expect).toContainEqual({ kind: 'call', operation: 'order.SalesOrdersApi.createCart', outcome: 'any' });
    const call = scenarioFor(find((entry) => entry.kind === 'appointment-call'), 0);
    expect(call.expect).toContainEqual({ kind: 'call', operation: 'shop-manager.AppointmentsAPIApi.createAppointment', outcome: 'any' });
  });
});

describe('missingPrerequisite', () => {
  const visit = find((entry) => entry.kind === 'service' && entry.stages.length === 3 && entry.parts !== 'special-order');

  it('holds back the work and the checkout until there is a workorder', () => {
    expect(missingPrerequisite(visit.stages[0], {})).toBeUndefined();
    expect(missingPrerequisite(visit.stages[1], {})).toMatch(/did not produce a workorder/);
    expect(missingPrerequisite(visit.stages[2], { estimateId: 'e-1' })).toMatch(/did not produce a workorder/);
    expect(missingPrerequisite(visit.stages[1], { workorderId: 'w-1' })).toBeUndefined();
  });
});

describe('harvestFacts', () => {
  it('takes ids from the responses that create them', () => {
    const memory: Record<string, string> = {};
    harvestFacts({ id: 'customer.CRMPersonsApi.createCrmPerson' }, { kind: 'success', body: { partyId: 'p-1' } }, memory);
    harvestFacts({ id: 'vehicle-inventory.VehicleRegistryAPIApi.createVehicle' }, { kind: 'success', body: { vehicleId: 'v-1' } }, memory);
    harvestFacts({ id: 'workorder.EstimateAPIApi.createEstimate' }, { kind: 'success', body: { id: 'e-1' } }, memory);
    harvestFacts({ id: 'workorder.EstimateAPIApi.promoteEstimate' }, { kind: 'success', body: { id: 'w-1' } }, memory);
    harvestFacts({ id: 'workorder.WorkOrderAPIApi.completeWorkorder' }, { kind: 'success', body: {} }, memory);
    harvestFacts({ id: 'workorder.WorkOrderAPIApi.generateWorkorderInvoice' }, { kind: 'success', body: { invoiceId: 'i-1' } }, memory);
    harvestFacts({ id: 'order.PurchaseOrdersApi.createPurchaseOrder' }, { kind: 'success', body: { purchaseOrderId: 'po-1' } }, memory);
    harvestFacts({ id: 'inventory.ReceivingApi.createReceivingSession' }, { kind: 'success', body: { sessionId: 's-1' } }, memory);
    harvestFacts({ id: 'inventory.ReceivingApi.crossDockReceivingLine' }, { kind: 'success', body: {} }, memory);
    expect(memory).toEqual({
      partyId: 'p-1',
      vehicleId: 'v-1',
      estimateId: 'e-1',
      workorderId: 'w-1',
      workStatus: 'completed',
      invoiceId: 'i-1',
      purchaseOrderId: 'po-1',
      receivingSessionId: 's-1',
      partsStatus: 'received',
    });
  });

  it('ignores failures, responses without the id, and operations it has no rule for', () => {
    const memory: Record<string, string> = {};
    harvestFacts({ id: 'workorder.EstimateAPIApi.promoteEstimate' }, { kind: 'http-error', body: { id: 'w-1' } }, memory);
    harvestFacts({ id: 'workorder.WorkOrderAPIApi.generateWorkorderInvoice' }, { kind: 'success', body: { status: 'REQUESTED' } }, memory);
    harvestFacts({ id: 'location.LocationAPIApi.listLocations' }, { kind: 'success', body: [{ id: 'l-1' }] }, memory);
    expect(memory).toEqual({});
  });
});
