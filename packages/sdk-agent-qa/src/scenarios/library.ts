/**
 * The scenario library: what a tenant does in a day, a week and a month.
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
    title: 'Open the shop for the day',
    cadence: 'daily',
    at: '07:45',
    persona: 'manager',
    kind: 'operations',
    goal:
      'It is opening time. Pick one site (list locations and choose an active shop location). Review the dispatch board and ' +
      'the shop dashboard for that site, read the register session policy, and check whether the front-counter terminal already ' +
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
    id: 'appointments-intake',
    title: 'Book and review appointments',
    cadence: 'daily',
    at: '08:30',
    persona: 'advisor',
    kind: 'operations',
    goal:
      'A customer calls to book a service visit. Look at today\'s appointments and the schedule for one site, search for open ' +
      'slots in the next few days, find an existing customer (search parties), and book an appointment for them in one of the ' +
      'openings. Then read the appointment back to confirm it was stored as booked.',
    operations: [
      'location.LocationAPIApi.listLocations',
      'shop-manager.AppointmentsAPIApi.listAppointments',
      'shop-manager.ScheduleAPIApi.viewSchedule',
      'shop-manager.ScheduleAPIApi.searchOpenings',
      'shop-manager.ScheduleAPIApi.getScheduleCapacity',
      'customer.CRMAccountsApi.searchParties',
      'customer.CRMVehiclesApi.listVehiclesForCustomer',
      'shop-manager.AppointmentsAPIApi.createAppointment',
      'shop-manager.AppointmentsAPIApi.getAppointmentById',
    ],
    expect: [
      { kind: 'call', operation: 'shop-manager.AppointmentsAPIApi.listAppointments' },
      { kind: 'call', operation: 'customer.CRMAccountsApi.searchParties' },
      { kind: 'call', operation: 'shop-manager.AppointmentsAPIApi.createAppointment' },
    ],
  },
  {
    id: 'walk-in-estimate',
    title: 'Write an estimate for a walk-in and turn it into a workorder',
    cadence: 'daily',
    at: '09:30',
    persona: 'advisor',
    kind: 'operations',
    goal:
      'A walk-in customer wants a brake inspection and an oil change. Find the customer (or create a person if the search finds ' +
      'nobody suitable), find one of their vehicles, and write a draft estimate for a site with one or two service lines from ' +
      'the catalog. Calculate the totals, submit the estimate for approval, approve it, and promote it to a workorder. Read the ' +
      'workorder back.',
    operations: [
      'location.LocationAPIApi.listLocations',
      'customer.CRMAccountsApi.searchParties',
      'customer.CRMPersonsApi.createCrmPerson',
      'customer.CRMVehiclesApi.listVehiclesForCustomer',
      'vehicle-inventory.VehicleSearchApi.searchVehicles',
      'catalog.ProductsAPIApi.listClaimableServices',
      'workorder.EstimateAPIApi.createEstimate',
      'workorder.EstimateAPIApi.addEstimateItem',
      'workorder.EstimateAPIApi.calculateEstimateTotals',
      'workorder.EstimateAPIApi.submitEstimateForApproval',
      'workorder.EstimateAPIApi.approveEstimate',
      'workorder.EstimateAPIApi.promoteEstimate',
      'workorder.EstimateAPIApi.getEstimate',
      'workorder.WorkOrderAPIApi.getWorkorder',
    ],
    expect: [
      { kind: 'call', operation: 'customer.CRMAccountsApi.searchParties' },
      { kind: 'call', operation: 'workorder.EstimateAPIApi.createEstimate' },
      { kind: 'calls', min: 6 },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'counter-sale',
    title: 'Ring up a parts counter sale',
    cadence: 'daily',
    at: '10:30',
    persona: 'advisor',
    kind: 'operations',
    goal:
      'A customer buys a part over the counter. Find a product that is in stock, start a cart on the open register session, add ' +
      'the product, quote the cart, attach a customer, check the order out and take a cash tender for the total. Read the order ' +
      'back and confirm its status.',
    operations: [
      'inventory.InventoryStockApi.listStock',
      'catalog.ProductsAPIApi.findProductByCode',
      'order.RegisterSessionsApi.getCurrentRegisterSession',
      'order.SalesOrdersApi.listCarts',
      'order.SalesOrdersApi.createCart',
      'order.SalesOrdersApi.addCartItem',
      'order.SalesOrdersApi.quoteCart',
      'order.SalesOrdersApi.setCartCustomer',
      'order.SalesOrdersApi.checkoutOrder',
      'order.SalesOrdersApi.recordCashTender',
      'order.SalesOrdersApi.getOrder',
      'customer.CRMAccountsApi.searchParties',
      'price.PriceQuotesApi.calculatePriceQuote',
    ],
    expect: [
      { kind: 'call', operation: 'order.SalesOrdersApi.createCart' },
      { kind: 'call', operation: 'inventory.InventoryStockApi.listStock' },
      { kind: 'calls', min: 5 },
    ],
    limits: { maxSteps: 40 },
  },
  {
    id: 'workorder-execution',
    title: 'Work a job on the floor',
    cadence: 'daily',
    at: '11:30',
    persona: 'tech',
    kind: 'operations',
    goal:
      'You are a technician picking up your next job. List the work in progress, open one workorder that is in progress (or ' +
      'ready to start), read its detail, pick list and labor history, add a note describing what you found, and check which ' +
      'timers are active. If the workorder has an open labor session leave it running; otherwise start one. Finally check ' +
      'whether the workorder meets its completion preconditions — do not complete it.',
    operations: [
      'workorder.WIPDashboardApi.listWipWorkorders',
      'workorder.WorkorderSearchApi.searchWorkorders',
      'workorder.WorkorderDetailApi.getWorkorderDetail',
      'workorder.WorkorderPickFacadeApi.getWorkorderPickList',
      'workorder.WorkorderLaborAPIApi.getLaborHistory',
      'workorder.WorkorderLaborAPIApi.startLaborSession',
      'workorder.WorkorderNoteAPIApi.addWorkorderNote',
      'workorder.WorkorderNoteAPIApi.listWorkorderNotes',
      'workorder.WorkexecTimeTrackingAPIApi.getActiveTimers',
      'workorder.WorkOrderAPIApi.getCompletionPreconditions',
      'workorder.WorkorderPartsUsageApi.getPartsUsageHistory',
    ],
    expect: [
      { kind: 'call', operation: 'workorder.WIPDashboardApi.listWipWorkorders' },
      { kind: 'call', operation: 'workorder.WorkorderDetailApi.getWorkorderDetail' },
      { kind: 'calls', min: 5 },
    ],
  },
  {
    id: 'parts-receiving',
    title: 'Receive a delivery and put it away',
    cadence: 'daily',
    at: '13:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'The parts truck has arrived. Review open purchase orders and the receipts expected today, then check the putaway queue ' +
      'and the workorder picks queue. If a purchase order is open and approved, start a receiving session for it and receive ' +
      'one line into staging; if nothing is receivable, say so. Finish by checking stock status counts and current backorders.',
    operations: [
      'order.PurchaseOrdersApi.listPurchaseOrders',
      'order.PurchaseOrdersApi.getPurchaseOrder',
      'order.PurchaseOrdersApi.summarizePurchaseOrders',
      'inventory.ReceiptsApi.listExpectedReceipts',
      'inventory.ReceiptsApi.listPendingReceipts',
      'inventory.ReceivingApi.createReceivingSession',
      'inventory.ReceivingApi.receiveItemsIntoStaging',
      'inventory.ReceivingApi.getReceivingSession',
      'inventory.PutawayQueueApi.listPutawayQueue',
      'inventory.WorkorderQueueApi.listWorkorderPicksQueue',
      'inventory.InventoryStockApi.getStockStatusCounts',
      'inventory.BackordersApi.listBackorders',
    ],
    expect: [
      { kind: 'call', operation: 'order.PurchaseOrdersApi.listPurchaseOrders' },
      { kind: 'call', operation: 'inventory.PutawayQueueApi.listPutawayQueue' },
      { kind: 'calls', min: 5 },
    ],
  },
  {
    id: 'invoice-and-payment',
    title: 'Invoice finished work and take payment',
    cadence: 'daily',
    at: '14:30',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Bill for finished work. Search recent invoices, pick one that is finalized but not fully paid (if any), read it and its ' +
      'payments, and record a cash payment for the balance, then generate a receipt. If every invoice is already paid, read one ' +
      'paid invoice with its payments and receipt artifacts instead. Also list unapplied payments and the open invoices of one ' +
      'customer in accounting.',
    operations: [
      'invoice.InvoiceSearchApi.searchInvoices',
      'invoice.InvoiceApi.getInvoice',
      'invoice.InvoiceApi.getInvoiceByWorkorder',
      'invoice.PaymentApi.listInvoicePayments',
      'invoice.PaymentApi.recordCashPayment',
      'invoice.ReceiptApi.generateReceipt',
      'invoice.InvoiceArtifactControllerApi.listInvoiceArtifacts',
      'invoice.BillingRulesApi.getBillingRules',
      'accounting.PaymentApplicationsApi.listUnappliedPayments',
      'accounting.PaymentApplicationsApi.listCustomerOpenInvoices',
      'accounting.InvoicePaymentsApi.getInvoiceStatus',
    ],
    expect: [
      { kind: 'call', operation: 'invoice.InvoiceSearchApi.searchInvoices' },
      { kind: 'call', operation: 'invoice.InvoiceApi.getInvoice' },
      { kind: 'calls', min: 4 },
    ],
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
    id: 'close-shop',
    title: 'Close out the day',
    cadence: 'daily',
    at: '17:45',
    persona: 'manager',
    kind: 'operations',
    goal:
      'It is closing time. Find the register session that is open on the front-counter terminal. Read its X report and its cash ' +
      'movements. If the session is open and has no orders awaiting payment, begin the close with a counted cash figure that ' +
      'matches the X report\'s expected cash, then confirm the close and read the Z report. Check which closed sessions are ' +
      'still undeposited. Finally stop your own work session if one is open.',
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
    title: 'Weekly stock order',
    cadence: 'weekly',
    weekday: 1,
    at: '09:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'Place the weekly stock order. Review replenishment needs and purchase suggestions, the purchase shortfalls, and the ' +
      'vendors you can order from. Raise one purchase order to an approved vendor for one or two products that are below their ' +
      'stocking level, then read it back and check its supplier availability. Do not transmit it.',
    operations: [
      'inventory.ReplenishmentApi.listReplenishmentNeeds',
      'inventory.ReplenishmentApi.listReplenishmentSuggestions',
      'inventory.PurchaseSuggestionsApi.listPurchaseSuggestions',
      'inventory.PurchaseShortfallsApi.listPurchaseShortfalls',
      'inventory.StockingLevelsApi.listStockingLevels',
      'order.PurchaseOrdersApi.listPurchaseOrderVendors',
      'supplier.SupplierVendorsApi.listSupplierVendors',
      'order.PurchaseOrdersApi.createPurchaseOrder',
      'order.PurchaseOrdersApi.getPurchaseOrder',
      'order.PurchaseOrdersApi.getPurchaseOrderSupplierAvailability',
    ],
    expect: [
      { kind: 'call', operation: 'inventory.PurchaseSuggestionsApi.listPurchaseSuggestions' },
      { kind: 'call', operation: 'order.PurchaseOrdersApi.listPurchaseOrderVendors' },
      { kind: 'call', operation: 'order.PurchaseOrdersApi.createPurchaseOrder' },
    ],
  },
  {
    id: 'weekly-cycle-count',
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
    title: 'Weekly timesheet approval',
    cadence: 'weekly',
    weekday: 4,
    at: '14:00',
    persona: 'manager',
    kind: 'operations',
    goal:
      'Approve the week\'s time. List the time periods and the people awaiting timekeeping approval, review time entries and ' +
      'any time entry exceptions for the current period, and read the attendance discrepancy report. If there are submitted ' +
      'time entries with no open exception, approve a small batch of them. Also review staffing assignments for one site.',
    operations: [
      'people.TimekeepingApprovalAPIApi.listTimePeriods',
      'people.TimekeepingApprovalAPIApi.listTimekeepingApprovalPeople',
      'people.TimekeepingApprovalAPIApi.listTimekeepingEntries',
      'people.TimeEntryApprovalAPIApi.listTimeEntries',
      'people.TimeEntryApprovalAPIApi.approveTimeEntriesBatch',
      'people.PeopleExceptionsApi.listTimeEntryExceptions',
      'people.PeopleReportsAPIApi.getAttendanceDiscrepancyReport',
      'people.PeopleStaffingAssignmentsApi.listStaffingAssignments',
      'location.LocationAPIApi.listLocations',
    ],
    expect: [
      { kind: 'call', operation: 'people.TimekeepingApprovalAPIApi.listTimePeriods' },
      { kind: 'call', operation: 'people.TimeEntryApprovalAPIApi.listTimeEntries' },
      { kind: 'calls', min: 4 },
    ],
  },
  {
    id: 'weekly-ap-run',
    title: 'Weekly payables run',
    cadence: 'weekly',
    weekday: 5,
    at: '11:00',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Prepare the weekly payables run. Read the vendor bill stage counts and the bills in each open stage, the AP approval ' +
      'policy, the bills ready to pay and the accounts you can pay from, payments in flight, and the cash position and ' +
      'outlook. If a vendor bill is waiting for approval and is matched, approve it. Do not execute a payment.',
    operations: [
      'accounting.VendorBillAPIApi.getVendorBillStageCounts',
      'accounting.VendorBillAPIApi.listVendorBills',
      'accounting.VendorBillAPIApi.getVendorBillById',
      'accounting.VendorBillAPIApi.approveVendorBill',
      'accounting.APApprovalPolicyApi.getApApprovalPolicy',
      'accounting.APPaymentsApi.listApBills',
      'accounting.APPaymentsApi.listApPayFromAccounts',
      'accounting.APPaymentsApi.listApPaymentsInFlight',
      'accounting.CashPositionApi.getCashPosition',
      'accounting.CashPositionApi.getCashOutlook',
      'accounting.BillIntakeApi.listBillIntake',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.VendorBillAPIApi.getVendorBillStageCounts' },
      { kind: 'call', operation: 'accounting.APPaymentsApi.listApBills' },
      { kind: 'call', operation: 'accounting.CashPositionApi.getCashPosition' },
    ],
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
    title: 'Monthly bank reconciliation',
    cadence: 'monthly',
    dayOfMonth: 3,
    at: '10:00',
    persona: 'acct',
    kind: 'operations',
    goal:
      'Reconcile the bank for last month. List bank accounts, statements, imports and transactions. If a statement exists for ' +
      'an account with no finalized reconciliation, start a reconciliation for it, run the auto-match, and read the ' +
      'reconciliation and its report; do not finalize. Otherwise read an existing reconciliation and its audit. Finish with ' +
      'the settlement lines awaiting a match and the tax registrations on file.',
    operations: [
      'accounting.BankAccountsApi.listBankAccounts',
      'accounting.BankStatementsApi.listBankStatements',
      'accounting.BankImportsApi.listBankImports',
      'accounting.BankTransactionsApi.listBankTransactions',
      'accounting.BankReconciliationApi.createReconciliation',
      'accounting.BankReconciliationApi.autoMatchReconciliation',
      'accounting.BankReconciliationApi.getReconciliation',
      'accounting.BankReconciliationApi.getReconciliationReport',
      'accounting.BankReconciliationApi.getReconciliationAudit',
      'accounting.SettlementReconciliationApi.listSettlementLines',
      'accounting.AccountingTaxRegistrationsApi.listTaxRegistrations',
    ],
    expect: [
      { kind: 'call', operation: 'accounting.BankAccountsApi.listBankAccounts' },
      { kind: 'call', operation: 'accounting.BankStatementsApi.listBankStatements' },
      { kind: 'calls', min: 5 },
    ],
  },
  {
    id: 'monthly-inventory-valuation',
    title: 'Monthly inventory review',
    cadence: 'monthly',
    dayOfMonth: 5,
    at: '10:00',
    persona: 'parts',
    kind: 'operations',
    goal:
      'Review inventory for the month. Read the inventory valuation and the site rollup for one site, the costing method ' +
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
