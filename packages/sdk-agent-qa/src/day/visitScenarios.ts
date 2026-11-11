/**
 * Turns one stage of a customer visit into a task for the agent.
 *
 * A stage brief says who is at the counter and what they want, and leaves the
 * how to the agent. It carries forward what earlier stages learned (the visit's
 * memory), names the handful of operations the stage normally takes, and adds
 * the few facts about this backend that no schema reveals — where vehicles
 * really live, what a just-created customer does to the next call — because
 * those were each learned the hard way by the integration suites.
 */
import type { Operation } from '../catalog/types';
import { scenarioSchema, type ExpectationInput, type Persona, type Scenario } from '../scenarios/types';
import type { CallOutcome } from '../sdk/SdkInvoker';
import type { Visit, VisitStage } from './dayPlan';

export type VisitMemory = Record<string, string>;

export interface StageContext {
  /** Whether personas have their own logins (so a call can be made as someone else). */
  roleMode: boolean;
}

const WHO = [
  'customer.CRMAccountsApi.searchParties',
  'customer.CRMAccountsApi.getParty',
  'customer.CRMCustomerLookupApi.getCustomerSummary',
];

function known(memory: VisitMemory): string {
  const entries = Object.entries(memory);
  if (entries.length === 0) {
    return '';
  }
  return `\n\nAlready established earlier in this visit (use these, do not look them up again):\n${entries
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n')}`;
}

function customerBrief(visit: Visit): string {
  const { customer } = visit;
  if (customer.status === 'existing') {
    const kind = customer.type === 'commercial' ? 'a commercial account (a business)' : 'an individual (a person)';
    return (
      `The customer is ${kind} already on file. Find one: search customers whose name contains "${customer.search?.fragment}" ` +
      `and take result number ${customer.search?.ordinal} that is ${kind}; if the search has fewer results or none of that type, ` +
      'try other letters until you have one. Use a real existing customer — do not create one.'
    );
  }
  if (customer.type === 'individual' && customer.person) {
    const { firstName, lastName, email, phone } = customer.person;
    return (
      `The customer is new to the shop: ${firstName} ${lastName}, email ${email}, phone ${phone}, prefers email. ` +
      'Create them as a person (createCrmPerson), with the email and phone marked primary.'
    );
  }
  const company = customer.company;
  return (
    `The customer is a business that is new to the shop: ${company?.legalName}. Their driver is ${company?.contactFirstName} ` +
    `${company?.contactLastName} (email ${company?.email}, phone ${company?.phone}). Create the business as a commercial account ` +
    '(createCrmCommercialAccount), choosing one of the available billing terms.'
  );
}

function vehicleBrief(visit: Visit): string {
  if (visit.vehicle.status === 'new' && visit.vehicle.details) {
    const { year, make, model, vin, licensePlate } = visit.vehicle.details;
    return (
      `The vehicle is not on file: a ${year} ${make} ${model}, VIN ${vin}, plate ${licensePlate}. Register it to the customer with ` +
      'the vehicle registry (createVehicle, with the customer id as accountId) — that is where vehicle records live. ' +
      'If the VIN is rejected as invalid, correct it to a valid 17-character VIN and try again.'
    );
  }
  return (
    "Use one of the customer's vehicles already on file (list their vehicles). If they have none, register a plausible one " +
    'for them with the vehicle registry (createVehicle, with the customer id as accountId).'
  );
}

/** Where this is happening. The site is a fact of the visit, not something for the agent to choose. */
const siteBrief = (visit: Visit): string =>
  `This is at the ${visit.site.name} shop (location id ${visit.site.id}, code ${visit.site.code}); everything in this task happens at that location.`;

const REMEMBER = (keys: string): string =>
  `Before you finish, save what the next colleague needs with the remember tool: ${keys}.`;

const REPLICATION =
  'A customer or vehicle created moments ago can take a few seconds to reach the other services: a 503 saying so, or a ' +
  '"not found" for something you just created, is temporary — wait a few seconds and repeat the call.';

