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
| `ITEST_USERNAME` | — | **Yes** | Admin login (SYSTEM_ADMINISTRATOR) — bootstrap and persona fallback |
| `ITEST_PASSWORD` | — | **Yes** | Admin password |
| `ITEST_ADVISOR_USERNAME` / `_PASSWORD` | _(admin fallback)_ | No | SERVICE_ADVISOR persona login |
| `ITEST_TECH_USERNAME` / `_PASSWORD` | _(admin fallback)_ | No | TECHNICIAN persona login |
| `ITEST_MANAGER_USERNAME` / `_PASSWORD` | _(admin fallback)_ | No | LOCATION_MANAGER persona login |
| `ITEST_PARTS_USERNAME` / `_PASSWORD` | _(admin fallback)_ | No | Custom `ITEST_PARTS_CLERK` role login (Task 8) |
| `ITEST_ACCT_USERNAME` / `_PASSWORD` | _(admin fallback)_ | No | ACCOUNT_MANAGER persona login |
| `ITEST_SEED` | _(random)_ | No | Integer RNG seed for reproducible data values |
| `ITEST_WAIT_TIMEOUT_MS` | `30000` | No | Default `waitFor` polling timeout |
| `ITEST_WAIT_INTERVAL_MS` | `500` | No | Default `waitFor` polling interval |

Persona credentials are optional as a set: define **all or none** per persona
(a username without its password fails config validation). See *Personas,
Roles, and Credentials* below for how the suite behaves in each mode.

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

### Personas, Roles, and Credentials

Each test step declares an **acting persona** — the role a real shop would use
for that action — and the harness executes the step with that persona's SDK
client.

The persona model below is **verified against the backend**
(`durion-positivity-backend`), not assumed. Ground truth:

- Roles are seeded by
  `pos-security-service/.../db/migration/R__seed_reference_security.sql`
  (canonical personas) and granted permissions by
  `R__seed_role_permissions.sql` — the SDK seeder's comment that
  `role_permissions` is unseeded is stale. The prose matrix lives at
  `pos-mcp-server/src/main/resources/rag/role-permission-matrix.md`, and
  `RolePermissionSeedIT` enforces the grants.
- There is **no** SERVICE_WRITER, MANAGER, or PARTS_CLERK security role. The
  real roles are SERVICE_ADVISOR, TECHNICIAN, LOCATION_MANAGER, DISPATCHER,
  ACCOUNT_MANAGER, ACCOUNTING_ASSOCIATE, INVENTORY_MANAGER/LEAD/CONTROLLER,
  ADMIN, SYSTEM_ADMINISTRATOR, and customer roles. (`PeopleBootstrap`'s
  SERVICE_WRITER/MANAGER/PARTS_CLERK labels are people-record job titles,
  unrelated to security roles.)
- Enforcement is `@PreAuthorize` with permission-string authorities (e.g.
  `workorder:estimate:approve`). A user's JWT carries the **union of the
  permissions of their roles** (`user_roles → role_permissions`), encoded as
  a `perm_bits` bitmap plus a `roles` claim (`ROLE_<NAME>`); there is no
  per-user permission path. The gateway strips inbound identity headers and
  re-injects them from the verified JWT, so authorities cannot be spoofed
  through it. `pos-catalog` alone checks role-name authorities
  (`ROLE_ADMIN`, `ROLE_CATALOG_EDIT`/`_VIEW`) instead of permissions.
- `SYSTEM_ADMINISTRATOR` is deliberately **not** a superuser in the seed
  (34 grants). It only works as "can do everything" on alpha because the
  seeder's `SecurityBootstrap` grants it the full permission catalog at
  runtime — the suite's `admin` persona relies on that same bootstrap.

Six personas, mapped to real roles (role UUIDs from
`R__seed_reference_security.sql`):

