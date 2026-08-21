## Backend Interaction Test Specification (Non-Accelerated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a deterministic, real-time (non-accelerated) integration test
suite that exercises the Durion Positivity backend through the published SDK
packages. The suite covers four interaction areas end to end: **appointments**,
**estimates**, **workorder execution**, and **receiving** (new products into
stock, and products destined for a specific workorder). It reuses the
interaction sequences proven out by the accelerated-clock seeder
(`packages/sdk-seeder`), but runs them as verifiable Jest test cases against a
backend on an ordinary system clock.

**Target environment:** the **alpha** stack on EC2, on its normal (converged,
non-accelerated) clock, against the persistent alpha PostgreSQL — test runs
write real records that remain in the alpha database afterward.

**Execution model:** the suite runs **from the developer's laptop** with plain
`npm run test:integration`. Alpha has no public API ingress, so laptop access
goes through an AWS SSM port-forwarding tunnel to the alpha EC2 host (no new
security-group ingress, no VPN): local ports are forwarded to the gateway and
security service, and the tests simply point `ITEST_BASE_URL` at
`http://localhost:<port>`. A helper script (Task 7) opens the tunnel. A local
Compose backend also works for developing the tests themselves — the harness
is identical either way, only the URLs change.

**Component:** A new private workspace package, `packages/sdk-integration-tests`.
Keeping it separate from `src/__tests__` (unit tests) and `sdk-seeder`
(data generation) means: no coverage-threshold coupling, no accidental runs in
the default `npm test`, and a dependency surface that mirrors a real SDK
consumer.

**Tech stack:** Jest 29 + ts-jest (already the repo standard), TypeScript,
Node 22, the `@durion-sdk/*` workspace packages, and the seeder's bootstrap
fixtures re-exported as a library.

---

### Relationship to the Accelerated Seeder

The seeder is a *generator*: it drives the same endpoints but tolerates and
logs most failures so a year-long run survives. This suite is a *verifier*:
each step asserts its response, and a failed step fails the test. The mapping:

| Seeder source (accelerated) | This suite (non-accelerated) |
| --- | --- |
| `loop/CustomerEventSimulator.ts` | Suites B (estimates) and C (workorder execution) as asserted tests |
| `loop/InventoryMaintenanceSimulator.ts` (`runMonthlyRestock`) | Suite D (receiving) as asserted tests |
| `bootstrap/*` (security, location, people, catalog, inventory) | Reused verbatim as global test fixtures |
| `support/VirtualClock.ts`, `/system/time` polling | **Not used.** Real wall clock; `/system/time` only exists under the `accelerated` profile |
| Day loop, shift clock-in/out, day-boundary waits | **Not used.** Tests are single-pass; shift/time-entry flows are out of scope |
| Appointments | **New here.** The seeder never books appointments; Suite A adds shop-manager appointment coverage and the appointment→estimate bridge |

Non-accelerated consequences to design around:

- No virtual-day boundaries: nothing in these tests may wait for a calendar
  day to pass. Any date math (appointment windows, ASN
  `expectedArrivalDate`) uses real future dates and never requires the clock
  to reach them.
- Cross-service propagation (CRM party/vehicle → workorder replicas via
  Kafka) happens at real event-latency. Tests must poll with a bounded
  `waitFor` helper, never fixed `sleep`s, and never assume immediacy.
- Alpha is a shared, persistent environment and keeping the records is the
  point: tests append data and never truncate, delete, or clean up. Every
  created entity carries a per-run marker for traceability, so a run's
  records can be found in the alpha database afterward.
- Tests must not assume an empty database. Alpha already holds a year of
  seeder history (and prior test runs), so every assertion is scoped to
  entities the run itself created, and every quantity assertion compares
  deltas against a snapshot taken by the same run.

### Environment Contract