function intake(visit: Visit, stage: VisitStage, memory: VisitMemory): Scenario {
  const expect: ExpectationInput[] = [{ kind: 'call', operation: 'workorder.EstimateAPIApi.createEstimate' }];
  const operations = [
    ...WHO,
    'customer.CRMVehiclesApi.listVehiclesForCustomer',
    'vehicle-inventory.VehicleRegistryAPIApi.createVehicle',
    'catalog.ProductsAPIApi.searchCatalogServices',
    'workorder.EstimateAPIApi.createEstimate',
    'workorder.EstimateAPIApi.addEstimateItem',
    'workorder.EstimateAPIApi.calculateEstimateTotals',
    'workorder.EstimateAPIApi.submitEstimateForApproval',
  ];
  if (visit.customer.status === 'new') {
    const create =
      visit.customer.type === 'commercial'
        ? 'customer.CRMAccountsApi.createCrmCommercialAccount'
        : 'customer.CRMPersonsApi.createCrmPerson';
    operations.push(create);
    expect.push({ kind: 'call', operation: create });
    if (visit.customer.type === 'commercial') {
      operations.push('customer.CRMAccountsApi.listBillingTerms');
    }
  }
  if (visit.vehicle.status === 'new') {
    expect.push({ kind: 'call', operation: 'vehicle-inventory.VehicleRegistryAPIApi.createVehicle' });
  }

  let partsLine = '';
  if (visit.parts === 'stock') {
    operations.push('inventory.InventoryStockApi.listStock');
    partsLine =
      ' The job also needs a part the shop keeps on the shelf: look at the stock at this location, choose a product that ' +
      'fits the concern (the closest match is fine) and is on hand, and add it as a part line with a quantity of 1 or 2.';
  } else if (visit.parts === 'special-order') {
    operations.push('catalog.ProductsAPIApi.searchCatalogProducts', 'inventory.InventoryAvailabilityApi.getAvailabilityByProduct');
    partsLine =
      ' The job also needs a part the shop does not keep in stock: search the product catalog for a part that fits the ' +
      'concern, check its availability, and pick one with nothing on hand at this location. Add it as a part line ' +
      '(quantity 1 or 2) and tell the customer it has to be ordered in and should arrive later today.';
  }

  let arrival = 'The customer has walked in without an appointment.';
  if (visit.arrival === 'appointment') {
    operations.push('shop-manager.AppointmentsAPIApi.listAppointments', 'workorder.EstimatesFromAppointmentsApi.createEstimateFromAppointment');
    arrival =
      "The customer is arriving for an appointment. Look at today's appointments for the site first: if one is booked for a " +
      'customer already on file, serve that customer and create the estimate from the appointment. If there is no usable ' +
      'appointment today, treat this as a walk-in and find a customer as described below.';
  }

  let decision: string;
  if (visit.disposition === 'declines') {
    operations.push('workorder.EstimateAPIApi.declineEstimate');
    expect.push({ kind: 'call', operation: 'workorder.EstimateAPIApi.declineEstimate' });
    decision =
      'Present the estimate. The customer thinks it over and declines — the price is more than they expected. Record the ' +
      'decline with that reason. The visit ends here.';
  } else {
    operations.push('workorder.EstimateAPIApi.approveEstimate', 'workorder.EstimateAPIApi.promoteEstimate');
    expect.push({ kind: 'call', operation: 'workorder.EstimateAPIApi.promoteEstimate' });
    decision =
      'Present the estimate. The customer approves it: record the approval with their name as the signer (the signature is ' +
      'any short base64 string, MIME type image/png), then promote the estimate to a workorder.';
  }

  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — customer at the service counter`,
    cadence: 'daily',
    at: stage.at,
    persona: 'advisor' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are the service advisor. ${arrival}`,
      customerBrief(visit),
      vehicleBrief(visit),
      `What they tell you: "${visit.concern}"`,
      `${siteBrief(visit)} Write a draft estimate for this customer, vehicle and location (currency USD), and add ` +
        'one to three lines that fit the concern: search the service catalog for matching services and add them as labor lines ' +
        `with a sensible price.${partsLine} Calculate the totals and submit the estimate for approval.`,
      decision,
      REPLICATION,
      REMEMBER(
        'partyId, customerName, customerType, vehicleId, vehicleDescription, estimateId, workorderId once the estimate is promoted' +
          (visit.parts === 'none' ? '' : ', and partProductId and partDescription for the part line'),
      ),
    ].join('\n\n') + known(memory),
    operations,
    expect,
    limits: { maxSteps: 50, maxCalls: 55 },
  });
}

