/**
 * The scenario library: what a tenant does in a day, a week and a month.
 *
 * These are the staff's own routines — opening and closing, receiving, the
 * books, the weekly and monthly back-office work — and the error drills. The
 * customers who come through the door each day are not here: they are
 * generated fresh every morning (see day/dayPlan.ts).
 *
 * Each scenario states a goal the way a shop employee would describe the task,
 * pins the operations the task normally takes, and lists the facts that must
 * show up in the call ledger. The model works out the order, finds the ids it
 * needs by reading, and adapts to whatever state the tenant is in — which is
 * the point of driving this with an agent rather than a script.
 *
 * Expectations are deliberately modest. Alpha's data moves under the harness
 * (the daily floor load, the appointment top-up, other people), so a scenario
 * asserts that the work was attempted and the backend answered sanely, and
 * reserves `success` for reads that have no reason to fail. A 5xx on any call
 * fails any scenario without being listed here (see oracle.ts).
 *
 * Adding a scenario is adding an entry: `scenarios.test.ts` fails if an entry
 * names an operation the generated clients do not have.
 */
import { defineScenarios, type ScenarioInput } from './types';

const daily: ScenarioInput[] = [
  {
    id: 'open-shop',
    perSite: true,
    title: 'Open the shop for the day',
    cadence: 'daily',
    at: '07:45',
    persona: 'manager',
    kind: 'operations',
    goal:
      'It is opening time. Review the dispatch board and ' +
      'the shop dashboard for this location, read the register session policy, and check whether the front-counter terminal already ' +
      'has an open register session; if it has none, open one with a sensible opening float. Then make sure you are clocked in: ' +
      'check your current work session and start one if none is open.',
    operations: [
      'location.LocationAPIApi.listLocations',
      'workorder.DailyDispatchBoardDashboardApi.getDispatchDashboard',
      'shop-manager.ShopDashboardAPIApi.getShopDashboard',
      'order.RegisterSessionsApi.getSessionPolicy',
      'order.RegisterSessionsApi.getCurrentRegisterSession',
      'order.RegisterSessionsApi.openRegisterSession',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.startWorkSession',
    ],
    expect: [
      { kind: 'call', operation: 'location.LocationAPIApi.listLocations', outcome: 'success' },
      { kind: 'call', operation: 'workorder.DailyDispatchBoardDashboardApi.getDispatchDashboard' },
      { kind: 'call', operation: 'order.RegisterSessionsApi.getSessionPolicy' },
      { kind: 'call', operation: 'people.WorkSessionsAPIApi.getCurrentWorkSession' },
    ],
  },
  {
    id: 'stock-order',
    perSite: true,
    title: 'Order replenishment stock',
    cadence: 'daily',
    at: '08:40',
    persona: 'parts',
    kind: 'operations',
    goal:
      "Place today's stock order for this location. Review what needs replenishing: the replenishment needs and " +
      'suggestions, the purchase suggestions and shortfalls, and the stocking levels against what is on hand here. Pick two ' +
      'to four products that are at or below their minimum (if nothing is flagged, pick fast-moving parts that are lowest ' +
      'on hand). Choose a vendor the shop can order from and raise one purchase order for them, shipping to this location, ' +
      'with sensible quantities and unit costs and a comment saying it is replenishment stock. A purchase order is approved ' +
      'by a manager, not by the person who raised it: make the approval call with sdk_call and persona "manager" (if the ' +
      'harness refuses that persona, approve it yourself). Read the purchase order back to confirm it is approved. Do not ' +
      'transmit it to the vendor.',
    operations: [
      'inventory.ReplenishmentApi.listReplenishmentNeeds',
      'inventory.ReplenishmentApi.listReplenishmentSuggestions',
      'inventory.PurchaseSuggestionsApi.listPurchaseSuggestions',
      'inventory.PurchaseShortfallsApi.listPurchaseShortfalls',
      'inventory.StockingLevelsApi.listStockingLevels',
      'inventory.InventoryStockApi.listStock',
      'order.PurchaseOrdersApi.listPurchaseOrderVendors',
      'supplier.SupplierVendorsApi.listSupplierVendors',
      'order.PurchaseOrdersApi.createPurchaseOrder',
      'order.PurchaseOrdersApi.approvePurchaseOrder',
      'order.PurchaseOrdersApi.getPurchaseOrder',
    ],
    expect: [
      { kind: 'call', operation: 'inventory.StockingLevelsApi.listStockingLevels' },
      { kind: 'call', operation: 'order.PurchaseOrdersApi.createPurchaseOrder' },
      { kind: 'call', operation: 'order.PurchaseOrdersApi.approvePurchaseOrder' },
    ],
    limits: { maxSteps: 40, maxCalls: 45 },
  },
  {
    id: 'receive-delivery',
    perSite: true,
    title: 'Receive the stock delivery and put it away',
    cadence: 'daily',
    at: '13:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'The parts truck has arrived with replenishment stock for this location. List the purchase orders shipping here and ' +
      'find one that is approved and not yet fully received — the oldest first, which is usually one raised earlier today or ' +
      'yesterday. (Leave alone any purchase order whose comment says it is for a specific workorder: those are received ' +
      "against the job.) If there is none, check the receipts expected and pending, say there was nothing to receive, and " +
      'finish. Otherwise receive it properly: record the vendor\'s ship notice (an ASN for the purchase order, with its ' +
      'lines), then post a goods receipt for the delivery at this location — every line in full, except that on a ' +
      'purchase order with more than one line the last line arrives one unit short. (Inventory can take a minute to learn ' +
      'of a purchase order approved moments ago; if told the reference is not known yet, wait and repeat.) Then put it ' +
      'away: generate putaway tasks for the receipt, claim one, and complete it. Finish by reading the purchase order to ' +
      'see how it now stands, and the stock on hand for one of the products received. In your summary give the purchase ' +
      'order id, the goods receipt id, and the quantities and unit costs received: accounting bills from them.',
    operations: [
      'order.PurchaseOrdersApi.listPurchaseOrders',
      'order.PurchaseOrdersApi.getPurchaseOrder',
      'inventory.ReceiptsApi.listExpectedReceipts',
      'inventory.ReceiptsApi.listPendingReceipts',
      'inventory.ASNApi.createAsn',
      'inventory.ASNApi.createGoodsReceipt',
      'inventory.ASNApi.getGoodsReceipt',
      'inventory.PutawayApi.generatePutawayTasks',
      'inventory.PutawayApi.listPutawayTasks',
      'inventory.PutawayApi.claimPutawayTask',
      'inventory.PutawayExecutionApi.executePutaway',
      'inventory.PutawayQueueApi.completePutawayTask',
      'inventory.PutawayQueueApi.listPutawayQueue',
      'inventory.InventoryStockApi.listStock',
    ],
    expect: [
      { kind: 'call', operation: 'order.PurchaseOrdersApi.listPurchaseOrders' },
      { kind: 'calls', min: 3 },
    ],
    limits: { maxSteps: 50, maxCalls: 55 },
  },
  {
    id: 'collections',
    title: 'Collect from commercial accounts and apply their payments',
    cadence: 'daily',
    at: '14:30',
    persona: 'controller',
    kind: 'operations',
    goal:
      "Work today's receivables. Commercial accounts are billed on terms and pay later, by check or bank transfer, not at " +
      'the counter. Find who owes: the aged receivables report, and the open invoices of the commercial customers on it ' +
      '(a customer\'s open invoices are listed oldest first with the balance still due). ' +
      'Today, up to four of those customers pay — choose the ones whose oldest open invoice is at least two days old, ' +
      'oldest first. For each, record the payment the way the business receives it: submit an INVOICE_PAYMENT accounting ' +
      'event for the invoice (read the event contract first for the exact payload; use a new payment id, the invoice id, ' +
      'the amount, the currency, a paid-at time of now, and a payment method of CHECK or ACH). A payment is received at ' +
      'a shop — the one that issued the invoice: give that location as the organization, and record what was handed ' +
      'over, a check number for a check or the transfer number for a bank transfer, as the reference. It is on the books ' +
      'today; the bank will not show it for a day or two. Vary it the way customers do: most pay their oldest invoice in full; if a customer has two or more ' +
      'open invoices, have one customer pay two of them; and have one customer short-pay — an amount a little under the ' +
      'balance. ' +
      'Then see that the money landed. Accounting applies a payment event to its invoice by itself after a short delay: ' +
      'wait, then read the automatic applications since the start of today and the payments still unapplied. Apply by ' +
      'hand any of today\'s payments left unapplied, to that customer\'s open invoices. Finish by reading one paying ' +
      'customer\'s open invoices again to confirm the balance went down, and report as a finding any payment that neither ' +
      'applied nor shows as unapplied. Do not touch invoices of individual (walk-in) customers: they pay at the counter.',
    operations: [
      'accounting.FinancialReportingApi.generateAgedReceivables',
      'accounting.PaymentApplicationsApi.listCustomerOpenInvoices',
      'customer.CRMAccountsApi.searchParties',
      'customer.CRMAccountsApi.getParty',
      'invoice.InvoiceSearchApi.searchInvoices',
      'invoice.InvoiceApi.getInvoice',
      'accounting.AccountingEventsApi.getEventContract',
      'accounting.AccountingEventsApi.submitAccountingEvent',
      'accounting.AccountingEventsApi.getAccountingEvent',
      'accounting.PaymentApplicationsApi.listAutomaticPaymentApplications',
      'accounting.PaymentApplicationsApi.listUnappliedPayments',
      'accounting.PaymentApplicationsApi.applyPayment',
      'accounting.InvoicePaymentsApi.getInvoiceStatus',
      'accounting.AccountingAnalyticsApi.getCollectionsAnalytics',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.FinancialReportingApi.generateAgedReceivables' },
      { kind: 'call', operation: 'accounting.PaymentApplicationsApi.listUnappliedPayments' },
      { kind: 'calls', min: 5 },
    ],
    limits: { maxSteps: 60, maxCalls: 70 },
  },
  {
    id: 'vendor-bills',
    title: "Enter and match the vendors' bills for what was received",
    cadence: 'daily',
    at: '15:20',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Process the vendor bills for the deliveries the shops received. Start with the Bills to pay stage counts and the ' +
      'bills in the CHECK stage: a bill waiting on its receipt match is a delivery that was received and not yet billed by ' +
      'the vendor. If there are none, look for purchase orders received today or yesterday (list purchase orders and read ' +
      'the received ones); for each that has no bill, create the bill from its goods-received event — the vendor, the ' +
      'purchase order and the received lines with their quantities and unit costs. ' +
      "Then the vendors' invoices arrive. For up to five bills waiting on a match, oldest first, submit the vendor's " +
      'invoice for matching: same purchase order, same lines and quantities as received, an invoice number of your own, ' +
      "today's date, and a due date 30 days out. Make all but one of them agree with the receipt exactly; on one, bill a " +
      'unit price about 3% higher than the purchase order, as vendors do. Read each bill afterwards to see where the ' +
      'match put it. A bill left in MATCH_EXCEPTION: read why, then resolve it — accept a small price difference, send a ' +
      'large one back as CORRECT. A bill with no due date: set it. ' +
      'Finally get what is waiting approved. Read the AP approval policy. A bill in AWAITING_APPROVAL is approved by ' +
      'someone other than the person who submitted it: make the approval calls with sdk_call and persona "controller" ' +
      '(if the harness refuses that persona, approve as yourself and report what the policy answered). Approve up to five. ' +
      'Finish with the stage counts again, and report any bill that would not move.',
    operations: [
      'accounting.VendorBillAPIApi.getVendorBillStageCounts',
      'accounting.VendorBillAPIApi.listVendorBillsByStage',
      'accounting.VendorBillAPIApi.getVendorBillById',
      'accounting.VendorBillAPIApi.createVendorBillFromGoodsReceived',
      'accounting.VendorBillAPIApi.matchVendorInvoice',
      'accounting.VendorBillAPIApi.listVendorBillMatchCandidates',
      'accounting.VendorBillAPIApi.selectVendorBillMatchCandidate',
      'accounting.VendorBillAPIApi.resolveVendorBillMatchException',
      'accounting.VendorBillAPIApi.setVendorBillDueDate',
      'accounting.VendorBillAPIApi.approveVendorBill',
      'accounting.APApprovalPolicyApi.getApApprovalPolicy',
      'order.PurchaseOrdersApi.listPurchaseOrders',
      'order.PurchaseOrdersApi.getPurchaseOrder',
      'accounting.VendorDirectoryAPIApi.searchVendors',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.VendorBillAPIApi.getVendorBillStageCounts' },
      { kind: 'call', operation: 'accounting.VendorBillAPIApi.listVendorBillsByStage' },
      { kind: 'calls', min: 5 },
    ],
    limits: { maxSteps: 70, maxCalls: 80 },
  },
  {
    id: 'error-not-found',
    title: 'Error drill: lookups that must answer 404',
    cadence: 'daily',
    at: '15:15',
    persona: 'advisor',
    kind: 'error',
    goal:
      'Verify that lookups by an id that does not exist are refused cleanly. For each of these, call it once with a freshly ' +
      'made-up random UUID: get an order, get a workorder, get an invoice, get a party, get an appointment, get an estimate. ' +
      'Each should answer 404 with a machine-readable error body. Report as a finding any that answers 200, 500, or an error ' +
      'without a code.',
    operations: [
      'order.SalesOrdersApi.getOrder',
      'workorder.WorkOrderAPIApi.getWorkorder',
      'invoice.InvoiceApi.getInvoice',
      'customer.CRMAccountsApi.getParty',
      'shop-manager.AppointmentsAPIApi.getAppointmentById',
      'workorder.EstimateAPIApi.getEstimate',
    ],
    expect: [{ kind: 'http', statuses: [404], min: 3 }],
  },
  {
    id: 'crew-clock-in',
    perSite: true,
    title: 'The crew clocks in',
    cadence: 'daily',
    at: '07:50',
    persona: 'manager',
    kind: 'operations',
    goal:
      'The crew is arriving for the day. Read who works at this location (the people available here, with their roles): ' +
      'advisors, technicians, parts and office staff alike. For each person, read their current clock state. Someone ' +
      'already clocked in from today is fine — leave them. Someone whose session has been open since a previous day ' +
      'forgot to clock out: do not touch it, the morning time review deals with it; note them in your summary. Everyone ' +
      'else clocks in: start a work session for them. If starting a session for someone is refused, say what was ' +
      'answered and carry on with the rest. Finish by reading the people available here again and report how many are ' +
      'clocked in and who is not.',
    operations: [
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.startWorkSession',
      'shop-manager.TechnicianAPIApi.listLocationTechnicians',
      'people.EmployeeAPIApi.searchEmployees',
    ],
    expect: [
      { kind: 'call', operation: 'people.PeopleAvailabilityAPIApi.listPeopleAvailability' },
      { kind: 'call', operation: 'people.WorkSessionsAPIApi.getCurrentWorkSession' },
      { kind: 'calls', min: 3 },
    ],
    limits: { maxSteps: 60, maxCalls: 70 },
  },
  {
    id: 'timekeeping-review',
    perSite: true,
    title: "Review yesterday's time and fix what is wrong",
    cadence: 'daily',
    at: '09:10',
    persona: 'manager',
    kind: 'operations',
    goal:
      "Go through this location's timekeeping before the day gets busy. " +
      'First, missed clock-outs: read who works here and each person\'s clock state. Anyone whose work session has been ' +
      'open since a previous day forgot to clock out. For each: stop the session now, find the time entry it produced ' +
      '(the time entries for this location, by employee and work date), and record a time entry exception for the ' +
      'employee with code MISSED_CLOCK_OUT against that entry. The entry now ends this morning, which is wrong, so ' +
      'propose a time entry adjustment on it: the same start, and an end at 17:30 on the day it started, with reason ' +
      'code MISSED_CLOCK_OUT and a note. Approve the adjustment, then resolve the exception with a note saying what was ' +
      'corrected. Then clock the person in for today. ' +
      'Second, the exceptions already open for the people who work here: read them. Acknowledge any still merely open. ' +
      'One for a missed or short break on a day the person plainly worked through lunch is waived, with that as the ' +
      'reason; one whose time entry has since been corrected is resolved; anything else stays acknowledged and goes in ' +
      'your findings. ' +
      "Third, yesterday's entries: list this location's time entries for yesterday. An entry with no break at all on a " +
      'shift of more than six hours gets an exception with code MISSED_BREAK and severity WARNING, unless one is already ' +
      'recorded. Finish with the attendance discrepancy report for this location for yesterday, and report anyone whose ' +
      'clocked time and job time are far apart.',
    operations: [
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.stopWorkSession',
      'people.WorkSessionsAPIApi.startWorkSession',
      'people.TimeEntryApprovalAPIApi.listTimeEntries',
      'people.TimeEntryApprovalAPIApi.getTimeEntry',
      'people.PeopleExceptionsApi.listTimeEntryExceptions',
      'people.PeopleExceptionsApi.createTimeEntryException',
      'people.PeopleExceptionsApi.acknowledgeTimeEntryException',
      'people.PeopleExceptionsApi.resolveTimeEntryException',
      'people.PeopleExceptionsApi.waiveTimeEntryException',
      'people.PeopleTimeEntriesApi.createTimeEntryAdjustment',
      'people.PeopleTimeEntriesApi.approveTimeEntryAdjustment',
      'people.PeopleTimeEntriesApi.listTimeEntryAdjustments',
      'people.PeopleReportsAPIApi.getAttendanceDiscrepancyReport',
    ],
    expect: [
      { kind: 'call', operation: 'people.PeopleAvailabilityAPIApi.listPeopleAvailability' },
      { kind: 'call', operation: 'people.TimeEntryApprovalAPIApi.listTimeEntries' },
      { kind: 'call', operation: 'people.PeopleExceptionsApi.listTimeEntryExceptions' },
    ],
    limits: { maxSteps: 70, maxCalls: 80 },
  },
  {
    id: 'lunch-out',
    perSite: true,
    title: 'The crew goes to lunch',
    cadence: 'daily',
    at: '12:00',
    persona: 'manager',
    kind: 'operations',
    goal:
      'It is lunchtime at this location. Read who works here and each person\'s clock state. Everyone who is clocked in ' +
      'and not already on a break starts a break on their work session — with one exception: on Tuesdays and Fridays ' +
      'the person whose name comes first alphabetically is too busy and works through lunch, so leave them clocked in ' +
      'without a break and name them in your summary. If starting a break for someone is refused, say what was answered ' +
      'and carry on. Report how many went on break.',
    operations: [
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.startWorkSessionBreak',
    ],
    expect: [
      { kind: 'call', operation: 'people.PeopleAvailabilityAPIApi.listPeopleAvailability' },
      { kind: 'call', operation: 'people.WorkSessionsAPIApi.getCurrentWorkSession' },
    ],
    limits: { maxSteps: 50, maxCalls: 60 },
  },
  {
    id: 'lunch-back',
    perSite: true,
    title: 'The crew comes back from lunch',
    cadence: 'daily',
    at: '12:40',
    persona: 'manager',
    kind: 'operations',
    goal:
      'Lunch is over at this location. Read who works here and each person\'s clock state. Everyone who is on a break ' +
      'comes back: stop the break on their work session. Leave alone anyone who is not on a break. Report how many came ' +
      'back and whether anyone is still shown as on break.',
    operations: [
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.stopWorkSessionBreak',
    ],
    expect: [
      { kind: 'call', operation: 'people.PeopleAvailabilityAPIApi.listPeopleAvailability' },
      { kind: 'call', operation: 'people.WorkSessionsAPIApi.getCurrentWorkSession' },
    ],
    limits: { maxSteps: 50, maxCalls: 60 },
  },
  {
    id: 'crew-clock-out',
    perSite: true,
    title: 'The crew clocks out and hands in its time',
    cadence: 'daily',
    at: '17:35',
    persona: 'manager',
    kind: 'operations',
    goal:
      'The day is over at this location. Read who works here and each person\'s clock state. Everyone who is clocked in ' +
      'clocks out — except, on Wednesdays, the technician whose name comes last alphabetically, who walks out without ' +
      'clocking out: leave that one session open and name the person in your summary (tomorrow\'s time review will find ' +
      'it). Clocking out is two steps for each person: stop their work session, which also ends a break left open; then ' +
      'submit the ended session for approval, giving the break minutes actually taken, the billable minutes (the time ' +
      'between start and stop less the breaks, from the session you just stopped), and now as the submission time. Do ' +
      'not clock yourself out: you close the shop afterwards. If a stop or a submission is refused, say what was ' +
      'answered and carry on. Finish by listing today\'s time entries for this location and report how many are ' +
      'submitted or pending approval and who is still clocked in.',
    operations: [
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.stopWorkSession',
      'people.WorkSessionsAPIApi.submitWorkSession',
      'people.TimeEntryApprovalAPIApi.listTimeEntries',
    ],
    expect: [
      { kind: 'call', operation: 'people.PeopleAvailabilityAPIApi.listPeopleAvailability' },
      { kind: 'call', operation: 'people.WorkSessionsAPIApi.getCurrentWorkSession' },
      { kind: 'calls', min: 3 },
    ],
    limits: { maxSteps: 70, maxCalls: 80 },
  },
  {
    id: 'close-shop',
    perSite: true,
    title: 'Close out the day',
    cadence: 'daily',
    at: '17:45',
    persona: 'manager',
    kind: 'operations',
    goal:
      'It is closing time. Find the register session that is open on the front-counter terminal at this location. Read its X report and its cash ' +
      'movements. If the session is open and has no orders awaiting payment, begin the close with a counted cash figure that ' +
      'matches the X report\'s expected cash, then confirm the close and read the Z report. Check which closed sessions are ' +
      'still undeposited. The crew has already clocked out; finally stop your own work session if one is open.',
    operations: [
      'location.LocationAPIApi.listLocations',
      'order.RegisterSessionsApi.getCurrentRegisterSession',
      'order.RegisterSessionsApi.getRegisterSession',
      'order.RegisterSessionsApi.getSessionXReport',
      'order.RegisterSessionsApi.listCashMovements',
      'order.RegisterSessionsApi.beginSessionClose',
      'order.RegisterSessionsApi.confirmSessionClose',
      'order.RegisterSessionsApi.getSessionZReport',
      'accounting.BankDepositsApi.listUndepositedSessions',
      'people.WorkSessionsAPIApi.getCurrentWorkSession',
      'people.WorkSessionsAPIApi.stopWorkSession',
    ],
    expect: [
      { kind: 'call', operation: 'order.RegisterSessionsApi.getCurrentRegisterSession' },
      { kind: 'call', operation: 'accounting.BankDepositsApi.listUndepositedSessions' },
      { kind: 'calls', min: 4 },
    ],
  },
];