Configuration is environment-variable driven, mirroring `SeederConfig`:

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `ITEST_BASE_URL` | `http://localhost:8080` | No | API gateway base URL |
| `ITEST_SECURITY_SERVICE_URL` | `http://localhost:8086` | No | Direct security service URL (bootstrap + login) |
| `ITEST_USERNAME` | — | **Yes** | Login username |
| `ITEST_PASSWORD` | — | **Yes** | Login password |
| `ITEST_SEED` | _(random)_ | No | Integer RNG seed for reproducible data values |
| `ITEST_WAIT_TIMEOUT_MS` | `30000` | No | Default `waitFor` polling timeout |
| `ITEST_WAIT_INTERVAL_MS` | `500` | No | Default `waitFor` polling interval |

For an alpha run from the laptop, the tunnel (Task 7) maps local ports onto
the alpha gateway and security service, and the shell exports:

```properties
ITEST_BASE_URL=http://localhost:18080          # tunneled pos-api-gateway
ITEST_SECURITY_SERVICE_URL=http://localhost:18086  # tunneled pos-security-service
ITEST_USERNAME=<alpha seeder/admin username>
ITEST_PASSWORD=<alpha password>
```

Credentials live in the developer's shell or a git-ignored `.env.itest` file —
never printed, never committed. When `ITEST_USERNAME`/`ITEST_PASSWORD` are
absent, the suite must fail fast in global setup with a single clear message —
not skip silently and not error once per test file.

Run commands (repo root):

```powershell
# terminal 1: open the tunnel to alpha (stays running)
.\scripts\alpha-itest-tunnel.ps1

# terminal 2: run the suite
npm run test:integration                 # whole suite
npm run test:integration -- appointments # one suite by filename substring
```

The same commands with `ITEST_BASE_URL=http://localhost:8080` (and no tunnel)
run against a local Compose backend during test development.

Alpha runs require the accelerated profile to be **off** (the normal alpha
deployment state). Global setup asserts this by probing `GET /system/time`:
a 404/absent endpoint means the normal clock and the run proceeds; a 200
response means alpha is mid-accelerated-run and the suite aborts before
writing anything.

### Test Framework Layout

```
packages/sdk-integration-tests/
  package.json                # private, depends on @durion-sdk/* + @durion-sdk/seeder
  tsconfig.json
  jest.integration.config.js  # referenced by root npm script
  src/
    harness/
      ItestConfig.ts          # env parsing (shape above)
      ItestContext.ts         # auth + ReferenceCache + runId, built once in globalSetup
      globalSetup.ts          # login, bootstrap, serialize context to a temp JSON file
      waitFor.ts              # bounded polling helper
      http.ts                 # formatError / isHttpStatus (lifted from CustomerEventSimulator)
      builders.ts             # request builders: customers, vehicles, estimates, POs, ASNs
    suites/
      a-appointments.itest.ts
      b-estimates.itest.ts
      c-workorder-execution.itest.ts
      d-receiving.itest.ts
```

Framework decisions:

- **Jest config:** `testMatch: ['**/*.itest.ts']`, `maxWorkers: 1` (suites
  share one authenticated context and the workexec timer API is
  per-user-singleton — parallel workers would race on `stopTimers`),
  `testTimeout: 120_000`, `globalSetup` for bootstrap, **no coverage
  collection** (these tests measure the backend, not SDK line coverage).
- **Root `jest.config.js` must ignore `**/*.itest.ts`** so `npm test` stays a
  pure offline unit run. CI keeps the two jobs separate; the integration job
  only runs where a backend URL is provided (manual dispatch or a
  compose-backed job), and is never a PR gate by default.
- **Ordering:** within a file, `test`s run in declaration order and may build
  on earlier steps of the same scenario (a scenario *is* the unit under
  test). Across files there are no dependencies; each file provisions its own
  customer, vehicle, estimate, and workorder through `builders.ts`.
- **Determinism:** reuse `SeederRandom` seeded from `ITEST_SEED` for data
  values (names, VINs, prices). Uniqueness tokens (PO/ASN reference numbers,
  idempotency keys) derive from the per-run `runId`
  (`itest-<epochSeconds>-<random4>`), which also lands in every free-text
  field the API offers (`comment`, `notes`, `description`) for traceability.

### Fixtures: Reuse the Seeder Bootstrap

The seeder already knows how to stand up an admin user, location, employees,
catalog, and stocked inventory idempotently. Re-running its bootstrap against
an already-seeded backend is a no-op by design, which is exactly the fixture
behavior this suite needs.