function work(visit: Visit, stage: VisitStage, memory: VisitMemory, context: StageContext): Scenario {
  const operations = [
    'workorder.WorkorderDetailApi.getWorkorderDetail',
    'workorder.WorkOrderAPIApi.approveWorkorder',
    'workorder.DailyDispatchBoardDashboardApi.getDispatchDashboard',
    'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
    'people.WorkSessionsAPIApi.startWorkSession',
    'workorder.TechnicianAssignmentAPIApi.assignTechnician',
    'workorder.ServicePositionAPIApi.assignServicePosition',
    'workorder.OperationalContextApi.startWorkorder',
    'workorder.WorkorderLaborAPIApi.startLaborSession',
    'workorder.WorkorderLaborAPIApi.stopLaborSession',
    'workorder.WorkorderNoteAPIApi.addWorkorderNote',
    'workorder.WorkOrderAPIApi.completeServiceItem',
    'workorder.WorkOrderAPIApi.completePartItem',
    'workorder.WorkOrderAPIApi.completeWorkorder',
  ];
  let extra = '';
  if (visit.disposition === 'approves-then-adds-work') {
    operations.push('workorder.ChangeRequestAPIApi.createChangeRequest', 'workorder.ChangeRequestAPIApi.approveChangeRequest');
    extra =
      'With the vehicle on the lift the technician finds something more that needs doing (decide what, in keeping with the ' +
      'concern). Before completing the job, raise a change request on the workorder for the additional work; the customer ' +
      'approves it by phone, so approve the change request.\n\n';
  }
  let partsWork = '';
  if (visit.parts !== 'none') {
    operations.push(
      'workorder.WorkorderPickFacadeApi.getWorkorderPickList',
      'workorder.WorkorderPickFacadeApi.getPickTasks',
      'workorder.WorkorderPickFacadeApi.confirmPickLine',
      'workorder.WorkorderPickFacadeApi.completePickTask',
      'workorder.WorkorderPartsUsageApi.issueParts',
    );
    partsWork =
      visit.parts === 'special-order'
        ? 'This job was waiting on a part ordered in for it (see partsStatus below). If the part has been received, get it ' +
          "to the technician: read the workorder's pick list and pick tasks, confirm the pick, and issue the part to the job. " +
          'If the part has not arrived, add a note saying the job is waiting for parts, remember workStatus as "waiting for ' +
          'parts", and finish without completing the workorder.\n\n'
        : "The job uses a part from the shop's stock: read the workorder's pick list and pick tasks (they can take a minute " +
          'to appear after the workorder is created — wait and look again if empty), confirm the pick, and issue the part ' +
          'to the job before completing the part line.\n\n';
  }
  const technician = context.roleMode
    ? ' The technician starts the workorder and clocks labor: make those calls with sdk_call and persona "tech".'
    : '';

  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — the job goes onto the floor`,
    cadence: 'daily',
    at: stage.at,
    persona: 'manager' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are the shop manager, getting this customer's job done. The customer said: "${visit.concern}"`,
      'Open the workorder. If it still needs the shop\'s approval to proceed, approve it (signer is the customer; any short ' +
        'base64 signature, image/png).',
      `${siteBrief(visit)} Staff the job and place it: look at this location's dispatch board and the people available here, assign a ` +
        'technician who is free, and assign the workorder to a free bay (or a mobile unit if no bay is free). If that ' +
        'technician is not clocked in yet today, clock them in first (start a work session for their person id; a refusal ' +
        'saying one is already open is fine). The shop is ' +
        'busy — bays are often all taken. If nothing is free, add a note that the job is waiting for a bay, remember ' +
        'workStatus as "waiting for a bay", and finish; do not take a bay away from another job.',
      `Once it has a technician and a position, start the workorder and open a labor session.${technician} Add a note ` +
        'describing what was found and done.',
      `${partsWork}${extra}Then finish the job: stop the labor session, complete each service and part line, and complete the workorder ` +
        'with completion notes. Completing it frees the bay.',
      REPLICATION,
      REMEMBER('workStatus ("completed", or why not), and technicianName'),
    ].join('\n\n') + known(memory),
    operations,
    expect: [
      { kind: 'call', operation: 'workorder.WorkorderDetailApi.getWorkorderDetail' },
      { kind: 'call', operation: 'workorder.DailyDispatchBoardDashboardApi.getDispatchDashboard' },
    ],
    limits: { maxSteps: 60, maxCalls: 70 },
  });
}