const weekly: ScenarioInput[] = [
  {
    id: 'weekly-purchasing',
    perSite: true,
    title: 'Weekly purchasing review',
    cadence: 'weekly',
    weekday: 1,
    at: '09:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'Review the week\'s purchasing for this location. Summarize the purchase orders, then list the ones shipping here ' +
      'and read any that have been open longest: for each, check its supplier availability and its transmission events, ' +
      'and whether it has been received. Check the backorders and the purchase shortfalls. If a purchase order was fully ' +
      'received more than a day ago and is still open, close it. Report anything ordered more than a week ago that has ' +
      'not arrived.',
    operations: [
      'order.PurchaseOrdersApi.summarizePurchaseOrders',
      'order.PurchaseOrdersApi.listPurchaseOrders',
      'order.PurchaseOrdersApi.getPurchaseOrder',
      'order.PurchaseOrdersApi.getPurchaseOrderSupplierAvailability',
      'order.PurchaseOrdersApi.listPurchaseOrderTransmissionEvents',
      'order.PurchaseOrdersApi.closePurchaseOrder',
      'inventory.BackordersApi.listBackorders',
      'inventory.PurchaseShortfallsApi.listPurchaseShortfalls',
      'inventory.ReplenishmentApi.listReplenishmentPolicies',
    ],
    expect: [
      { kind: 'call', operation: 'order.PurchaseOrdersApi.summarizePurchaseOrders' },
      { kind: 'call', operation: 'order.PurchaseOrdersApi.listPurchaseOrders' },
      { kind: 'call', operation: 'inventory.BackordersApi.listBackorders' },
    ],
  },
  {
    id: 'weekly-cycle-count',
    perSite: true,
    title: 'Weekly cycle count',
    cadence: 'weekly',
    weekday: 2,
    at: '10:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'Run this week\'s cycle count. Review the cycle count plans and schedules, the count queue and the tolerances. If a count ' +
      'task is waiting, read it and submit a count for it (use the expected quantity, or one unit off to raise a variance). ' +
      'Then review pending cycle count adjustments and the count history.',
    operations: [
      'inventory.CycleCountPlansApi.listCycleCountPlans',
      'inventory.CycleCountSchedulesApi.listCycleCountSchedules',
      'inventory.CycleCountTolerancesApi.listCycleCountTolerances',
      'inventory.CycleCountQueryApi.getCycleCountQueue',
      'inventory.CycleCountQueryApi.getCycleCountTask',
      'inventory.CycleCountOperationsApi.submitCycleCount',
      'inventory.CycleCountAdjustmentsApi.listPendingCycleCountAdjustments',
      'inventory.CycleCountAdjustmentsApi.countPendingCycleCountAdjustments',
      'inventory.CycleCountQueryApi.listCycleCountHistory',
    ],
    expect: [
      { kind: 'call', operation: 'inventory.CycleCountPlansApi.listCycleCountPlans' },
      { kind: 'call', operation: 'inventory.CycleCountQueryApi.getCycleCountQueue' },
      { kind: 'calls', min: 4 },
    ],
  },
  {
    id: 'weekly-access-review',
    title: 'Weekly access and audit review',
    cadence: 'weekly',
    weekday: 2,
    at: '15:00',
    persona: 'admin',
    kind: 'operations',
    goal:
      'Do the weekly access review. Confirm which tenant you are signed in to, list users and roles, read the permissions of ' +
      'one role and the role assignments of one user, check for people who are inactive but still have an active login, and ' +
      'search the audit events of the last week. Report anything that looks wrong; change nothing.',
    operations: [
      'security.TenantAPIApi.getMyTenant',
      'security.UserAPIApi.listUsers',
      'security.RoleManagementApi.listRoles',
      'security.RoleManagementApi.getRoleDefaultPermissions',
      'security.RoleManagementApi.listUserRoleAssignments',
      'security.PermissionRegistryApi.getPermissionCatalogVersion',
      'security.AuditApi.searchAuditEvents',
      'people.PeopleComplianceAPIApi.listInactivePersonActiveUsers',
      'people-contact.PeopleAccessControlApi.listAssignableRoles',
    ],
    expect: [
      { kind: 'call', operation: 'security.TenantAPIApi.getMyTenant', outcome: 'success' },
      { kind: 'call', operation: 'security.UserAPIApi.listUsers' },
      { kind: 'call', operation: 'security.RoleManagementApi.listRoles' },
      { kind: 'call', operation: 'people.PeopleComplianceAPIApi.listInactivePersonActiveUsers' },
    ],
  },
  {
    id: 'weekly-crm-followups',
    title: 'Weekly customer follow-ups',
    cadence: 'weekly',
    weekday: 3,
    at: '10:00',
    persona: 'advisor',
    kind: 'operations',
    goal:
      'Work the customer follow-up list. Read the follow-up queue and open inquiries. For one customer: read their summary, ' +
      'their interactions and their marketing consent, record a phone-call interaction, and create a follow-up task due next ' +
      'week. Then look at the vehicle service due dates coming up and the list of customer tags.',
    operations: [
      'customer.CRMFollowUpsApi.getFollowUpQueue',
      'customer.CRMInquiriesApi.listInquiries',
      'customer.CRMAccountsApi.searchParties',
      'customer.CRMCustomerLookupApi.getCustomerSummary',
      'customer.CRMInteractionsApi.listPartyInteractions',
      'customer.CRMInteractionsApi.recordInteraction',
      'customer.CRMMarketingConsentApi.getMarketingConsent',
      'customer.CRMFollowUpsApi.createFollowUpTask',
      'customer.CRMTagsApi.listTags',
      'vehicle-inventory.VehicleDueDatesApi.searchVehicleDueDates',
    ],
    expect: [
      { kind: 'call', operation: 'customer.CRMFollowUpsApi.getFollowUpQueue' },
      { kind: 'call', operation: 'customer.CRMInteractionsApi.recordInteraction' },
      { kind: 'calls', min: 5 },
    ],
  },
  {
    id: 'weekly-warranty',
    title: 'Weekly warranty claims',
    cadence: 'weekly',
    weekday: 3,
    at: '15:00',
    persona: 'advisor',
    kind: 'operations',
    goal:
      'Review warranty work. List warranty providers and policies, search open claims and registrations, and read one claim if ' +
      'any exist. Check the part returns and reimbursements that are outstanding, and reconcile settlements (read only). If a ' +
      'provider and policy exist, check which policies would apply to one recently sold product.',
    operations: [
      'warranty.WarrantyProvidersApi.listProviders',
      'warranty.WarrantyPoliciesApi.listPolicies',
      'warranty.WarrantyPoliciesApi.findApplicablePolicies',
      'warranty.WarrantyClaimsApi.searchClaims',
      'warranty.WarrantyClaimsApi.getClaim',
      'warranty.WarrantyClaimsApi.searchCandidateLines',
      'warranty.WarrantyRegistrationsApi.searchRegistrations',
      'warranty.WarrantyPartReturnsApi.listPartReturns',
      'warranty.WarrantyReimbursementsApi.listReimbursements',
      'warranty.WarrantySettlementsApi.reconcileSettlements',
    ],
    expect: [
      { kind: 'call', operation: 'warranty.WarrantyProvidersApi.listProviders' },
      { kind: 'call', operation: 'warranty.WarrantyClaimsApi.searchClaims' },
      { kind: 'calls', min: 5 },
    ],
  },
  {
    id: 'weekly-error-authorization',
    title: 'Error drill: a technician reaching for the books',
    cadence: 'weekly',
    weekday: 4,
    at: '10:00',
    persona: 'tech',
    kind: 'error',
    requiresRoleMode: true,
    goal:
      'Verify that a technician login cannot reach finance and administration. As the technician, try each of these once: list ' +
      'journal entries, list users, list GL accounts, list accounting periods, list vendor bills. Each should be refused with ' +
      '403. Report as a defect any that succeeds, and as a warning any that answers something other than 403.',
    operations: [
      'accounting.JournalEntriesApi.listJournalEntries',
      'security.UserAPIApi.listUsers',
      'accounting.GLAccountsApi.listGLAccounts',
      'accounting.AccountingPeriodsApi.listAccountingPeriods',
      'accounting.VendorBillAPIApi.listVendorBills',
    ],
    expect: [{ kind: 'http', statuses: [403], min: 3 }],
  },
  {
    id: 'weekly-timekeeping-approval',
    perSite: true,
    title: "Approve last week's timesheets",
    cadence: 'weekly',
    weekday: 1,
    at: '08:50',
    persona: 'manager',
    kind: 'operations',
    goal:
      "Approve last week's time for this location, Monday to Sunday, so payroll can close the period. List the location's " +
      'time entries that are submitted or pending approval, and the exceptions open for the people who work here. Go ' +
      'person by person. An entry is approved when it looks like a day\'s work: a start and an end on the same day, a ' +
      'sensible length, and no open exception against it — approve those in one batch. An entry with an open BLOCKING ' +
      'exception, or one that is plainly wrong (no end, or far longer than a shift) and has no approved adjustment, is ' +
      'rejected with the reason, so the employee\'s manager corrects it. An entry with an approved adjustment is ' +
      'approved. Then read the attendance discrepancy report for the location for last week and the staffing ' +
      'assignments here. Report how many entries were approved, how many rejected and why, and who has none at all for ' +
      'a day the shop was open.',
    operations: [
      'people.TimeEntryApprovalAPIApi.listTimeEntries',
      'people.TimeEntryApprovalAPIApi.getTimeEntry',
      'people.TimeEntryApprovalAPIApi.approveTimeEntriesBatch',
      'people.TimeEntryApprovalAPIApi.rejectTimeEntriesBatch',
      'people.PeopleExceptionsApi.listTimeEntryExceptions',
      'people.PeopleTimeEntriesApi.listTimeEntryAdjustments',
      'people.PeopleAvailabilityAPIApi.listPeopleAvailability',
      'people.PeopleReportsAPIApi.getAttendanceDiscrepancyReport',
      'people.PeopleStaffingAssignmentsApi.listStaffingAssignments',
    ],
    expect: [
      { kind: 'call', operation: 'people.TimeEntryApprovalAPIApi.listTimeEntries' },
      { kind: 'call', operation: 'people.PeopleExceptionsApi.listTimeEntryExceptions' },
      { kind: 'calls', min: 4 },
    ],
    limits: { maxSteps: 60, maxCalls: 70 },
  },
  {
    id: 'weekly-pay-period-signoff',
    title: 'Sign off the pay period and hand the hours to payroll',
    cadence: 'weekly',
    weekday: 1,
    at: '11:30',
    persona: 'controller',
    kind: 'operations',
    goal:
      "Sign off last week's time for the whole business, after the shops have approved their own. List the pay periods. " +
      'The platform opens and closes periods on its own schedule; do not create or close routine periods yourself. Find ' +
      'the period that covers last week. Only if there is none at all, create one for last Monday to Sunday as a ' +
      'correction, and say so in your findings. ' +
      'For that period, go through the people who have time: read each person\'s approval state for the period. Someone ' +
      'with entries still pending whose shop has not decided them: read the entries, and if they are ordinary, approve ' +
      'the person\'s period; if something is wrong, reject the person\'s period with the reason. Someone with rejected ' +
      'entries stays rejected: list them. Do this for at most fifteen people. ' +
      'Then the hand-off: read the approved time for the period across all the shop locations — this is what payroll ' +
      'takes. Report the total hours, the number of people, and anyone at work last week with no approved time. ' +
      'Last, the period itself: if it ended more than three days ago and is still OPEN, the scheduled rollover has not ' +
      'run — close it to submissions as a manual correction and report that. Never mark a period payroll-closed: that is ' +
      'payroll\'s step, and it cannot be undone.',
    operations: [
      'people.TimekeepingApprovalAPIApi.listTimePeriods',
      'people.TimePeriodManagementAPIApi.createTimePeriod',
      'people.TimePeriodManagementAPIApi.transitionTimePeriod',
      'people.TimekeepingApprovalAPIApi.listTimekeepingApprovalPeople',
      'people.TimekeepingApprovalAPIApi.getTimePeriodApproval',
      'people.TimekeepingApprovalAPIApi.listTimekeepingEntries',
      'people.TimekeepingApprovalAPIApi.approveTimePeriod',
      'people.TimekeepingApprovalAPIApi.rejectTimePeriod',
      'people.PeopleReportsAPIApi.listApprovedTimeForExport',
      'location.LocationAPIApi.listLocations',
    ],
    expect: [
      { kind: 'call', operation: 'people.TimekeepingApprovalAPIApi.listTimePeriods' },
      { kind: 'call', operation: 'people.TimekeepingApprovalAPIApi.listTimekeepingApprovalPeople' },
      { kind: 'call', operation: 'people.PeopleReportsAPIApi.listApprovedTimeForExport' },
    ],
    limits: { maxSteps: 70, maxCalls: 80 },
  },
  {
    id: 'weekly-bank-statement',
    title: "Enter last week's bank statement",
    cadence: 'weekly',
    weekday: 1,
    at: '08:30',
    persona: 'acct',
    kind: 'operations',
    tools: ['bank_statement', 'request_id'],
    goal:
      "Last week's bank statement has arrived. For each bank account the business reconciles (list the bank accounts), " +
      'do the following; if there are several, do the first two. ' +
      'The period is last week, Monday to Sunday — unless the account already has statements, in which case it runs from ' +
      'the day after the latest one ends to last Sunday (skip the account if that is already covered). ' +
      'First time for an account, when it has no statement yet and no opening balance on the books: put the opening ' +
      'balance on the books — a statement balance of {{bankOpeningBalance}} in the account\'s currency, as of the day ' +
      'before the period starts, with no outstanding items and a justification saying it is the balance at the start of ' +
      'this run. That figure is then this statement\'s opening balance. Otherwise the opening balance is the latest ' +
      "statement's closing balance. " +
      'Then gather what the books say moved through the account: every entry on that bank account dated from five days ' +
      'before the period starts to its end — from the general ledger for the account or its journal entries. Classify ' +
      'each: a deposit of register cash, a customer check, a customer bank transfer, a vendor payment, or other; keep its ' +
      'date, signed amount (money in positive) and its reference (deposit reference, check number, transfer number, ' +
      'payment reference). Leave out the opening-balance entry itself. ' +
      'Give those to the bank_statement tool with the period and opening balance. It returns the statement as the bank ' +
      'sent it. It will not match the books line for line — that is what reconciliation is for — so enter it exactly as ' +
      'returned, the way it says to: keyed by hand (create the bank statement from the header and lines) or as a file ' +
      '(upload the CSV it gives you with its mapping, read the import\'s preview and rows, then commit it). Use the ' +
      'request ids it gives you. A first statement for an account needs a gap acknowledgement saying it is the first. ' +
      'Finish by reading the committed statement back, and report its closing balance and how many items the bank had ' +
      'not yet cleared.',
    operations: [
      'accounting.BankAccountsApi.listBankAccounts',
      'accounting.BankAccountsApi.establishBankOpeningBalance',
      'accounting.BankStatementsApi.listBankStatements',
      'accounting.BankStatementsApi.getBankStatement',
      'accounting.BankStatementsApi.createBankStatement',
      'accounting.BankImportsApi.createBankImport',
      'accounting.BankImportsApi.getBankImport',
      'accounting.BankImportsApi.listBankImportRows',
      'accounting.BankImportsApi.setBankImportMapping',
      'accounting.BankImportsApi.commitBankImport',
      'accounting.FinancialReportingApi.generateGeneralLedger',
      'accounting.JournalEntriesApi.listJournalEntries',
      'accounting.JournalEntriesApi.getJournalEntry',
      'accounting.GLAccountsApi.getGLAccountBalance',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.BankAccountsApi.listBankAccounts' },
      { kind: 'call', operation: 'accounting.BankStatementsApi.listBankStatements' },
      { kind: 'calls', min: 5 },
    ],
    limits: { maxSteps: 70, maxCalls: 80 },
  },
  {
    id: 'weekly-bank-reconciliation',
    title: "Reconcile last week's bank statement",
    cadence: 'weekly',
    weekday: 1,
    at: '10:30',
    persona: 'acct',
    kind: 'operations',
    tools: ['request_id'],
    goal:
      'Reconcile the bank statement entered this morning. List the bank accounts and their statements; for each account ' +
      'whose latest committed statement has no finalized reconciliation, work it (the first two accounts, if several). ' +
      'Open the reconciliation for the statement if one is not already in progress, and read it and its review to see what ' +
      'is unexplained on each side. Run the auto-match, then go through what it proposed: accept a pairing where amount, ' +
      'date and reference agree; reject one that does not (find the operation with sdk_search). For bank lines still unexplained, look at the candidates and ' +
      'pair by hand where there is a clear one (a check by its number, a transfer or payment by its reference). ' +
      'What is left is the real work. A bank charge or interest line that the books do not have: record it as an ' +
      'adjustment of the matching type. An entry on the books the bank has not shown — a check or transfer received ' +
      'late in the week, a vendor payment still on its way: register it as an outstanding item, it will clear next week. ' +
      'An outstanding item from an earlier reconciliation that has now appeared on this statement: match it. A deposit ' +
      'the bank shows at a different amount from the books: do not force it — leave it unmatched and report both amounts ' +
      'as a finding for someone to take up with the bank. ' +
      'When nothing more can honestly be explained, read the reconciliation report. If it balances, submit it, and have ' +
      'it approved by someone else: make the finalize call with sdk_call and persona "controller" (if the harness refuses ' +
      'that persona, or the difference is not zero, leave it submitted or in progress and say why). Report the ending ' +
      'balances, what was adjusted, what is outstanding, and anything unexplained.',
    operations: [
      'accounting.BankAccountsApi.listBankAccounts',
      'accounting.BankStatementsApi.listBankStatements',
      'accounting.BankReconciliationApi.listReconciliations',
      'accounting.BankReconciliationApi.createReconciliation',
      'accounting.BankReconciliationApi.getReconciliation',
      'accounting.BankReconciliationApi.getReconciliationReview',
      'accounting.BankReconciliationApi.autoMatchReconciliation',
      'accounting.BankReconciliationApi.acceptReconciliationMatch',
      'accounting.BankReconciliationApi.listReconciliationCandidates',
      'accounting.BankReconciliationApi.createReconciliationMatch',
      'accounting.BankReconciliationApi.listReconciliationAdjustmentTypes',
      'accounting.BankReconciliationApi.addReconciliationAdjustment',
      'accounting.BankReconciliationApi.registerReconciliationOutstandingItem',
      'accounting.BankReconciliationApi.getReconciliationReport',
      'accounting.BankReconciliationApi.submitReconciliation',
      'accounting.BankReconciliationApi.finalizeReconciliation',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.BankStatementsApi.listBankStatements' },
      { kind: 'call', operation: 'accounting.BankReconciliationApi.listReconciliations' },
      { kind: 'calls', min: 5 },
    ],
    limits: { maxSteps: 80, maxCalls: 90 },
  },
  {
    id: 'weekly-ap-run',
    title: 'Weekly vendor payment run',
    cadence: 'weekly',
    weekday: 5,
    at: '11:00',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Run the weekly vendor payments. First see where things stand: the cash position and outlook, the AP approval ' +
      'policy, the accounts a payment may come from, the payments still in flight, and the approved bills ready to pay ' +
      '(they are listed by due date, oldest first, each saying whether the vendor is on hold). ' +
      'Then pay. Choose the bills that are overdue or fall due within the next seven days; if none are that close, take ' +
      'the oldest approved bills. Group them by vendor and pay up to five vendors, one payment each, from one of the ' +
      'pay-from accounts, allocating the payment across that vendor\'s chosen bills. Give every payment a payment ' +
      'reference of your own (it is the idempotency key: check the reference is unused before executing, and never ' +
      'execute the same vendor twice). Limits for this run: no single payment above 5,000.00 in the functional currency, ' +
      'no more than five payments, never a vendor on AP hold, and never more than the cash position can cover after the ' +
      'safety cushion. Pay most vendors in full; pay one vendor only part of a bill, as a business short of cash would. ' +
      'If the policy does not let the person who approved a bill pay it and a payment is refused for that reason, report ' +
      'it and move on. ' +
      'Afterwards read each payment back for its allocations and its ledger posting status, the in-flight list again, ' +
      'and the stage counts of Bills to pay. Report any payment whose posting was refused, and anything executed that ' +
      'does not show against its bills.',
    operations: [
      'accounting.CashPositionApi.getCashPosition',
      'accounting.CashPositionApi.getCashOutlook',
      'accounting.AccountingConfigurationApi.getCashSafetyCushion',
      'accounting.APApprovalPolicyApi.getApApprovalPolicy',
      'accounting.APPaymentsApi.listApPayFromAccounts',
      'accounting.APPaymentsApi.listApPaymentsInFlight',
      'accounting.APPaymentsApi.listApBills',
      'accounting.VendorBillAPIApi.getVendorBillById',
      'accounting.APPaymentsApi.getApPaymentByRef',
      'accounting.APPaymentsApi.executeApPayment',
      'accounting.APPaymentsApi.getApPayment',
      'accounting.VendorBillAPIApi.getVendorBillStageCounts',
      'accounting.FinancialReportingApi.generateAgedPayables',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.APPaymentsApi.listApBills' },
      { kind: 'call', operation: 'accounting.APPaymentsApi.listApPayFromAccounts' },
      { kind: 'call', operation: 'accounting.CashPositionApi.getCashPosition' },
      { kind: 'calls', min: 5 },
    ],
    limits: { maxSteps: 60, maxCalls: 70 },
  },
  {
    id: 'weekly-bank-deposit',
    title: 'Weekly bank deposit',
    cadence: 'weekly',
    weekday: 5,
    at: '16:00',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Take the week\'s cash to the bank. List the bank accounts and the closed register sessions that are still undeposited. ' +
      'If there are any, record one bank deposit covering one or more of them and read the deposit back. Then list recent ' +
      'bank transactions and bank statements.',
    operations: [
      'accounting.BankAccountsApi.listBankAccounts',
      'accounting.BankDepositsApi.listUndepositedSessions',
      'accounting.BankDepositsApi.recordBankDeposit',
      'accounting.BankDepositsApi.getBankDeposit',
      'accounting.BankTransactionsApi.listBankTransactions',
      'accounting.BankStatementsApi.listBankStatements',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.BankAccountsApi.listBankAccounts' },
      { kind: 'call', operation: 'accounting.BankDepositsApi.listUndepositedSessions' },
    ],
  },
  {
    id: 'weekly-catalog-pricing',
    title: 'Weekly catalog and pricing upkeep',
    cadence: 'weekly',
    weekday: 6,
    at: '10:00',
    persona: 'manager',
    kind: 'operations',
    goal:
      'Review prices for the week ahead. List labor rates and their adjustments, the service packages and the substitution ' +
      'groups, and the freshness of the supplier price catalog with any unmatched lines. For one product: read its detail, its ' +
      'active MSRP, its costs, and the price it resolves to at one site. Then list restriction rules and the labor standard ' +
      'conflicts that need attention.',
    operations: [
      'price.LaborRatesApi.listLaborRates',
      'price.LaborRatesApi.listLaborRateAdjustments',
      'price.RestrictionRulesApi.listRestrictionRules',
      'catalog.ServicePackagesApi.listServicePackages',
      'catalog.SubstitutionGroupAPIApi.listSubstitutionGroups',
      'catalog.LaborStandardConflictsApi.listLaborStandardConflicts',
      'catalog.ProductsAPIApi.getProductDetailView',
      'catalog.ProductMSRPAPIApi.getActiveProductMsrp',
      'catalog.ItemCostAPIApi.getItemCosts',
      'catalog.ProductsAPIApi.getEffectiveLocationPrice',
      'supplier.SupplierPriceCatalogApi.getSupplierPriceCatalogFreshness',
      'supplier.SupplierPriceCatalogApi.listSupplierPriceCatalogUnmatchedLines',
      'inventory.InventoryStockApi.listStock',
    ],
    expect: [
      { kind: 'call', operation: 'price.LaborRatesApi.listLaborRates' },
      { kind: 'call', operation: 'catalog.ServicePackagesApi.listServicePackages' },
      { kind: 'calls', min: 6 },
    ],
  },
];