`globalSetup.ts` performs, once per run:

1. `SecurityBootstrap.run()` — ensure the admin account exists.
2. `SeederAuth.login()` — acquire the JWT pair.
3. `BootstrapOrchestrator.run()` — returns the `ReferenceCache`
   (locationId, employee ids by role, service/product entity ids and names).
4. Serialize `{ referenceCache, tokenPair, runId }` to a JSON file in the OS
   temp dir; test files rehydrate it in `beforeAll` (Jest globalSetup runs in
   a separate process, so context must cross via disk).

This requires `sdk-seeder` to export its internals as a library (today
`src/index.ts` is only an executable entrypoint) — Task 1 below.

---

### Task 1: Export Seeder Fixtures as a Library

**Files:**

- Create: `packages/sdk-seeder/src/lib.ts`
- Modify: `packages/sdk-seeder/package.json` (add `main`/`exports` pointing at `src/lib.ts`)
- Test: `packages/sdk-seeder/src/lib.test.ts`

- [ ] **Step 1: Write a failing import test**

A unit test importing `SeederAuth`, `SeederConfig`, `SecurityBootstrap`,
`BootstrapOrchestrator`, `ReferenceCache`, and `SeederRandom` from the package
root and asserting they are constructible types. Run with `npm test`.

- [ ] **Step 2: Add the barrel and package exports**

`lib.ts` re-exports the classes above plus the `SEED_VENDOR_ID` constant from
`bootstrap/InventoryBootstrap`. Do not move `index.ts`; the `seed` script keeps
running it directly. Keep the seeder's Docker image and CI behavior unchanged.

- [ ] **Step 3: Decouple config construction from `process.env` naming**

`SeederConfig.fromEnv()` reads `SEEDER_*` names. Add a
`SeederConfig.fromValues(shape)` factory so the integration harness can map
`ITEST_*` variables onto it without fake env mutation. Validation rules stay in
one place.

- [ ] **Step 4: Verify**

```bash
npm test -- --runInBand packages/sdk-seeder
npm run build
```

Expected: Jest and TypeScript compilation pass; seeder image build unaffected.

### Task 2: Scaffold the Integration Package and Harness

**Files:**

- Create: `packages/sdk-integration-tests/package.json`, `tsconfig.json`,
  `jest.integration.config.js`
- Create: `src/harness/ItestConfig.ts`, `ItestContext.ts`, `globalSetup.ts`,
  `waitFor.ts`, `http.ts`, `builders.ts`
- Modify: root `package.json` (add `test:integration` script), root
  `jest.config.js` (ignore `*.itest.ts`)
- Test: unit tests for `ItestConfig` parsing and `waitFor` semantics (these
  are plain unit tests, runnable offline)

- [ ] **Step 1: Write failing unit tests for the harness primitives**

`ItestConfig`: required-variable failure message names every missing variable
in one error; defaults applied; non-integer timeout rejected. `waitFor`:
resolves on first truthy predicate result, polls at the configured interval,
rejects with the last predicate error (not a generic timeout) after the
deadline, never overlaps in-flight predicate calls.

- [ ] **Step 2: Implement the harness**

- `waitFor<T>(fn: () => Promise<T | undefined>, opts?): Promise<T>` — the
  only sanctioned waiting mechanism in suite code. Raw `setTimeout` sleeps are
  forbidden outside `waitFor` (enforce by lint comment convention and review).
- `http.ts` — lift `formatError` and `isHttpStatus` from
  `CustomerEventSimulator` unchanged; add `expectHttpError(promise, status)`
  for negative-path assertions.
- `builders.ts` — thin, assertive wrappers returning ids or throwing:
  `createPersonAccount()`, `createVehicle(partyId)`,
  `createDraftEstimate(partyId, vehicleId)`,
  `addLaborLine(estimateId, serviceId)`, `addPartLine(estimateId, productId, qty)`,
  `approveAndPromote(estimateId)` (submit → approve → promote → return
  `{ workorderId, serviceItemMap }`), `createApprovedPo(products, qty)`,
  `createAsnForPo(po)`. Builders call the same SDK methods with the same field
  shapes as `CustomerEventSimulator`/`InventoryMaintenanceSimulator` — those
  shapes are backend-proven; do not improvise new ones.