| Persona | Security role | Role UUID | Used for |
| --- | --- | --- | --- |
| `admin` | `SYSTEM_ADMINISTRATOR` (+ full catalog via bootstrap) | `e9b3e6ba-af10-08ff-0376-1f2fa60d5093` | Global setup, persona provisioning, and **fixture** creation the seeded roles cannot do: CRM customers/vehicles (`crm:party:create`/`crm:vehicle:create` are ADMIN-only in the seed) and catalog products (`ROLE_ADMIN`) |
| `advisor` | `SERVICE_ADVISOR` | `f5e58579-e9de-574d-c2c5-56d3fd7e93f6` | Appointments (`appointments:*`), full estimate lifecycle (`workorder:estimate:*`), change-request creation, invoice generation + finalization (`workorder:workorder:generate_invoice`, `invoice:finalize`) |
| `tech` | `TECHNICIAN` | `190cbafe-4c1b-7e5f-768f-4b3c0d58a165` | Execution: `workorder:start`, timers (`workorder:labor:add`), picks (`inventory:pick_list:view`/`execute`), consumption (`workorder:parts:consume`) |
| `manager` | `LOCATION_MANAGER` | `783422f6-84ab-f590-5d51-4fa87b06d679` | Workorder approval, technician assignment (`workorder:workorder:assign-technician`), change-request approval, item + workorder completion (`workorder:workorder:complete`), runtime-granted `order:purchase_order:approve` |
| `parts` | custom `ITEST_PARTS_CLERK` (created by Task 8) | _(created at runtime)_ | POs, ASNs, receiving sessions, goods receipts, cross-dock, putaway, backorder/availability views — **no seeded role holds these**: the whole receiving permission family is ADMIN-only in the seed and `order:purchase_order:*` is granted to no role at all |
| `acct` | `ACCOUNT_MANAGER` | `a781f7c1-e2aa-6ebb-7096-b53ac3575c92` | `accounting:events:submit` for the invoice-payment event (ADMIN and ACCOUNT_MANAGER are the only holders) |

The suite runs in one of two modes, decided by config at startup:

- **Single-credential mode** (only `ITEST_USERNAME`/`ITEST_PASSWORD` set):
  every persona resolves to the admin login. This validates the functional
  flows only — it proves nothing about authorization. All A–D functional
  tests must pass in this mode; role-enforcement tests are skipped with an
  explicit "single-credential mode" skip reason.
- **Role mode** (persona credentials set): each persona logs in separately in
  global setup (one `SeederAuth` per persona, token refresh handled per
  persona), functional steps run as their declared persona, and the
  role-enforcement negatives (below) are enabled.

Design rules:

- The harness exposes `clients.as('advisor').workorder…` etc.; suite code
  never constructs an SDK client from raw credentials. Every builder takes
  the acting persona as its first argument so the declaration is visible at
  the call site and greppable.
- **Timer identity:** the workexec timer API attributes `startTimer` /
  `stopTimers` to the *authenticated user*. In role mode the `tech` persona
  must be the same identity for start and stop, and technician assignment
  still happens only after the timer loop (suite C rule). Running timers as a
  real technician login removes the seeder's admin-fallback workaround — a
  correctness gain worth asserting: the resulting labor entry must belong to
  the tech persona's user.