const monthly: ScenarioInput[] = [
  {
    id: 'monthly-period-close',
    title: 'Month-end close',
    cadence: 'monthly',
    dayOfMonth: 1,
    at: '09:00',
    persona: 'controller',
    kind: 'operations',
    goal:
      'Close last month\'s books. List the accounting periods and find the most recent period that has ended and is still ' +
      'open. Read its close readiness, the hard lock date and the bank reconciliation policy, generate the trial balance for ' +
      'it, and list suspended accounting events. If readiness reports no blockers, close the period; if closing is refused by ' +
      'the harness or by the backend, report the readiness result and stop.',
    operations: [
      'accounting.AccountingPeriodsApi.listAccountingPeriods',
      'accounting.AccountingPeriodsApi.getAccountingPeriodCloseReadiness',
      'accounting.AccountingPeriodsApi.getAccountingHardLockDate',
      'accounting.AccountingPeriodsApi.getBankReconciliationPolicy',
      'accounting.AccountingPeriodsApi.closeAccountingPeriod',
      'accounting.FinancialReportingApi.generateTrialBalance',
      'accounting.AccountingEventsApi.listAccountingEvents',
      'accounting.AccountingEventsApi.listAccountingEventStatuses',
      'accounting.WorkItemsApi.listWorkItems',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.AccountingPeriodsApi.listAccountingPeriods', outcome: 'success' },
      { kind: 'call', operation: 'accounting.AccountingPeriodsApi.getAccountingPeriodCloseReadiness' },
      { kind: 'call', operation: 'accounting.FinancialReportingApi.generateTrialBalance' },
    ],
  },
  {
    id: 'monthly-financial-statements',
    title: 'Monthly financial statements',
    cadence: 'monthly',
    dayOfMonth: 2,
    at: '10:00',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Produce last month\'s financial pack. Generate the income statement, balance sheet, general ledger, aged receivables, ' +
      'aged payables and the tax liability report for last calendar month, and the labor overhead report. Drill down from one ' +
      'income statement line to its accounts. List the chart of accounts and recent journal entries, then request an ' +
      'accounting export for the month and check its status.',
    operations: [
      'accounting.FinancialReportingApi.generateIncomeStatement',
      'accounting.FinancialReportingApi.generateBalanceSheet',
      'accounting.FinancialReportingApi.generateGeneralLedger',
      'accounting.FinancialReportingApi.generateAgedReceivables',
      'accounting.FinancialReportingApi.generateAgedPayables',
      'accounting.FinancialReportingApi.generateTaxLiabilityReport',
      'accounting.FinancialReportingApi.drilldownToAccounts',
      'accounting.LocationCostReportingApi.generateLaborOverheadReport',
      'accounting.GLAccountsApi.listGLAccounts',
      'accounting.JournalEntriesApi.listJournalEntries',
      'accounting.AccountingExportsApi.requestExport',
      'accounting.AccountingExportsApi.listExportHistory',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.FinancialReportingApi.generateIncomeStatement' },
      { kind: 'call', operation: 'accounting.FinancialReportingApi.generateBalanceSheet' },
      { kind: 'call', operation: 'accounting.FinancialReportingApi.generateAgedReceivables' },
      { kind: 'call', operation: 'accounting.GLAccountsApi.listGLAccounts', outcome: 'success' },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'monthly-bank-reconciliation',
    title: 'Month-end bank reconciliation review',
    cadence: 'monthly',
    dayOfMonth: 3,
    at: '10:00',
    persona: 'controller',
    kind: 'operations',
    goal:
      'Review last month\'s bank reconciliations before the books are closed. The statements are entered and reconciled ' +
      'weekly; this is the controller checking that the month is covered. For each bank account: read how far its ' +
      'statements and its reconciled frontier reach, and list its statements and reconciliations for last month. Report ' +
      'any week of the month with no statement, any statement with no finalized reconciliation, and any reconciliation ' +
      'still in progress or only submitted. Read the report and the audit of the reconciliation that covers month end: ' +
      'say what was adjusted (bank charges, interest), and how many items are still outstanding and how old the oldest ' +
      'is — an item outstanding for more than two weeks is a finding. Read the bank transactions still unexplained. ' +
      'Finally read the bank reconciliation policy and the settlement lines awaiting a match. Change nothing: a week ' +
      'that was missed is for the bookkeeper to catch up, not for the reviewer.',
    operations: [
      'accounting.BankAccountsApi.listBankAccounts',
      'accounting.BankStatementsApi.listBankStatements',
      'accounting.BankStatementsApi.getBankStatement',
      'accounting.BankReconciliationApi.listReconciliations',
      'accounting.BankReconciliationApi.getReconciliation',
      'accounting.BankReconciliationApi.getReconciliationReport',
      'accounting.BankReconciliationApi.getReconciliationAudit',
      'accounting.BankReconciliationApi.getReconciliationReview',
      'accounting.BankTransactionsApi.listBankTransactions',
      'accounting.AccountingPeriodsApi.getBankReconciliationPolicy',
      'accounting.SettlementReconciliationApi.listSettlementLines',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.BankAccountsApi.listBankAccounts' },
      { kind: 'call', operation: 'accounting.BankStatementsApi.listBankStatements' },
      { kind: 'call', operation: 'accounting.BankReconciliationApi.listReconciliations' },
    ],
    limits: { maxSteps: 45, maxCalls: 50 },
  },
  {
    id: 'monthly-inventory-valuation',
    perSite: true,
    title: 'Monthly inventory review',
    cadence: 'monthly',
    dayOfMonth: 5,
    at: '10:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'Review inventory for the month. Read the inventory valuation and the site rollup for this location, the costing method ' +
      'configuration, open revaluations, scraps, lots and transfer orders, and the inventory ledger for the last month. ' +
      'Raise one scrap request for a single damaged unit of a product that is in stock and read it back; do not approve it. ' +
      'Read the inventory settings and the location tree.',
    operations: [
      'inventory.InventoryValuationApi.getInventoryValuation',
      'inventory.InventoryRollupApi.getSiteInventoryRollup',
      'inventory.ValuationMethodsApi.listCostingMethodConfigs',
      'inventory.InventoryRevaluationApi.listRevaluations',
      'inventory.ScrapsApi.listScraps',
      'inventory.ScrapsApi.createScrap',
      'inventory.ScrapsApi.getScrap',
      'inventory.LotsApi.listInventoryLots',
      'inventory.TransferOrdersApi.listTransferOrders',
      'inventory.InventoryLedgerApi.listInventoryLedger',
      'inventory.InventorySettingsApi.getInventorySettings',
      'inventory.InventoryLocationTreeApi.getLocationTree',
      'inventory.InventoryStockApi.listStock',
      'location.LocationAPIApi.listLocations',
    ],
    expect: [
      { kind: 'call', operation: 'inventory.InventoryValuationApi.getInventoryValuation' },
      { kind: 'call', operation: 'inventory.InventoryLedgerApi.listInventoryLedger' },
      { kind: 'calls', min: 6 },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'monthly-supplier-review',
    title: 'Monthly supplier review',
    cadence: 'monthly',
    dayOfMonth: 8,
    at: '10:00',
    persona: 'manager',
    kind: 'operations',
    goal:
      'Review suppliers. List supplier vendors, vendor profiles and favorite vendors; for one vendor read the profile, the ' +
      'commercial accounts and endpoint bindings, recent supplier exchanges and order transmissions, and the latest stock ' +
      'snapshot. Read vendor spend analytics and the vendor statements on file, and search the accounting vendor directory. ' +
      'Check fleet contracts and fleet authorizations needing review.',
    operations: [
      'supplier.SupplierVendorsApi.listSupplierVendors',
      'supplier.SupplierVendorsApi.getSupplierVendor',
      'supplier.SupplierVendorProfilesApi.listVendorProfiles',
      'supplier.SupplierVendorFavoritesApi.listFavoriteVendors',
      'supplier.SupplierCommercialAccountsApi.listCommercialAccounts',
      'supplier.SupplierEndpointBindingsApi.listEndpointBindings',
      'supplier.SupplierExchangeAuditApi.listSupplierExchanges',
      'supplier.SupplierOrderTransmissionApi.searchSupplierTransmissions',
      'supplier.SupplierStockSnapshotsApi.getLatestSupplierStockSnapshot',
      'supplier.SupplierFleetAuthorizationApi.listFleetContracts',
      'supplier.SupplierFleetAuthorizationApi.listFleetAuthorizationsNeedingReview',
      'accounting.AccountingAnalyticsApi.getVendorSpend',
      'accounting.VendorStatementsApi.listVendorStatements',
      'accounting.VendorDirectoryAPIApi.searchVendors',
    ],
    expect: [
      { kind: 'call', operation: 'supplier.SupplierVendorsApi.listSupplierVendors' },
      { kind: 'call', operation: 'accounting.AccountingAnalyticsApi.getVendorSpend' },
      { kind: 'calls', min: 6 },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'monthly-hr-admin',
    title: 'Monthly people administration',
    cadence: 'monthly',
    dayOfMonth: 10,
    at: '10:00',
    persona: 'manager',
    kind: 'operations',
    goal:
      'Do the monthly people admin. Read the employee status counts, search employees, list job roles and skills, and read ' +
      'one employee with their credentials, locations and staffing assignments. In the people directory, list people, read ' +
      'the same person, their postal address and the usernames linked to them. List the mechanics and technicians at one ' +
      'site and the approved time ready for payroll export.',
    operations: [
      'people.EmployeeAPIApi.getEmployeeStatusCounts',
      'people.EmployeeAPIApi.searchEmployees',
      'people.EmployeeAPIApi.getEmployee',
      'people.JobRoleAPIApi.listJobRoles',
      'people.SkillRegistryAPIApi.listSkills',
      'people.PersonCredentialAPIApi.listPersonCredentials',
      'people.PeopleAvailabilityAPIApi.listPersonLocations',
      'people.PeopleStaffingAssignmentsApi.listStaffingAssignments',
      'people.PeopleReportsAPIApi.listApprovedTimeForExport',
      'people-contact.PeopleAPIApi.listPeople',
      'people-contact.PeopleAPIApi.getPersonById',
      'people-contact.PostalAddressAPIApi.getPersonPostalAddress',
      'people-contact.UserPersonLinkingAPIApi.listUsernamesForPerson',
      'shop-manager.MechanicRosterAPIApi.listMechanics',
      'shop-manager.TechnicianAPIApi.listLocationTechnicians',
      'location.LocationAPIApi.listLocations',
    ],
    expect: [
      { kind: 'call', operation: 'people.EmployeeAPIApi.searchEmployees' },
      { kind: 'call', operation: 'people-contact.PeopleAPIApi.listPeople' },
      { kind: 'calls', min: 7 },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'monthly-platform-integrations',
    title: 'Monthly platform and integrations check',
    cadence: 'monthly',
    dayOfMonth: 12,
    at: '10:00',
    persona: 'admin',
    kind: 'operations',
    goal:
      'Check the platform services a tenant rarely touches. Event receiver: list event types and read the last-week event ' +
      'summary. Assistant service: list the LLM API configurations, system prompts, tool permissions and your conversations, ' +
      'and read the conversation policy. Vehicle fitment: list manufacturers and the makes of one. Bulk loader: list bulk ' +
      'load jobs. Marketing: list templates, starters and campaigns. Images: look up an image by a filename that does not ' +
      'exist and confirm the 404. Tenant registry: list tenants — a tenant administrator should be refused with 403, which ' +
      'is the correct result.',
    operations: [
      'event-receiver.EventTypesApi.listEventTypes',
      'event-receiver.EventSummaryApi.getEventSummaryLastWeek',
      'mcp-server.LLMAPIConfigurationApi.listLlmApiConfigs',
      'mcp-server.SystemPromptsApi.listSystemPrompts',
      'mcp-server.MCPToolPermissionsApi.listToolPermissions',
      'mcp-server.MCPConversationsApi.listMcpConversations',
      'mcp-server.MCPConversationsApi.getMcpConversationPolicy',
      'vehicle-fitment.VehicleFitmentAPIApi.listManufacturers',
      'vehicle-fitment.VehicleFitmentAPIApi.listMakesByManufacturer',
      'bulk-loader.BulkLoadJobsAPIApi.listBulkLoadJobs',
      'marketing.MarketingTemplatesApi.listMessageTemplates',
      'marketing.MarketingStartersApi.listMarketingStarters',
      'marketing.MarketingCampaignsApi.listCampaigns',
      'image.ImageAPIApi.getImageByFilename',
      'tenant.PlatformTenantAPIApi.listTenants',
    ],
    expect: [
      { kind: 'call', operation: 'event-receiver.EventTypesApi.listEventTypes' },
      { kind: 'call', operation: 'mcp-server.SystemPromptsApi.listSystemPrompts' },
      { kind: 'call', operation: 'vehicle-fitment.VehicleFitmentAPIApi.listManufacturers' },
      { kind: 'call', operation: 'bulk-loader.BulkLoadJobsAPIApi.listBulkLoadJobs' },
      { kind: 'call', operation: 'marketing.MarketingCampaignsApi.listCampaigns' },
      { kind: 'call', operation: 'image.ImageAPIApi.getImageByFilename' },
      { kind: 'call', operation: 'tenant.PlatformTenantAPIApi.listTenants' },
    ],
    limits: { maxSteps: 45, maxCalls: 50 },
  },
  {
    id: 'monthly-analytics-review',
    title: 'Monthly management review',
    cadence: 'monthly',
    dayOfMonth: 15,
    at: '14:00',
    persona: 'manager',
    kind: 'operations',
    goal:
      'Prepare the monthly management review from the analytics endpoints, for last calendar month: technician labor ' +
      'analytics, labor overruns by service type, reopened workorders and open workorders by customer; invoicing lag and ' +
      'revenue by customer; collections and payment lag cohorts; the customer insights overview and commercial watch list; ' +
      'marketing campaign overview. Count workorders by status. Summarize the three numbers that most deserve attention.',
    operations: [
      'workorder.WorkorderAnalyticsApi.getTechnicianLaborAnalytics',
      'workorder.WorkorderAnalyticsApi.getLaborOverrunsByServiceType',
      'workorder.WorkorderAnalyticsApi.getReopenedWorkorderAnalytics',
      'workorder.WorkorderAnalyticsApi.getOpenWorkordersByCustomer',
      'workorder.WorkOrderAPIApi.countWorkorders',
      'invoice.InvoiceAnalyticsApi.getInvoicingLag',
      'invoice.InvoiceAnalyticsApi.getRevenueByCustomer',
      'accounting.AccountingAnalyticsApi.getCollectionsAnalytics',
      'accounting.AccountingAnalyticsApi.getPaymentLagCohorts',
      'customer.CRMInsightsApi.getCustomerInsightsOverview',
      'customer.CRMInsightsApi.getCommercialWatchList',
      'marketing.MarketingCampaignsApi.getCampaignOverview',
    ],
    expect: [
      { kind: 'call', operation: 'workorder.WorkorderAnalyticsApi.getTechnicianLaborAnalytics' },
      { kind: 'call', operation: 'invoice.InvoiceAnalyticsApi.getRevenueByCustomer' },
      { kind: 'call', operation: 'accounting.AccountingAnalyticsApi.getCollectionsAnalytics' },
      { kind: 'calls', min: 7 },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'monthly-error-contracts',
    title: 'Error drill: validation, conflict and idempotency contracts',
    cadence: 'monthly',
    dayOfMonth: 18,
    at: '11:00',
    persona: 'advisor',
    kind: 'error',
    goal:
      'Probe the error contracts, one call each, and report any answer that is a 5xx or has no machine-readable code. ' +
      '(1) Validation: with sdk_call and validate=false, create an appointment with an empty body, create an estimate with ' +
      'an empty body, and create a cart with an empty body — each should answer 400 or 422 with field errors. ' +
      '(2) Conflict: find any register session that is OPEN (not CLOSING) and call confirm-close on it — it should answer ' +
      '409; if you cannot find one, call confirm-close with a random UUID and expect 404. ' +
      '(3) Idempotency: record a cash movement on a random session id with a blank Idempotency-Key (validate=false, ' +
      'idempotencyKey "") and note whether the missing key (400) or the missing session (404) is reported first.',
    operations: [
      'shop-manager.AppointmentsAPIApi.createAppointment',
      'workorder.EstimateAPIApi.createEstimate',
      'order.SalesOrdersApi.createCart',
      'order.RegisterSessionsApi.getCurrentRegisterSession',
      'order.RegisterSessionsApi.confirmSessionClose',
      'order.RegisterSessionsApi.recordCashMovement',
    ],
    expect: [
      { kind: 'http', statuses: [400, 422], min: 2 },
      { kind: 'http', statuses: [400, 404, 409, 422], min: 4 },
    ],
  },
  {
    id: 'monthly-agreements-and-fleet',
    title: 'Monthly agreements, fleet and vehicle upkeep',
    cadence: 'monthly',
    dayOfMonth: 20,
    at: '10:00',
    persona: 'advisor',
    kind: 'operations',
    goal:
      'Review recurring customer commitments. List service agreements and the renewals coming due, customer segments and ' +
      'the duplicate-customer candidates. For one vehicle: read it from the vehicle registry, its preferences and its ' +
      'service due dates, and its CRM snapshot. Check promotion offers by reading one by code if you can find a code, list ' +
      'the travel buffer policies, service areas and mobile units for one site, and the returns awaiting processing.',
    operations: [
      'customer.CRMServiceAgreementsApi.listServiceAgreements',
      'customer.CRMServiceAgreementsApi.listServiceAgreementRenewals',
      'customer.CRMSegmentsApi.listSegments',
      'customer.CRMDuplicatesApi.listDuplicateCandidates',
      'customer.CRMSnapshotsApi.getSnapshotByVehicle',
      'vehicle-inventory.VehicleSearchApi.searchVehicles',
      'vehicle-inventory.VehicleRegistryAPIApi.getVehicle',
      'vehicle-inventory.VehiclePreferencesApi.getVehiclePreferences',
      'vehicle-inventory.VehicleDueDatesApi.listVehicleDueDates',
      'location.LocationAPIApi.listLocations',
      'location.TravelBufferPolicyAPIApi.listTravelBufferPolicies',
      'location.ServiceAreaAPIApi.listServiceAreas',
      'location.MobileUnitAPIApi.listMobileUnits',
      'order.ReturnsApi.listReturns',
      'price.PromotionEligibilityRulesApi.listPromotionEligibilityRules',
    ],
    expect: [
      { kind: 'call', operation: 'customer.CRMServiceAgreementsApi.listServiceAgreements' },
      { kind: 'call', operation: 'vehicle-inventory.VehicleSearchApi.searchVehicles' },
      { kind: 'call', operation: 'location.MobileUnitAPIApi.listMobileUnits' },
      { kind: 'calls', min: 7 },
    ],
    limits: { maxSteps: 40 },
  },
];

export const SCENARIOS = defineScenarios([...daily, ...weekly, ...monthly]);

/**
 * The coverage sweep is not in the list above because it has no fixed
 * operations: the planner fills it each day with the operations the month has
 * not reached yet (see runner/sweep.ts).
 */
export const SWEEP_SCENARIO_ID = 'coverage-sweep';
export const SWEEP_SLOT = '16:15';