- [ ] **Step 3: Wire global setup and context rehydration**

Implement serialization as described in *Fixtures* above. Global setup failures
must print the failing bootstrap stage and the formatted HTTP error.

- [ ] **Step 4: Verify offline behavior**

```bash
npm test            # unit run: harness unit tests pass, no *.itest.ts collected
npm run build
npm run test:integration   # without credentials: fails fast with the single clear message
```

### Task 3: Suite A — Appointments

**File:** `src/suites/a-appointments.itest.ts`

SDK surface: `@durion-sdk/shop-manager` `AppointmentsAPIApi`
(`createAppointment`, `getAppointmentById`, `rescheduleAppointment`,
`cancelAppointment`) and `@durion-sdk/workorder` `EstimatesFromAppointmentsApi`
(`createEstimateFromAppointment`). Appointment windows use real near-future
times (e.g. tomorrow 09:00–10:00 UTC) — valid on a normal clock, no waiting.

- [ ] **A1 — Book an appointment.** Create a fresh person account + vehicle via
  builders. `createAppointment` with `crmCustomerId`, `crmVehicleId`,
  `locationId`, tomorrow's `startAt`/`endAt`, `serviceRequestIds` drawn from
  bootstrap service entity ids. Assert: id returned, echoed fields match, and
  status is the backend's initial state (capture actual value; assert
  non-cancelled).
- [ ] **A2 — Fetch by id.** `getAppointmentById` returns the same appointment;
  round-trips the schedule window.
- [ ] **A3 — Reschedule.** Move the window one hour later. Assert the response
  reflects the new window; re-fetch confirms persistence.
- [ ] **A4 — Cancel.** `cancelAppointment` with a reason. Assert cancelled
  status. Then assert `rescheduleAppointment` on the cancelled appointment is
  rejected via `expectHttpError` (record the actual 4xx the backend uses).
- [ ] **A5 — Appointment → estimate bridge (idempotent).** On a second, active
  appointment: `createEstimateFromAppointment` with a runId-derived
  `idempotencyKey`. Assert `created === true` and an `estimateId`. Call again
  with the same key: assert `created === false` and the **same** `estimateId`.
  The returned estimate must be fetchable through `EstimateAPIApi` and carry
  the appointment's customer/vehicle.
- [ ] **A6 — Validation negative.** `createAppointment` with `endAt` before
  `startAt` is rejected with a 4xx and no appointment is created.

### Task 4: Suite B — Estimates

**File:** `src/suites/b-estimates.itest.ts`

SDK surface: `@durion-sdk/workorder` `EstimateAPIApi`. Sequences mirror
`CustomerEventSimulator.simulate` steps `createEstimate` through
`customerDecision`, with assertions replacing tolerant logging.

- [ ] **B1 — Create a draft estimate.** For a fresh party/vehicle:
  `createEstimate` with the seeder's field shape (`customerId`, `vehicleId`,
  `crmPartyId`, `crmVehicleId`, `crmContactIds: []`, `currencyUomId: 'USD'`,
  `locationId`). Assert an estimate id.
- [ ] **B2 — Add labor and part lines.** Two labor lines
  (`itemType: Labor`, `serviceId`, qty 1, known unit prices) and one part line
  (`itemType: Part`, `productId`, qty 2, known unit price). Assert each line
  returns an id.
- [ ] **B3 — Totals.** `calculateEstimateTotals`; assert the computed total
  equals the arithmetic sum of the lines added in B2 (exact expected value —
  prices are chosen by the test, not random here). Record and assert tax
  handling as observed (document actual behavior in the test).
- [ ] **B4 — Submit for approval.** Assert resulting status transition.
- [ ] **B5 — Approve with signature.** `approveEstimate` with signature
  payload (base64 data, signer name, `image/png`). Assert approved status.
- [ ] **B6 — Decline path.** On a second estimate: submit, then
  `declineEstimate` with a reason. Assert declined status, and assert
  `promoteEstimate` on the declined estimate is rejected (4xx).