- **Role-enforcement negatives** (role mode only), using
  `expectHttpError(…, 403)` and recording the actual status the backend
  returns. Each is guaranteed meaningful by the seeded grants — the acting
  persona verifiably lacks the required authority:
  - A: `tech` attempts `createAppointment` → rejected (TECHNICIAN holds
    neither `appointments:create` nor `shop:schedule:edit`).
  - B: `tech` attempts `approveEstimate` → rejected (no
    `workorder:estimate:approve`).
  - C: `tech` attempts `completeWorkorder` → rejected (only SERVICE_ADVISOR,
    LOCATION_MANAGER, ADMIN hold `workorder:workorder:complete`); and
    `advisor` attempts `startTimer` → rejected (no `workorder:labor:add` —
    labor is the technician's domain).
  - D: `tech` attempts `approvePurchaseOrder` → rejected
    (`order:purchase_order:approve` is granted to no seeded role).
- **Known authorization gaps** (verified in backend code) where a negative
  test is impossible or must be written as gap documentation instead:
  - `POST /v1/workorders/estimates/from-appointment`,
    `POST /v1/workorders` (createWorkorder), `DELETE /v1/workorders/{id}`,
    and `GET /v1/workorders/{id}/detail` are `isAuthenticated()`-only — any
    logged-in user passes. Suite A's bridge test therefore asserts function,
    not authorization, and a `test.failing`-style gap test documents each.
  - `getWorkorderDetail` filters **response fields** by authority instead of
    rejecting: financial fields (`estimatedTotal`, `laborTotal`,
    `partsTotal`) are omitted for callers without the pricing authorities.
    Role mode asserts the split: `advisor` sees financials, `tech` gets a
    200 without them.
  - `POST /v1/products` (createProduct) requires only `ROLE_ADMIN` **or**
    `ROLE_CATALOG_VIEW` — a view role gating a create operation. Documented
    as a gap; product-creation fixtures run as `admin`.
  - `crm:party:create` / `crm:vehicle:create` are ADMIN-only in the seed, so
    a service advisor cannot onboard a customer — likely a seed gap. Until
    the seed changes, customer/vehicle creation is an `admin` **fixture**
    step in every suite, never an `advisor` action.
- Provisioning the persona logins is Task 8. Until it lands, alpha runs use
  single-credential mode with the existing seeder/admin account, so nothing
  blocks the functional suites.

The endpoint→permission mapping used above is recorded per suite in the
suite sections and was read directly from the backend controllers
(`@PreAuthorize` annotations); `pos-inventory/.../InventoryPermissionRegistry.java`,
`pos-workorder/.../WorkorderPermissions.java`,
`pos-shop-manager/.../ShopPermissions.java`, and
`pos-order/.../PurchaseOrderPermissions.java` are the constant sources.

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
2. `SeederAuth.login()` for the admin, then one login per configured persona
   (role mode); missing-persona fallback to admin is resolved here, once.
3. `BootstrapOrchestrator.run()` — returns the `ReferenceCache`
   (locationId, employee ids by role, service/product entity ids and names).
4. Serialize `{ referenceCache, tokenPairsByPersona, runId, mode }` to a JSON
   file in the OS temp dir; test files rehydrate it in `beforeAll` (Jest
   globalSetup runs in a separate process, so context must cross via disk).

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
in one error; defaults applied; non-integer timeout rejected; a persona
username without its password (or vice versa) rejected; mode resolution
(single-credential vs. role) reported on the parsed config. `waitFor`:
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
- `personas.ts` — the persona→client registry: one `SeederAuth` per
  configured persona (admin fallback in single-credential mode), exposing
  `clients.as(persona)` with lazily created SDK clients per domain, plus
  `isRoleMode()` for the enforcement tests' skip logic.
- `builders.ts` — thin, assertive wrappers returning ids or throwing, each
  taking the acting persona as its first argument:
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

**Acting personas:** `admin` creates the customer/vehicle fixtures; `advisor`
(SERVICE_ADVISOR) performs every functional step. Required authorities per
step (all held by SERVICE_ADVISOR): A1 `appointments:create` OR
`shop:schedule:edit`; A2 `appointments:view` OR `shop:schedule:view`; A3
`appointments:reschedule`; A4 `appointments:cancel`; A5 none — the bridge
endpoint is `isAuthenticated()`-only (documented gap). Role-mode negative:
`tech` attempts A1's `createAppointment` → rejected.

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

**Acting personas:** `admin` creates the customer/vehicle fixtures; `advisor`
(SERVICE_ADVISOR) performs every functional step — the estimate is a
front-desk document, and approve/decline records the *customer's* signature
captured by the advisor. Required authorities (all held by SERVICE_ADVISOR):
`workorder:estimate:create`, `workorder:estimate_item:add`,
`workorder:estimate:calculate`, `workorder:estimate:submit`,
`workorder:estimate:approve`, `workorder:estimate:decline`,
`workorder:estimate:promote`; B7's detail read is authenticated-only.
Role-mode negative: `tech` attempts B5's `approveEstimate` → rejected.

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

**Acting personas** (matching the seeded grants exactly): `manager`
(LOCATION_MANAGER) approves the workorder (C1, `workorder:workorder:approve`),
assigns the technician (C5, `workorder:workorder:assign-technician` — held by
LOCATION_MANAGER and DISPATCHER, **not** SERVICE_ADVISOR), approves the
change request (C7, `workorder:change_request:approve`), and completes items
and the workorder (C8 — the per-item complete endpoints and
`completeWorkorder` all require `workorder:workorder:complete`, which
TECHNICIAN does **not** hold: techs execute, managers/advisors close). `tech`
(TECHNICIAN) executes: start (C2, `workorder:start`), timers (C3/C4,
`workorder:labor:add`; start also accepts `workorder:labor:add_on_behalf`),
picks and consumption (C6, `inventory:pick_list:view`/`execute`,
`workorder:parts:consume`). `advisor` authors the change request (C7,
`workorder:change_request:create`) and generates + finalizes the invoice (C9,
`workorder:workorder:generate_invoice`, then `invoice:finalize` — note
`invoice:finalize` alone suffices; the class-level `invoice:manage` does not
apply to finalize). `acct` (ACCOUNT_MANAGER) submits the payment event (C9,
`accounting:events:submit`). In role mode the labor entries from C3/C4 must
be attributed to the `tech` user. Role-mode negatives: `tech` attempts
`completeWorkorder` → rejected; `advisor` attempts `startTimer` → rejected.

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

**Acting personas:** `admin` creates the new catalog products (D1, D7 —
`createProduct` checks `ROLE_ADMIN`/`ROLE_CATALOG_VIEW` role authorities, and
no CATALOG_* role is seeded); `parts` (custom `ITEST_PARTS_CLERK`, Task 8)
runs the supply chain — PO creation (`order:purchase_order:create` — note the
`order:` namespace, PO endpoints live in pos-order, and **no seeded role
holds any `order:purchase_order:*` permission**), ASNs
(`inventory:asn:create`/`view`), goods receipts
(`inventory:goods_receipt:create`/`view`), receiving sessions
(`inventory:receiving:create`/`complete`/`view`), cross-dock (D9 — requires
`inventory:receiving:complete` **AND** `inventory:issue:parts`, the only
conjunctive check in the suites), putaway (`inventory:putaway:view`/
`generate`/`claim`/`execute`), backorders (`inventory:shortage:view`), and
availability (`inventory:on_hand:view`); `manager` approves the PO (D2, via
runtime-granted `order:purchase_order:approve`, preserving create/approve
separation of duties); `advisor` builds the shortage estimate (D7); `tech`
completes the unblocked pick (D10). Role-mode negative: `tech` attempts D2's
`approvePurchaseOrder` → rejected.

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
  Task 9)

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