/** Buying the part a job needs and the shop does not stock. */
function orderPart(visit: Visit, stage: VisitStage, memory: VisitMemory, context: StageContext): Scenario {
  const approval = context.roleMode
    ? 'A purchase order is approved by a manager, not by the person who raised it: make the approval call with sdk_call and persona "manager".'
    : 'Then approve the purchase order.';
  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — ordering the part for the job`,
    cadence: 'daily',
    at: stage.at,
    persona: 'parts' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are the parts clerk. ${siteBrief(visit)}`,
      "A workorder has been opened that needs a part the shop does not stock (see below). Read the workorder's detail to " +
        'find the part line and note its line id, and look at its pick tasks and any backorder for the part: the shortage ' +
        'usually shows there within a minute or two.',
      'Buy the part: choose a vendor the shop can order from, and raise a purchase order for the part line\'s product and ' +
        "quantity, shipping to this location, with a sensible unit cost and a comment naming the workorder. " + approval,
      REPLICATION,
      REMEMBER('purchaseOrderId, vendorId, partLineId (the workorder\'s part line id), partQuantity, and partsStatus as "ordered"'),
    ].join('\n\n') + known(memory),
    operations: [
      'workorder.WorkorderDetailApi.getWorkorderDetail',
      'workorder.WorkorderPickFacadeApi.getPickTasks',
      'inventory.BackordersApi.listBackorders',
      'inventory.InventoryAvailabilityApi.getAvailabilityByProduct',
      'order.PurchaseOrdersApi.listPurchaseOrderVendors',
      'supplier.SupplierVendorsApi.listSupplierVendors',
      'order.PurchaseOrdersApi.createPurchaseOrder',
      'order.PurchaseOrdersApi.approvePurchaseOrder',
      'order.PurchaseOrdersApi.getPurchaseOrder',
    ],
    expect: [
      { kind: 'call', operation: 'workorder.WorkorderDetailApi.getWorkorderDetail' },
      { kind: 'call', operation: 'order.PurchaseOrdersApi.createPurchaseOrder' },
    ],
    limits: { maxSteps: 40, maxCalls: 45 },
  });
}

/** The delivery for one job: received against the workorder that is waiting for it. */
function receivePart(visit: Visit, stage: VisitStage, memory: VisitMemory): Scenario {
  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — the part for the job arrives`,
    cadence: 'daily',
    at: stage.at,
    persona: 'parts' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are the parts clerk. ${siteBrief(visit)}`,
      "The vendor's driver has arrived with the part ordered for a waiting job (purchase order and workorder below). Read " +
        'the purchase order to confirm it is approved and see its line.',
      'Receive it against the job, not into general stock: open a receiving session for the purchase order (its lines can ' +
        'take a minute to become available just after approval — if told so, wait and try again), then cross-dock the ' +
        "session line to the workorder's part line for the quantity ordered.",
      'If the cross-dock is refused, do not force it: record the vendor\'s ship notice (an ASN for the purchase order) and ' +
        'post a goods receipt for the line into this location instead, so the part is at least in the building, and say in ' +
        'your findings what the cross-dock refusal was.',
      'Finish by reading the workorder to see whether it still shows the part as short.',
      REMEMBER('partsStatus ("received", or what went wrong) and receivingSessionId'),
    ].join('\n\n') + known(memory),
    operations: [
      'order.PurchaseOrdersApi.getPurchaseOrder',
      'inventory.ReceivingApi.createReceivingSession',
      'inventory.ReceivingApi.getReceivingSession',
      'inventory.ReceivingApi.crossDockReceivingLine',
      'inventory.ASNApi.createAsn',
      'inventory.ASNApi.createGoodsReceipt',
      'inventory.InventoryAvailabilityApi.getAvailabilityByProduct',
      'workorder.WorkorderDetailApi.getWorkorderDetail',
      'workorder.WorkorderPickFacadeApi.getPickTasks',
    ],
    expect: [
      { kind: 'call', operation: 'order.PurchaseOrdersApi.getPurchaseOrder' },
      { kind: 'call', operation: 'inventory.ReceivingApi.createReceivingSession' },
    ],
    limits: { maxSteps: 40, maxCalls: 45 },
  });
}