- [ ] **B7 — Promote.** Promote the approved estimate. Assert a workorder id,
  and that `getWorkorderDetail` lists one workorder service item per B2 labor
  line with matching `serviceEntityId`, and the part line present with its
  quantity.
- [ ] **B8 — Lifecycle negative.** `approveEstimate` on the already-promoted
  estimate is rejected; adding an item to a promoted estimate is rejected.

### Task 5: Suite C — Workorder Execution

**File:** `src/suites/c-workorder-execution.itest.ts`

SDK surface: `@durion-sdk/workorder` (`WorkOrderAPIApi`,
`OperationalContextApi`, `WorkexecTimeTrackingAPIApi`,
`TechnicianAssignmentAPIApi`, `WorkorderPickFacadeApi`,
`WorkorderPickedItemsApi`, `ChangeRequestAPIApi`, `WorkorderDetailApi`),
`@durion-sdk/invoice`, `@durion-sdk/accounting`, plus the raw
per-item completion endpoints
(`POST /workorder/v1/workorders/{id}/services/{itemId}/complete` and
`.../parts/{itemId}/complete`) exactly as `completeOutstandingWorkorderItems`
calls them today.

Scenario: one estimate with two labor lines and one part line (quantity such
that bootstrap stock of 50 covers it), promoted via builders.

- [ ] **C1 — Approve the workorder.** Signature payload as in the seeder.
  Assert approved status via `getWorkorderDetail`.
- [ ] **C2 — Start execution.** `operationalContextApi.startWorkorder`. Assert
  the detail status reflects execution start.
- [ ] **C3 — Timer lifecycle.** Honor the seeder's hard-won ordering
  constraint: **do not assign a technician before the timer loop** (stop
  targets the authenticated user; an assigned technician would strand the
  timer). For the first service item: `stopTimers` (tolerate no-active-timer),
  `startTimer` with `{workorderId, workorderItemId, laborCode}`, wait ≥1s of
  real time, `stopTimers`. Assert via the workorder labor/time-entry API that
  a labor entry exists for that item with duration > 0.
- [ ] **C4 — Timer conflict.** Start a timer, then `startTimer` again for the
  second item without stopping: assert 409. Recover exactly as the seeder
  does (stop, restart), then stop. Assert both items have labor entries.
- [ ] **C5 — Assign technician.** After the timer work, `assignTechnician`
  with a bootstrap technician id. Assert assignment visible on the detail or
  assignment endpoint.
- [ ] **C6 — Pick and consume the part.** `waitFor` `getPickTasks` to return a
  non-empty list (pick-list creation is asynchronous after promotion).
  `completePickTask` each, then `consumeWorkorderPickedItems` with
  picked/required quantities. Assert: subsequent `getPickTasks` shows
  completed/consumed state, and location availability for the SKU (Suite D's
  availability helper) decreased by the consumed quantity.
- [ ] **C7 — Change request.** `createChangeRequest` adding one service;
  `approveChangeRequest`. Assert the new service item appears on the
  workorder detail; run its timer + completion like the others.
- [ ] **C8 — Complete items, then the workorder.** POST the per-item complete
  endpoint for every service/part in a completable status
  (`OPEN`, `READY_TO_EXECUTE`, `IN_PROGRESS`); assert 200/204 per item. Then
  `completeWorkorder` with notes; assert completed status.
- [ ] **C9 — Invoice and payment.** `generateWorkorderInvoice` → assert
  `invoiceId`. `finalizeInvoice` → assert a numeric total consistent with the
  estimate lines plus the approved change request. Submit the
  `INVOICE_PAYMENT` accounting event (`sourceSystem: 'SDK_ITEST'`,
  `organizationId: locationId`, full amount); assert acceptance.
- [ ] **C10 — Execution negative.** On a fresh approved-but-unstarted
  workorder, `completeWorkorder` before items complete: assert the backend
  rejects it (record actual status/code). This pins the state machine the
  seeder only navigates around.

### Task 6: Suite D — Receiving

**File:** `src/suites/d-receiving.itest.ts`