### Task 8: Provision Persona Accounts (enables role mode)

Alpha (and local Compose) currently has only the admin login. Persona logins
must exist as real security-service users with the right roles before role
mode can run. All mechanics below are verified against the backend's
`pos-security-service` controllers.

Provisioning API surface (all called with the admin token, whose
bootstrap-granted catalog includes the needed `security:*` authorities):

| Operation | Endpoint | Required authority |
| --- | --- | --- |
| Create user | `POST /v1/users` | `security:user:create` |
| Assign role to user | `PUT /v1/users/{userId}/roles/{roleId}` | `security:role:assign` |
| Create role | `POST /v1/roles` | `security:role:create` |
| Grant one permission to role | `PUT /v1/roles/{roleId}/permissions/{permissionKey}` | `security:role:edit` |
| Read a user's effective permissions | `GET /v1/users/{userId}/permissions` | `security:permission:view` |

(Note: role-grant endpoints are `PUT`, matching what `SecurityBootstrap`
already uses.)

**Files:**

- Create: `packages/sdk-integration-tests/src/harness/PersonaBootstrap.ts`
- Modify: `src/harness/globalSetup.ts` (invoke when role mode is configured)
- Test: unit tests for the idempotency logic (mocked HTTP)

- [ ] **Step 1: Assign the seeded roles.** For `advisor`, `tech`, `manager`,
  and `acct`: find-or-create the user with the configured credentials, then
  assign the seeded role by its pinned UUID (SERVICE_ADVISOR
  `f5e58579-…`, TECHNICIAN `190cbafe-…`, LOCATION_MANAGER `783422f6-…`,
  ACCOUNT_MANAGER `a781f7c1-…` — full values in the persona table). These
  roles already carry their permission sets from `R__seed_role_permissions.sql`;
  do **not** grant them anything extra.