function checkout(visit: Visit, stage: VisitStage, memory: VisitMemory): Scenario {
  const operations = [
    'workorder.WorkorderDetailApi.getWorkorderDetail',
    'workorder.WorkOrderAPIApi.generateWorkorderInvoice',
    'invoice.InvoiceApi.getInvoice',
    'invoice.InvoiceApi.getInvoiceByWorkorder',
    'invoice.InvoiceApi.finalizeInvoice',
    'invoice.PaymentApi.listInvoicePayments',
    'invoice.PaymentApi.recordCashPayment',
    'invoice.ReceiptApi.generateReceipt',
    'customer.CRMSnapshotsApi.getPartyBillingRules',
    'customer.CRMInteractionsApi.recordInteraction',
  ];
  const paying =
    visit.payment === 'on-account'
      ? "This customer is billed on account: do not take payment. Read the customer's billing rules, confirm the finalized " +
        'invoice is open against their account, and record an interaction noting the invoice was sent to their accounts ' +
        'payable contact.'
      : 'The customer pays in full at pickup, in cash: record a cash payment for the invoice total, confirm the invoice shows ' +
        'as paid, and generate a receipt.';

  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — the customer picks up and settles`,
    cadence: 'daily',
    at: stage.at,
    persona: 'advisor' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are the service advisor. The customer is back to collect their vehicle. ${siteBrief(visit)}`,
      'Check the workorder. If it is not completed (see workStatus below), tell the customer it is not ready: record an ' +
        'interaction saying so, and finish without invoicing.',
      'If it is completed, generate its invoice. The first call records the request and may answer without an invoice id; ' +
        'wait a few seconds and call it again until it returns one (it is safe to repeat). Then finalize the invoice.',
      paying,
      REMEMBER('invoiceId, invoiceTotal, and paymentOutcome'),
    ].join('\n\n') + known(memory),
    operations,
    expect: [{ kind: 'call', operation: 'workorder.WorkorderDetailApi.getWorkorderDetail' }],
    limits: { maxSteps: 40, maxCalls: 45 },
  });
}

function sale(visit: Visit, stage: VisitStage, memory: VisitMemory): Scenario {
  const operations = [
    ...WHO,
    'inventory.InventoryStockApi.listStock',
    'catalog.ProductsAPIApi.findProductByCode',
    'order.RegisterSessionsApi.getCurrentRegisterSession',
    'order.SalesOrdersApi.createCart',
    'order.SalesOrdersApi.addCartItem',
    'order.SalesOrdersApi.quoteCart',
    'order.SalesOrdersApi.setCartCustomer',
    'order.SalesOrdersApi.checkoutOrder',
    'order.SalesOrdersApi.recordCashTender',
    'order.SalesOrdersApi.getOrder',
  ];
  const expect: ExpectationInput[] = [{ kind: 'call', operation: 'order.SalesOrdersApi.createCart' }];
  if (visit.customer.status === 'new') {
    const create =
      visit.customer.type === 'commercial'
        ? 'customer.CRMAccountsApi.createCrmCommercialAccount'
        : 'customer.CRMPersonsApi.createCrmPerson';
    operations.push(create);
    expect.push({ kind: 'call', operation: create });
  }
  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — sale at the parts counter`,
    cadence: 'daily',
    at: stage.at,
    persona: 'advisor' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are at the parts counter. A customer says: "${visit.concern}"`,
      customerBrief(visit),
      `${siteBrief(visit)} Find a product in stock that fits what they asked for (the closest match is fine). Start a cart ` +
        'on the register session that is open at this location, add the product, attach the customer, and quote the cart. Check the order ' +
        'out and take cash for the total, then read the order back to confirm it is paid.',
      'If no register session is open, say so in your findings and stop: opening the register is the manager\'s job.',
      REPLICATION,
      REMEMBER('partyId, customerName, orderId, and orderTotal'),
    ].join('\n\n') + known(memory),
    operations,
    expect,
    limits: { maxSteps: 40, maxCalls: 45 },
  });
}

function phoneCall(visit: Visit, stage: VisitStage, memory: VisitMemory): Scenario {
  const operations = [
    ...WHO,
    'customer.CRMVehiclesApi.listVehiclesForCustomer',
    'vehicle-inventory.VehicleRegistryAPIApi.createVehicle',
    'shop-manager.ScheduleAPIApi.searchOpenings',
    'shop-manager.ScheduleAPIApi.viewSchedule',
    'shop-manager.AppointmentsAPIApi.createAppointment',
    'shop-manager.AppointmentsAPIApi.getAppointmentById',
    'customer.CRMInteractionsApi.recordInteraction',
  ];
  const expect: ExpectationInput[] = [{ kind: 'call', operation: 'shop-manager.AppointmentsAPIApi.createAppointment' }];
  if (visit.customer.status === 'new') {
    const create =
      visit.customer.type === 'commercial'
        ? 'customer.CRMAccountsApi.createCrmCommercialAccount'
        : 'customer.CRMPersonsApi.createCrmPerson';
    operations.push(create);
    expect.push({ kind: 'call', operation: create });
  }
  return scenarioSchema.parse({
    id: stage.id,
    title: `${visit.id} — booking by phone`,
    cadence: 'daily',
    at: stage.at,
    persona: 'advisor' satisfies Persona,
    kind: 'operations',
    goal: [
      `You are the service advisor answering the phone. The caller: "${visit.concern}"`,
      customerBrief(visit),
      vehicleBrief(visit),
      `${siteBrief(visit)} Search for open appointment slots there over the next seven days. Book the caller into ` +
        'one that suits what they said, read the appointment back to confirm it, and record the call as an interaction on ' +
        'the customer.',
      REPLICATION,
      REMEMBER('partyId, customerName, vehicleId, appointmentId, and appointmentTime'),
    ].join('\n\n') + known(memory),
    operations,
    expect,
    limits: { maxSteps: 40, maxCalls: 45 },
  });
}