SDK surface: `@durion-sdk/inventory` (`PurchaseOrdersApi`, `ASNApi`,
`ReceivingApi`, `BackordersApi`, `InventoryAvailabilityApi`, `PutawayApi`,
`PutawayExecutionApi`) and `@durion-sdk/catalog` for the new product. Vendor is
the bootstrap `SEED_VENDOR_ID`. Availability assertions use
`getAvailabilityBySku` at the bootstrap location, and always compare **deltas**
against a before-snapshot — the shared environment's absolute levels are
unknowable.

**Part 1 — receiving a brand-new product into stock:**

- [ ] **D1 — Create a new catalog product.** A runId-suffixed SKU/product via
  the catalog API (same shape as `CatalogBootstrap`). Assert entity id;
  snapshot availability (expect zero/absent).
- [ ] **D2 — Purchase order.** `createPurchaseOrder` for 25 units
  (`poDate: new Date()`, real now), runId in `comment`. Assert PO id and one
  line with a line id. `approvePurchaseOrder`; assert approved.
- [ ] **D3 — ASN and goods receipt.** `createAsn` referencing the PO and its
  line (`shipDate` now, `expectedArrivalDate` +3 real days — a future date is
  data, not a wait). `createGoodsReceipt` for the full 25 against the PO
  line. Assert receipt id; `getGoodsReceipt` round-trips.
- [ ] **D4 — Stock visible.** `waitFor` availability of the new SKU at the
  location to increase by 25 over the D1 snapshot.
- [ ] **D5 — Putaway (observed behavior).** `listPutawayTasks` for the
  receipt; if tasks exist, `claimPutawayTask` → `executePutaway` and assert
  completion. If the backend auto-putaways (no tasks), assert that and move
  on — the test documents which path this backend takes.
- [ ] **D6 — Receiving-session variant.** For a second small PO:
  `createReceivingSession` (`sourceDocumentId` = PO id),
  `receiveItemsIntoStaging` with its lines, `getReceivingSession` → assert
  session state and received quantities. This covers the staging-based
  receiving path the seeder never touches.

**Part 2 — receiving products for a specific workorder:**

- [ ] **D7 — Create a parts-shortage workorder.** New product (runId SKU-B)
  with **no stock**. Build an estimate with one labor line and one part line
  of SKU-B (qty 2); approve and promote. Assert the shortage is observable:
  either a backorder for SKU-B (`listBackorders` filtered by sku) or an
  unfulfillable pick task — record which signal this backend emits and assert
  it via `waitFor`.
- [ ] **D8 — Order and receive against the workorder.** PO + ASN for SKU-B
  (qty 2) as in D2–D3, then `createReceivingSession` +
  `receiveItemsIntoStaging` for the delivery.
- [ ] **D9 — Cross-dock to the workorder.** `crossDockReceivingLine` with
  `{ workorderId, workorderLineId, quantity: 2, notes: runId }` using the
  workorder part line id from D7. Assert the cross-dock response links the
  workorder.
- [ ] **D10 — Workorder can proceed.** `waitFor` the workorder's pick task
  for SKU-B to become completable; complete and consume it (as C6); assert
  the part item reaches a completable status and the backorder (if D7
  observed one) is closed.
- [ ] **D11 — Receiving negative.** `createGoodsReceipt` with a quantity
  exceeding the PO line (e.g. 999): assert rejection or documented
  over-receipt behavior; `crossDockReceivingLine` against a bogus workorder
  id: assert 4xx.

### Task 7: Laptop → Alpha Access Tunnel

The suite runs on the developer's laptop; only network reachability to alpha
is missing. Use AWS SSM Session Manager port forwarding — the control plane
alpha already uses for deploys — so no security-group ingress is opened and
nothing on alpha changes.

**Files:**

- Create: `scripts/alpha-itest-tunnel.ps1` (and `.sh` twin for non-Windows)
- Modify: `packages/sdk-integration-tests/README.md` (prerequisites section,
  Task 8)

Prerequisites on the laptop: AWS CLI v2, the Session Manager plugin, and an
AWS profile/role with `ssm:StartSession` on the alpha instance (the same
access already needed to operate alpha).