- [ ] **Step 2: Create the two test-owned roles.** Never mutate canonical
  roles on a shared environment; add test-owned roles instead:
  - `ITEST_PARTS_CLERK`, granted exactly: `order:purchase_order:create`,
    `inventory:asn:create`, `inventory:asn:view`,
    `inventory:goods_receipt:create`, `inventory:goods_receipt:view`,
    `inventory:receiving:create`, `inventory:receiving:complete`,
    `inventory:receiving:view`, `inventory:issue:parts`,
    `inventory:shortage:view`, `inventory:on_hand:view`,
    `inventory:putaway:view`, `inventory:putaway:generate`,
    `inventory:putaway:claim`, `inventory:putaway:execute`. Assigned to the
    `parts` user.
  - `ITEST_PO_APPROVER`, granted exactly `order:purchase_order:approve`.
    Assigned to the `manager` user **in addition to** LOCATION_MANAGER, so
    PO approval works without editing the canonical role.
  Grant only permission strings that exist in the seeded catalog: the JWT
  `perm_bits` bitmap encodes only permissions present in the backend's
  `PermissionCode` enum — an invented permission row is silently dropped
  from tokens, so it can never work.
- [ ] **Step 3: Verify effective permissions.** After provisioning, read
  `GET /v1/users/{userId}/permissions` for each persona and assert the
  expected authority set — this catches a partially-applied grant before any
  suite runs, with a far clearer failure than a scattered 403.
- [ ] **Step 4: Link personas to people records.** Where the backend supports
  it, associate each persona user with the matching `PeopleBootstrap`
  employee (e.g. the tech login ↔ a TECHNICIAN employee id; the `users`
  table has a `person_id` column) so labor attribution and assignment views
  line up. If no linkage API exists, record that as a known limitation next
  to the affected C-suite assertions.
- [ ] **Step 5: Idempotency and hygiene.** Re-runs are no-ops (find before
  create; assign/grant endpoints tolerate already-present state). Passwords
  come only from the `ITEST_*` variables — never generated, logged, or
  stored. Test-owned roles are created once and reused across runs.
- [ ] **Step 6: Verify role mode end-to-end.** With persona credentials set,
  global setup logs in all personas; suites A–D pass with per-persona
  execution; the role-enforcement negatives run (passing or as documented
  `test.failing` gaps).

### Task 9: Documentation

**Files:**

- Create: `packages/sdk-integration-tests/README.md`
- Modify: root `README.md` (one section pointing at the new package)

- [ ] **Step 1: README.** Environment contract table (including the persona
  credential variables and the two run modes), the persona/role matrix,
  local and alpha run paths, the append-only data policy (records
  intentionally persist in the alpha database, found by runId), the
  timer-before-assignment constraint, the accelerated-profile guard, and the
  waitFor-not-sleep rule.
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
- [ ] Every test step declares its acting persona; the suite passes in
      single-credential mode, and in role mode each persona acts under its
      own login with the role-enforcement negatives running (passing or
      recorded as documented gaps).
- [ ] Credentials appear only in shell environment variables or a git-ignored
      env file; they are never committed, logged, or passed on a command line.
- [ ] Root Jest unit run, TypeScript build, and lint remain green.