/** What a stage needs from earlier stages, and why it is skipped without it. */
export function missingPrerequisite(stage: VisitStage, memory: VisitMemory): string | undefined {
  if (stage.name !== 'intake' && stage.name !== 'sale' && stage.name !== 'call' && !memory['workorderId']) {
    return 'the intake did not produce a workorder (the estimate was declined, or the intake did not complete)';
  }
  if (stage.name === 'receive' && !memory['purchaseOrderId']) {
    return 'no purchase order was raised for the part, so there is no delivery to receive';
  }
  return undefined;
}

export function stageScenario(visit: Visit, stage: VisitStage, memory: VisitMemory, context: StageContext): Scenario {
  switch (stage.name) {
    case 'intake':
      return intake(visit, stage, memory);
    case 'order':
      return orderPart(visit, stage, memory, context);
    case 'receive':
      return receivePart(visit, stage, memory);
    case 'work':
      return work(visit, stage, memory, context);
    case 'checkout':
      return checkout(visit, stage, memory);
    case 'sale':
      return sale(visit, stage, memory);
    case 'call':
    default:
      return phoneCall(visit, stage, memory);
  }
}

const idOf = (body: unknown, ...keys: string[]): string | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

/** Operation → the fact its successful response establishes. */
const HARVEST: Record<string, { fact: string; keys: string[] }> = {
  'customer.CRMPersonsApi.createCrmPerson': { fact: 'partyId', keys: ['partyId', 'id'] },
  'customer.CRMAccountsApi.createCrmCommercialAccount': { fact: 'partyId', keys: ['partyId', 'id'] },
  'vehicle-inventory.VehicleRegistryAPIApi.createVehicle': { fact: 'vehicleId', keys: ['vehicleId', 'id'] },
  'workorder.EstimateAPIApi.createEstimate': { fact: 'estimateId', keys: ['id', 'estimateId'] },
  'workorder.EstimatesFromAppointmentsApi.createEstimateFromAppointment': { fact: 'estimateId', keys: ['id', 'estimateId'] },
  'workorder.EstimateAPIApi.promoteEstimate': { fact: 'workorderId', keys: ['id', 'workorderId'] },
  'workorder.WorkOrderAPIApi.generateWorkorderInvoice': { fact: 'invoiceId', keys: ['invoiceId'] },
  'order.SalesOrdersApi.createCart': { fact: 'orderId', keys: ['orderId', 'id'] },
  'order.PurchaseOrdersApi.createPurchaseOrder': { fact: 'purchaseOrderId', keys: ['purchaseOrderId', 'id'] },
  'inventory.ReceivingApi.createReceivingSession': { fact: 'receivingSessionId', keys: ['sessionId', 'id'] },
  'shop-manager.AppointmentsAPIApi.createAppointment': { fact: 'appointmentId', keys: ['appointmentId', 'id'] },
};

/**
 * Records the ids a visit depends on straight from the responses that create
 * them, so the next stage does not hinge on the model remembering to call
 * `remember`.
 */
export function harvestFacts(operation: Pick<Operation, 'id'>, outcome: Pick<CallOutcome, 'kind' | 'body'>, memory: VisitMemory): void {
  if (outcome.kind !== 'success') {
    return;
  }
  if (operation.id === 'workorder.WorkOrderAPIApi.completeWorkorder') {
    memory['workStatus'] = 'completed';
  }
  if (operation.id === 'inventory.ReceivingApi.crossDockReceivingLine') {
    memory['partsStatus'] = 'received';
  }
  const rule = HARVEST[operation.id];
  const value = rule ? idOf(outcome.body, ...rule.keys) : undefined;
  if (rule && value) {
    memory[rule.fact] = value;
  }
}