- [ ] **Step 1: Determine reachable forward targets.** The gateway and
  security service are containers on the Compose network; SSM forwards to
  ports reachable *from the EC2 host*. Confirm from
  `deployment/alpha/docker-compose.prod.yml` which host ports the gateway and
  security service publish. If the security service publishes no host port,
  either add a loopback-only publish (`127.0.0.1:8086:8080`) to the alpha
  Compose model, or use `AWS-StartPortForwardingSessionToRemoteHost` with the
  container's network alias resolved on the host. Record the chosen mechanism
  in the script header.
- [ ] **Step 2: Implement the tunnel script.** The script resolves the alpha
  instance id (tag lookup or `ALPHA_INSTANCE_ID` env), then opens two
  forwarding sessions: local `18080` → gateway, local `18086` → security
  service, and prints the matching `ITEST_*` exports. It must run both
  sessions concurrently, forward Ctrl-C to clean shutdown, and fail with a
  clear message when the SSM plugin is missing or the session is denied.
- [ ] **Step 3: Smoke-check the tunnel.** With the tunnel up, document and
  verify: `curl http://localhost:18080/actuator/health` (or the gateway's
  health path) returns healthy, and a login round-trip against
  `http://localhost:18086` succeeds. The tunnel carries JWTs and credentials
  over the SSM-encrypted channel; nothing is exposed publicly.
- [ ] **Step 4: Run the suite through the tunnel.** `npm run test:integration`
  with the printed exports completes against alpha; afterward, query one
  created record by runId (any suite's entity) through the API to confirm the
  records persisted in the alpha database.

Note: token lifetime must cover a full suite run; `SeederAuth.refreshIfNeeded`
already handles refresh — the harness reuses it between suites (the seeder
refreshes per virtual day for the same reason).

### Task 8: Documentation

**Files:**

- Create: `packages/sdk-integration-tests/README.md`
- Modify: root `README.md` (one section pointing at the new package)

- [ ] **Step 1: README.** Environment contract table, local and alpha run
  paths, the append-only data policy (records intentionally persist in the
  alpha database, found by runId), the timer-before-assignment constraint,
  the accelerated-profile guard, and the waitFor-not-sleep rule.
- [ ] **Step 2: Full verification.**

```bash
npm test            # unit suite still green, no itest files collected
npm run build       # workspace compiles including the new package
npm run test:integration   # against a local backend: all suites green
# then one tunneled run from the laptop against alpha: all suites green,
# records visible in the alpha database by runId
```

---

### Completion Criteria

- [ ] `packages/sdk-integration-tests` exists as a private workspace package;
      `npm test` (unit) and `npm run test:integration` are fully independent.
- [ ] Seeder fixtures (`SeederAuth`, bootstraps, `ReferenceCache`,
      `SeederRandom`, `SEED_VENDOR_ID`) are consumed as a library, not
      copy-pasted; the seeder's own entrypoint and image are unchanged.
- [ ] No test depends on virtual time: `/system/time` is touched only by the
      global-setup guard that aborts when alpha is mid-accelerated-run; no
      test waits for a clock boundary or uses an unbounded/fixed sleep; all
      asynchrony goes through `waitFor`.
- [ ] Suites A–D pass against a non-accelerated backend, covering:
      appointment lifecycle + idempotent appointment→estimate bridge;
      estimate draft→lines→totals→approve/decline→promote; workorder
      approve→start→timers (incl. 409 recovery)→assignment→pick/consume→
      change request→item completion→complete→invoice→payment; receiving of
      a new SKU (PO→ASN→receipt→availability delta→putaway) and
      workorder-directed receiving (shortage→receive→cross-dock→pick
      completable), each with at least one negative case.
- [ ] Every created entity is traceable to a run via the runId marker, and a
      completed alpha run's records are queryable in the alpha database.
- [ ] The full suite runs from a developer laptop against alpha through the
      SSM tunnel with no new public ingress on the alpha host.
- [ ] Credentials appear only in shell environment variables or a git-ignored
      env file; they are never committed, logged, or passed on a command line.
- [ ] Root Jest unit run, TypeScript build, and lint remain green.
