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
| `ITEST_PARTS_USERNAME` / `_PASSWORD` | _(admin fallback)_ | No | INVENTORY_LEAD persona login |
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
never printed, never committed. The file half is implemented by
`src/harness/loadEnvFile.ts` (dependency-free; `.env.itest` is read from the
repo root, or from `ITEST_ENV_FILE` when set). Real environment variables
always win over the file, so CI and one-off `VAR=x npm run ...` overrides are
unaffected; only the names of applied keys are logged, never the values.
`.env.itest.example` at the repo root is the template. When `ITEST_USERNAME`/`ITEST_PASSWORD` are
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
(`durion-positivity-backend` at commit `8536683`, which includes PR #1436's
authorization-enforcement fixes for #1432–#1435 and PR #1441's
procure-to-pay seed fixes for #1438–#1440), not assumed. Ground truth:

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
| `admin` | `SYSTEM_ADMINISTRATOR` (+ full catalog via bootstrap) | `e9b3e6ba-af10-08ff-0376-1f2fa60d5093` | Global setup, persona provisioning, and **fixture** creation the seeded roles cannot do: CRM vehicles (`crm:vehicle:create` is still ADMIN-only) and catalog products (`ROLE_ADMIN`) |
| `advisor` | `SERVICE_ADVISOR` | `f5e58579-e9de-574d-c2c5-56d3fd7e93f6` | Customer onboarding (`crm:party:create`, `crm:person:create` — granted by #1435), appointments (`appointments:*`), full estimate lifecycle (`workorder:estimate:*`) including the from-appointment bridge, change-request creation, invoice generation + finalization (`workorder:workorder:generate_invoice`, `invoice:finalize`) |
| `tech` | `TECHNICIAN` | `190cbafe-4c1b-7e5f-768f-4b3c0d58a165` | Execution: `workorder:start`, timers (`workorder:labor:add`), picks (`inventory:pick_list:view`/`execute`), consumption (`workorder:parts:consume`) |
| `manager` | `LOCATION_MANAGER` | `783422f6-84ab-f590-5d51-4fa87b06d679` | Workorder approval, technician assignment (`workorder:workorder:assign-technician`), change-request approval, item + workorder completion (`workorder:workorder:complete`), PO approval (`order:purchase_order:approve`/`transmit`, seeded by #1438 to ADMIN, LOCATION_MANAGER, INVENTORY_MANAGER) |
| `parts` | `INVENTORY_LEAD` | `1320fc87-5bec-5584-8d56-3494d66e8fd9` (see note below) | The parts clerk **is the lowest inventory role** (family: INVENTORY_LEAD, create adjustment requests < INVENTORY_MANAGER, create + approve location-scoped < INVENTORY_CONTROLLER, global approval + negative-stock override) and since #1439 it is the seeded **parts-receiving persona**: ASNs (`inventory:asn:create/view`), receiving sessions (`inventory:receiving:create/complete/view`), goods receipts (`inventory:goods_receipt:create/view`), cross-dock issue (`inventory:issue:parts`), putaway (`inventory:putaway:view/generate/claim/execute`), shortages (`inventory:shortage:view/resolve`), on-hand (`inventory:on_hand:view/search`), and PO authoring (`order:purchase_order:create/view/availability_view`). The elevated escape hatches (`goods_receipt:override`, putaway capacity/compatibility overrides) are deliberately excluded |
| `acct` | `ACCOUNT_MANAGER` | `a781f7c1-e2aa-6ebb-7096-b53ac3575c92` | `accounting:events:submit` for the invoice-payment event (ADMIN and ACCOUNT_MANAGER are the only holders) |

**Role UUID caveat:** since #1440, SQL migrations are the single source of
role creation (the `RoleInitializer` bean is deleted) and every role above
has a pinned UUID — the five formerly initializer-created roles
(GENERAL_MANAGER, INVENTORY_CONTROLLER, INVENTORY_LEAD, INVENTORY_MANAGER,
MANAGER) now use UUIDv5 of `durion-positivity://roles/<NAME>`. But the seed
inserts with `ON CONFLICT (name) DO NOTHING`, so a database populated
**before** #1440 — alpha included — keeps the originally *generated* ids for
those five. Provisioning must therefore resolve roles **by name** from the
roles listing and treat the pinned UUIDs as fresh-database values only.

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
- **Closed gaps — now positive authorization surface** (fixed by backend
  PR #1436, #1432–#1435; earlier revisions of this spec listed them as
  gaps). The suites assert the new enforcement:
  - `POST /v1/workorders/estimates/from-appointment` now requires
    `workorder:estimate:create` — the A5 bridge runs as `advisor` and gains
    a negative: `tech` attempts it → rejected.
  - `POST /v1/workorders` requires `workorder:workorder:create` (advisor,
    manager); `DELETE /v1/workorders/{id}` requires
    `workorder:workorder:delete` — held by the manager tier only (ADMIN,
    GENERAL_MANAGER, LOCATION_MANAGER, MANAGER, SHOP_MANAGER), deliberately
    **not** SERVICE_ADVISOR: advisors create workorders but cannot destroy
    them. Worth a role-mode negative: `advisor` attempts delete → rejected
    (the suites never delete data, so this negative targets a runId-tagged
    throwaway workorder and must expect 403, not perform a delete).
  - `crm:party:create`, `crm:party:search/view`, `crm:person:create/read`
    are now granted to SERVICE_ADVISOR (#1435), so **customer onboarding is
    an `advisor` action**. Party edit/deactivate/merge stay
    manager-and-above by design.
  - `POST /v1/products` now requires `ROLE_ADMIN` or `ROLE_CATALOG_EDIT`
    (the view-role bug is fixed). Still role-name-based, and no CATALOG_*
    role is seeded, so product fixtures stay on `admin`.
  - The receiving family and purchase-order authoring are now seeded to
    INVENTORY_LEAD, and `order:purchase_order:approve`/`transmit` to
    LOCATION_MANAGER and INVENTORY_MANAGER (#1438/#1439) — the supplemental
    test-owned roles earlier revisions of this spec required are gone.
    Suite D runs on seeded grants alone, and gains the separation-of-duties
    negative: the PO's **creator** (`parts`) cannot approve it.
- **Remaining authorization gaps** (still true at commit `7250344`):
  - `getWorkorderDetail` remains `isAuthenticated()`-only and filters
    **response fields** by authority instead of rejecting: financial fields
    (`estimatedTotal`, `laborTotal`, `partsTotal`) are omitted for callers
    without the pricing authorities. Role mode asserts the split: `advisor`
    sees financials, `tech` gets a 200 without them.
  - `crm:vehicle:create` is still ADMIN-only, so vehicle registration is an
    `admin` **fixture** step in every suite (the advisor can only
    search/view vehicles).
  - The legacy `inventory:purchase_order:*` permission family remains
    seeded (ADMIN-only) although no controller enforces it — pos-order
    enforces `order:purchase_order:*`. Harmless to the suites, but never
    grant from the legacy family; its retirement is tracked on backend
    #1438.
- Alpha already carries seeded operational accounts for every persona
  except `parts` (`R__seed_security_operational_data.sql` — see Task 8 for
  the persona → username mapping), so role mode works immediately for
  `advisor`/`tech`/`manager`/`acct` by pointing the `ITEST_<PERSONA>_*`
  variables at those accounts. The `parts` persona needs Task 8's single
  INVENTORY_LEAD role assignment first; until then leave `ITEST_PARTS_*`
  unset (admin fallback). Single-credential mode with the admin account
  remains the zero-setup path.

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

- [x] **Step 1: Write a failing import test**

A unit test importing `SeederAuth`, `SeederConfig`, `SecurityBootstrap`,
`BootstrapOrchestrator`, `ReferenceCache`, and `SeederRandom` from the package
root and asserting they are constructible types. Run with `npm test`.

- [x] **Step 2: Add the barrel and package exports**

`lib.ts` re-exports the classes above plus the `SEED_VENDOR_ID` constant from
`bootstrap/InventoryBootstrap`. Do not move `index.ts`; the `seed` script keeps
running it directly. Keep the seeder's Docker image and CI behavior unchanged.

Implementation note: because `index.ts` starts a seeder run on import, both
resolution layers must point `@durion-sdk/seeder` at the barrel — the root
jest `moduleNameMapper` (runtime) **and** the root tsconfig `paths`
(ts-jest's type checker). Both specific entries precede the generic
`@durion-sdk/*` rules.

- [x] **Step 3: Decouple config construction from `process.env` naming**

`SeederConfig.fromEnv()` reads `SEEDER_*` names. Add a
`SeederConfig.fromValues(shape)` factory so the integration harness can map
`ITEST_*` variables onto it without fake env mutation. Validation rules stay in
one place.

- [x] **Step 4: Verify**

```bash
npm test -- --runInBand packages/sdk-seeder
npm run build
```

Expected: Jest and TypeScript compilation pass; seeder image build unaffected.

Verified: the seeder suite passes (10 tests) and the change introduces no new
failures — the full `npm test` / `npm run build` runs carry 21 test failures
and 4 compile errors that pre-date this task on the branch (stale
`src/__tests__` expectations against the regenerated SDK surface), identical
before and after.

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

- [x] **Step 1: Write failing unit tests for the harness primitives**

`ItestConfig`: required-variable failure message names every missing variable
in one error; defaults applied; non-integer timeout rejected; a persona
username without its password (or vice versa) rejected; mode resolution
(single-credential vs. role) reported on the parsed config. `waitFor`:
resolves on first truthy predicate result, polls at the configured interval,
rejects with the last predicate error (not a generic timeout) after the
deadline, never overlaps in-flight predicate calls.

- [x] **Step 2: Implement the harness**

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

- [x] **Step 3: Wire global setup and context rehydration**

Implement serialization as described in *Fixtures* above. Global setup failures
must print the failing bootstrap stage and the formatted HTTP error.

Implementation notes (deviations from the draft, chosen during Task 2):

- The context file carries `{runId, mode, referenceCache}` only — **no
  tokens**. Suites log their personas in via `Personas.login()` in
  `beforeAll` instead of rehydrating serialized token pairs: `SeederAuth`
  keeps token state private, and keeping credential material out of temp
  files is the better trade anyway.
- Jest does not apply `moduleNameMapper` to `globalSetup`, so its require
  chain resolves `@durion-sdk/*` through real `node_modules` dists. Local
  prerequisite after install (same ordering the seeder Dockerfile uses):
  `npm run build -w packages/sdk-transport && npm run build --workspaces
  --if-present`.
- `suites/00-harness.itest.ts` is a permanent smoke suite: it validates the
  context → login plumbing against a real backend and guarantees at least
  one itest exists, so `npm run test:integration` always executes
  globalSetup — where the credential fail-fast and the accelerated-profile
  guard live (with zero matching tests jest would skip globalSetup
  entirely).
- sdk-shop-manager ships no `create*Client` factory, so the harness carries
  `shopManagerClient.ts`, mirroring the generated factory pattern for the
  appointments API.

- [x] **Step 4: Verify offline behavior**

```bash
npm test            # unit run: harness unit tests pass, no *.itest.ts collected
npm run build
npm run test:integration   # without credentials: fails fast with the single clear message
```

Verified: 15 harness unit tests pass in the unit run with no itest files
collected; `npm run test:integration` without credentials exits 1 with the
single configuration error, and with credentials but no reachable backend
exits with a clear reachability message. The workspace dists build cleanly
in dependency order (the branch's pre-existing failures are confined to
root `src/__tests__`).

### Task 3: Suite A — Appointments

**File:** `src/suites/a-appointments.itest.ts`

SDK surface: `@durion-sdk/shop-manager` `AppointmentsAPIApi`
(`createAppointment`, `getAppointmentById`, `rescheduleAppointment`,
`cancelAppointment`) and `@durion-sdk/workorder` `EstimatesFromAppointmentsApi`
(`createEstimateFromAppointment`). Appointment windows use real near-future
times — valid on a normal clock, no waiting. Slots are drawn at random from the
coming months rather than fixed to tomorrow: alpha keeps every appointment any
previous run booked, and the backend refuses a double-booking with
`400 VALIDATION_ERROR: Requested slot is already booked`. A wider range lowers
the odds of a clash but cannot remove them, so a clash is answered by booking
somewhere else (see A1).

**Acting personas:** `advisor` (SERVICE_ADVISOR) onboards the customer
(`crm:party:create`) and performs every functional step; `admin` registers
the vehicle fixture (`crm:vehicle:create` is still ADMIN-only). Required
authorities per step (all held by SERVICE_ADVISOR): A1 `appointments:create`
OR `shop:schedule:edit`; A2 `appointments:view` OR `shop:schedule:view`; A3
`appointments:reschedule`; A4 `appointments:cancel`; A5
`workorder:estimate:create` (enforced since #1436). Role-mode negatives:
`tech` attempts A1's `createAppointment` → rejected; `tech` attempts A5's
bridge → rejected (no `workorder:estimate:create`).

- [x] **A1 — Book an appointment.** Create a fresh person account + vehicle via
  builders. `createAppointment` with `crmCustomerId`, `crmVehicleId`,
  `locationId`, a randomly chosen free `startAt`/`endAt`, `serviceRequestIds`
  drawn from bootstrap service entity ids. A slot already taken is retried in a
  different one — that refusal is about the slot, not the request. Assert: id returned, echoed fields match, and
  status is the backend's initial state (capture actual value; assert
  non-cancelled).
- [x] **A2 — Fetch by id.** `getAppointmentById` returns the same appointment;
  round-trips the schedule window.
- [x] **A3 — Reschedule.** Move the window one hour later **than the slot A1
  actually got**, which is not necessarily the one it first asked for. Assert
  the response reflects the new window; re-fetch confirms persistence. A move
  into an occupied hour is retried further out, as booking is.
- [x] **A4 — Cancel.** `cancelAppointment` with a reason. Assert cancelled
  status. Then assert `rescheduleAppointment` on the cancelled appointment is
  rejected via `expectHttpError` (record the actual 4xx the backend uses).
- [x] **A5 — Appointment → estimate bridge (idempotent).** On a second, active
  appointment: `createEstimateFromAppointment` with a fresh UUID
  `idempotencyKey` — the field is a plain string in the generated client but a
  UUID on the backend, which rejects anything else with a bare 400, so a
  runId-derived key cannot be used. Assert `created === true` and an
  `estimateId`. Call again: assert `created === false` and the **same**
  `estimateId`.
  The returned estimate must be fetchable through `EstimateAPIApi` and carry
  the appointment's customer/vehicle.
- [x] **A6 — Validation negative.** `createAppointment` with `endAt` before
  `startAt` is rejected with a 4xx and no appointment is created.

### Task 4: Suite B — Estimates

**File:** `src/suites/b-estimates.itest.ts`

SDK surface: `@durion-sdk/workorder` `EstimateAPIApi`. Sequences mirror
`CustomerEventSimulator.simulate` steps `createEstimate` through
`customerDecision`, with assertions replacing tolerant logging.

**Acting personas:** `advisor` (SERVICE_ADVISOR) creates the customer
(`crm:party:create`) and performs every functional step — the estimate is a
front-desk document, and approve/decline records the *customer's* signature
captured by the advisor; `admin` registers the vehicle fixture
(`crm:vehicle:create` is ADMIN-only). Required authorities (all held by
SERVICE_ADVISOR):
`workorder:estimate:create`, `workorder:estimate_item:add`,
`workorder:estimate:calculate`, `workorder:estimate:submit`,
`workorder:estimate:approve`, `workorder:estimate:decline`,
`workorder:estimate:promote`; B7's detail read is authenticated-only.
Role-mode negative: `tech` attempts B5's `approveEstimate` → rejected.

- [x] **B1 — Create a draft estimate.** For a fresh party/vehicle:
  `createEstimate` with the seeder's field shape (`customerId`, `vehicleId`,
  `crmPartyId`, `crmVehicleId`, `crmContactIds: []`, `currencyUomId: 'USD'`,
  `locationId`). Assert an estimate id.
- [x] **B2 — Add labor and part lines.** Two labor lines
  (`itemType: Labor`, `serviceId`, qty 1, known unit prices) and one part line
  (`itemType: Part`, `productId`, qty 2, known unit price). Assert each line
  returns an id.
- [x] **B3 — Totals.** `calculateEstimateTotals`; assert the computed total
  equals the arithmetic sum of the lines added in B2 (exact expected value —
  prices are chosen by the test, not random here). Record and assert tax
  handling as observed (document actual behavior in the test).
- [x] **B4 — Submit for approval.** Assert resulting status transition.
- [x] **B5 — Approve with signature.** `approveEstimate` with signature
  payload (base64 data, signer name, `image/png`). Assert approved status.
- [x] **B6 — Decline path.** On a second estimate: submit, then
  `declineEstimate` with a reason. Assert declined status, and assert
  `promoteEstimate` on the declined estimate is rejected (4xx).
- [x] **B7 — Promote.** Promote the approved estimate. Assert a workorder id,
  and that `getWorkorderDetail` lists one workorder service item per B2 labor
  line with matching `serviceEntityId`, and the part line present with its
  quantity.
- [x] **B8 — Lifecycle negative.** `approveEstimate` on the already-promoted
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

- [x] **C1 — Approve the workorder.** Signature payload as in the seeder.
  Assert approved status via `getWorkorderDetail`.
- [x] **C2 — Start execution.** `operationalContextApi.startWorkorder`. Assert
  the detail status reflects execution start.
- [x] **C3 — Timer lifecycle.** Honor the seeder's hard-won ordering
  constraint: **do not assign a technician before the timer loop** (stop
  targets the authenticated user; an assigned technician would strand the
  timer). For the first service item: `stopTimers` (tolerate no-active-timer),
  `startTimer` with `{workorderId, workorderItemId, laborCode}`, wait ≥1s of
  real time, `stopTimers`. Assert via the workorder labor/time-entry API that
  a labor entry exists for that item with duration > 0.
- [x] **C4 — Timer conflict.** Start a timer, then `startTimer` again for the
  second item without stopping: assert 409. Recover exactly as the seeder
  does (stop, restart), then stop. Assert both items have labor entries.
- [x] **C5 — Assign technician.** After the timer work, `assignTechnician`
  with a bootstrap technician id. Assert assignment visible on the detail or
  assignment endpoint.
- [x] **C6 — Request a pick list; tasks need a reservation.** Written to expect
  promotion to produce pickable tasks; alpha does not. `getPickTasks` answers
  404 until a pick list is requested from inventory
  (`POST /v1/inventory/pick-lists`, with `priority` supplied — it is optional in
  the spec but a primitive `int` on the backend). Releasing that list moves it
  to `READY_TO_PICK` holding **zero tasks**, because tasks come from a
  reservation, which `CreatePickListRequest` carries an id for. The step asserts
  that sequence and that stock did not move, so the day tasks do appear the test
  fails and says so. Consumption and the availability delta wait on the
  reservation path.

  The part must also be one the shop holds: only ten of the thirty bootstrap
  products were ever received, and a workorder for an unstocked part can never
  be picked. The suite selects a stocked one.
- [x] **C7 — Change request.** `createChangeRequest` adding one service;
  `approveChangeRequest`. Assert the new service item appears on the
  workorder detail; run its timer + completion like the others.
- [x] **C8 — Complete items, then the workorder.** POST the per-item complete
  endpoint for every service/part in a completable status
  (`OPEN`, `READY_TO_EXECUTE`, `IN_PROGRESS`); assert 200/204 per item. Then
  `completeWorkorder` with notes; assert completed status.
- [x] **C9 — Invoice and payment.** `generateWorkorderInvoice` → assert
  `invoiceId`. `finalizeInvoice` → assert a numeric total consistent with the
  estimate lines plus the approved change request. Submit the
  `INVOICE_PAYMENT` accounting event (`sourceSystem: 'SDK_ITEST'`,
  `organizationId: locationId`, full amount); assert acceptance.
- [x] **C10 — Execution negative.** On a fresh approved-but-unstarted
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
`createProduct` checks `ROLE_ADMIN`/`ROLE_CATALOG_EDIT` role authorities, and
no CATALOG_* role is seeded); `parts` (INVENTORY_LEAD — the lowest inventory
role and, since #1439, the seeded parts-receiving persona) runs the supply
chain on its own grants — PO creation (`order:purchase_order:create` — note
the `order:` namespace; PO endpoints live in pos-order), ASNs
(`inventory:asn:create`/`view`), goods receipts
(`inventory:goods_receipt:create`/`view`), receiving sessions
(`inventory:receiving:create`/`complete`/`view`), cross-dock (D9 — requires
`inventory:receiving:complete` **AND** `inventory:issue:parts`, the only
conjunctive check in the suites; INVENTORY_LEAD holds both), putaway
(`inventory:putaway:view`/`generate`/`claim`/`execute`), backorders
(`inventory:shortage:view`, plus `inventory:shortage:resolve` if D10 needs
it), and availability (`inventory:on_hand:view`/`search`); `manager`
approves the PO (D2, `order:purchase_order:approve` — seeded to
LOCATION_MANAGER and INVENTORY_MANAGER by #1438); `advisor` builds the
shortage estimate (D7); `tech` completes the unblocked pick (D10).
Role-mode negatives: `tech` attempts D2's `approvePurchaseOrder` → rejected;
`parts` attempts D2's `approvePurchaseOrder` → rejected (the PO's creator
cannot approve it — INVENTORY_LEAD deliberately holds `create` but not
`approve`, the seed's separation-of-duties line).

**Part 1 — receiving a brand-new product into stock:**

- [x] **D1 — Create a new catalog product.** A runId-suffixed SKU/product via
  the catalog API (same shape as `CatalogBootstrap`). Assert entity id;
  snapshot availability (expect zero/absent).
- [x] **D2 — Purchase order.** `createPurchaseOrder` for 25 units
  (`poDate: new Date()`, real now), runId in `comment`. Assert PO id and one
  line with a line id. `approvePurchaseOrder`; assert approved.
- [x] **D3 — ASN and goods receipt.** `createAsn` referencing the PO and its
  line (`shipDate` now, `expectedArrivalDate` +3 real days — a future date is
  data, not a wait). `createGoodsReceipt` for the full 25 against the PO
  line. Assert receipt id; `getGoodsReceipt` round-trips.
- [x] **D4 — Stock visible.** `waitFor` availability of the new SKU at the
  location to increase by 25 over the D1 snapshot.
- [x] **D5 — Putaway (observed behavior).** `listPutawayTasks` for the
  receipt; if tasks exist, `claimPutawayTask` → `executePutaway` and assert
  completion. If the backend auto-putaways (no tasks), assert that and move
  on — the test documents which path this backend takes.
- [x] **D6 — Receiving-session variant.** For a second small PO:
  `createReceivingSession` (`sourceDocumentId` = PO id),
  `receiveItemsIntoStaging` with its lines, `getReceivingSession` → assert
  session state and received quantities. This covers the staging-based
  receiving path the seeder never touches.

**Part 2 — receiving products for a specific workorder:**

- [x] **D7 — Create a parts-shortage workorder.** New product (runId SKU-B)
  with **no stock**. Build an estimate with one labor line and one part line
  of SKU-B (qty 2); approve and promote. Assert the shortage is observable:
  either a backorder for SKU-B (`listBackorders` filtered by sku) or an
  unfulfillable pick task — record which signal this backend emits and assert
  it via `waitFor`.
- [x] **D8 — Order and receive against the workorder.** PO + ASN for SKU-B
  (qty 2) as in D2–D3, then `createReceivingSession` +
  `receiveItemsIntoStaging` for the delivery.
- [x] **D9 — Cross-dock to the workorder.** `crossDockReceivingLine` with
  `{ workorderId, workorderLineId, quantity: 2, notes: runId }` using the
  workorder part line id from D7. Assert the cross-dock response links the
  workorder.
- [x] **D10 — Workorder can proceed.** `waitFor` the workorder's pick task
  for SKU-B to become completable; complete and consume it (as C6); assert
  the part item reaches a completable status and the backorder (if D7
  observed one) is closed.
- [x] **D11 — Receiving negative.** `createGoodsReceipt` with a quantity
  exceeding the PO line (e.g. 999): assert rejection or documented
  over-receipt behavior; `crossDockReceivingLine` against a bogus workorder
  id: assert 4xx.

### Role mode: what the first real run found (2026-08-24)

Suites A-D run green in role mode - **46 passing, 0 skipped, 0 failing** - with
each persona on its own login and all seven role-enforcement negatives
executing. Getting there turned up four things that single-credential mode had
been hiding, because every persona was the admin login carrying all 442
permissions:

- **The preflight was asking the wrong system.** It read
  `GET /v1/users/{userId}/permissions`, which reports permissions attached to a
  user *directly* and is blind to role-derived access. Every persona came back
  with `[]` while its role carried a full set, and `check-permission` agreed
  with that empty answer. What the gateway enforces is the `perm_bits` bitmap
  minted into the token, so the preflight now logs in as each persona and
  decodes those bits (`POST /v1/users/permissions/decode`) against the
  `perm_ver` they were minted with. Verified against alpha: gloria.mendez's
  token decodes to exactly the 30 INVENTORY_LEAD permissions. This also proves
  the persona's credentials work, which asking about a user id never did.
- **A technician cannot read availability.** `getAvailabilityBySku` requires
  `inventory:on_hand:view` / `:search`. TECHNICIAN holds
  `inventory:availability:read`, which no endpoint asks for. Suite C's setup and
  C6's on-hand reads now go through the parts clerk. Worth raising upstream: a
  permission nothing enforces is either dead or the endpoint is checking the
  wrong one.
- **`retryWhileReplicating` blinded every status-aware assertion.** On a
  non-replication failure it threw a *new* Error, so `.response` was lost and
  `expectHttpError` could not read the status. A correctly-enforced 403 failed
  as "Expected HTTP 401/403 but got: ... HTTP 403" - reading the status out of a
  string it could no longer inspect. It now rethrows the original.
- **Promotion has a transient refusal.** pos-workorder answers 503
  `CUSTOMER_REQUIREMENTS_UNAVAILABLE` with a `nextAction` while the
  customer-requirements verdict replicates. `promoteWhenPromotable` and B6 treat
  it as lag rather than a verdict.

Backend behaviour that has changed since the 2026-08-23 notes below: promotion
refusals now carry a code, a correlationId and a `nextAction` (#1477, #1471),
and the workorder pick facade answers with an empty list instead of 404.

**Corrected 2026-08-24, 15:25 UTC.** The paragraphs below recorded three
behaviours as absent on the deployed build. That was wrong, and the error was in
these tests, not in the backend.

#1483 implements all three through Kafka - pos-workorder publishes a command,
pos-inventory generates the pick list, and the fact returns into
`ext_pick_task` - while C6, D7 and D9 each read once, immediately, and asserted
absence. Polling instead of reading once found every one of them:

| Behaviour | Result | Latency |
| --- | --- | --- |
| Pick tasks from promotion (#1479) | 1 task, `PENDING`, full quantity outstanding | ~27s |
| Receiving session from a PO (#1480) | built, with the PO's lines | ~3s |
| Shortage signal (#1481) | 1 unfulfillable pick task | ~54s |
| Cross-dock (previously unreachable) | accepted, `crossDockedQuantity` and ledger entries | - |

Three runs agreeing meant only that the same measurement error repeated. The
suites now wait for these signals through `waitFor` and assert their content;
D9 exercises the real cross-dock path for the first time. Two full runs green,
46/46.

The receiving-session 404 that looked like a defect was `ext_purchase_order_line`
replication lag: the PO is approved seconds before the session is requested, and
the projection catches up within a few seconds.

**Deploy timing (15:03 UTC).** Two further runs at 15:08
and 15:12, both 46/46 on an alpha holding all-200, report the same three
absences, so these are properties of the deployed build rather than of a
half-landed rollout.

Two behaviours did change with it:

- **Over-receipt is now refused.** Receiving 999 against a PO line of 1 was
  accepted before; it now answers 403.
  `InventoryGlobalExceptionHandler` maps `OverReceiptNotPermittedException` to
  `FORBIDDEN` deliberately, so this is a guard, not an authorization accident.
  Worth noting for role mode: a client cannot distinguish that refusal from a
  missing permission, since both arrive as a bare 403 - which is exactly the
  ambiguity #1471 set out to remove elsewhere. D11 records the status rather
  than asserting one, so it survives the change.
- **Cross-docking to an unknown workorder** answers 404 where D9's earlier note
  recorded the session itself as unbuildable.

A backorder is *not* raised alongside the pick task: on this backend the
unfulfillable pick task is the shortage signal, and D7 records the backorder
count so a second signal appearing becomes visible rather than being silently
tolerated.

---

### Suites A-D: what alpha actually does (2026-08-23)

All four suites run as one set against alpha: **39 passing, 7 skipped** (the
role-mode negatives, which need role mode), **0 failing**, repeatably. Values
recorded from real runs:

- **A1** initial appointment status is `SCHEDULED`; **A4** rescheduling a
  cancelled appointment is rejected with **409**; **A6** an inverted window is
  rejected with **400**.
- **B3** totals are exact: subtotal 262.95 for 129.95 + 84.50 + 2 x 24.25, tax
  22.35, total 285.30. **B4** submit moves `DRAFT -> PENDING_APPROVAL`. **B8**
  approve-after-promote is **400**, add-after-promote is **409**. **B6**
  declined status is `DECLINED` and promote is rejected with **409**.
- **C2** start moves the workorder to `WORK_IN_PROGRESS`. **C4** a second
  concurrent timer is **409**. **C9** invoice generation is *asynchronous*: the
  first call returns `{invoiceId: null, status: PENDING}` and a later call
  returns the invoice; finalized total 286.17, payment event accepted.
- **D4** a goods receipt raises on-hand by exactly what was received.
  **D5** this backend auto-putaways: no putaway tasks are created for a receipt.
  **D11** over-receipt is **accepted** - 999 units against a line of 1.

Three specified behaviours do not exist here, and the suites now assert their
absence so the tests fail the day they appear:

- **Pick tasks are not created by promotion** (C6). A pick list must be
  requested from inventory (`POST /v1/inventory/pick-lists`) and released; even
  then it holds no tasks, because tasks come from a reservation, which
  `CreatePickListRequest` carries an id for. The seeder's tolerated 404 had been
  hiding this.
- **Receiving sessions cannot be built from a purchase order** (D6, D9).
  pos-inventory fetches source-document lines through `SourceDocumentStubClient`,
  which is disabled by default (`pos.inventory.receiving.stub.enabled`) and
  points at a `/stub/...` service that was never written. Staging and cross-dock
  are therefore unreachable.
- **A workorder short of a part raises no shortage signal** (D7): no backorder,
  no unfulfillable pick task.

Backend defects found by these suites, each fixed or filed: #1460 (catalog LOB
reads), #1464 (purchase order auditing), #1465 (paged list endpoints ignore
client parameters), #1467 and #1473 (replica feeds disabled on alpha), #1469
(customer numbers collided every ~65 seconds), #1471 (unhandled exceptions
escape as bare 500s), #1475 (the appointment bridge never set created_by_id),
#1477 (estimate promotion discards the reason it refused, making a transient
refusal indistinguishable from a permanent one).

Two things the suites must do to stay repeatable, both learned the hard way:
appointment slots are booked in a band chosen at random across the next few
months, because every appointment a previous run booked is still there and the
backend refuses a double-booking; and each suite seeds its generator from its
own name as well as the runId, because a shared seed makes all four generate the
same VIN, which must be globally unique across active vehicles.

Environment notes worth keeping: only 10 of the 30 bootstrap products carry
stock, so any test that needs to pick a part must select a stocked one; and
`crmAccountsApi.createVehicleForParty` does not create a vehicle - it files a
VIN against the party and returns no id, so vehicles are registered through
pos-vehicle-inventory.

---

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

- [x] **Step 1: Determine reachable forward targets.** The gateway and
  security service are containers on the Compose network; SSM forwards to
  ports reachable *from the EC2 host*. Confirm from
  `deployment/alpha/docker-compose.prod.yml` which host ports the gateway and
  security service publish. If the security service publishes no host port,
  either add a loopback-only publish (`127.0.0.1:8086:8080`) to the alpha
  Compose model, or use `AWS-StartPortForwardingSessionToRemoteHost` with the
  container's network alias resolved on the host. Record the chosen mechanism
  in the script header.

  **Resolved (2026-08-21):** no Compose change and no `...ToRemoteHost`
  fallback needed. `deployment/alpha/docker-compose.prod.yml` is an
  image/restart override only; the base `docker-compose.yml` publishes both
  host ports already — `pos-api-gateway` `8080:8080` and
  `pos-security-service` `8086:8080`. Chosen mechanism:
  `AWS-StartPortForwardingSession` (instance-local ports), alpha instance
  `i-06d434c7593e70f5c` in `us-east-1`. Note both containers publish on
  `0.0.0.0`, so the host ports are open to anything the security group lets
  in; SSM is what keeps them unreachable from the internet.
- [x] **Step 2: Implement the tunnel script.** The script resolves the alpha
  instance id (tag lookup or `ALPHA_INSTANCE_ID` env), then opens two
  forwarding sessions: local `18080` → gateway, local `18086` → security
  service, and prints the matching `ITEST_*` exports. It must run both
  sessions concurrently, forward Ctrl-C to clean shutdown, and fail with a
  clear message when the SSM plugin is missing or the session is denied.

  **Done (2026-08-21):** `scripts/alpha-itest-tunnel.sh` and
  `scripts/alpha-itest-tunnel.ps1`. Instance resolution is
  `ALPHA_INSTANCE_ID` / `-InstanceId`, else a tag lookup on
  `Project=durion` + `Environment=alpha` + `instance-state-name=running`
  (fails loudly on zero or multiple matches). Preflight checks the AWS CLI,
  `session-manager-plugin`, callable credentials, that the local ports are
  free, and that the instance is an `Online` SSM managed node. Local ports
  override via `ITEST_GATEWAY_LOCAL_PORT` / `ITEST_SECURITY_LOCAL_PORT`.

  Shutdown note: `aws ssm start-session` does **not** forward termination to
  its `session-manager-plugin` child — killing only the `aws` pid orphans the
  plugin, which keeps both the SSM session and the local port alive. Both
  scripts kill the whole process tree on Ctrl-C for this reason.
- [x] **Step 3: Smoke-check the tunnel.** With the tunnel up, document and
  verify: `curl http://localhost:18080/actuator/health` (or the gateway's
  health path) returns healthy, and a login round-trip against
  `http://localhost:18086` succeeds. The tunnel carries JWTs and credentials
  over the SSM-encrypted channel; nothing is exposed publicly.

  Verified (2026-08-21): with both sessions open,
  `curl http://localhost:18080/actuator/health` returned HTTP 200 `status: UP`
  and `http://localhost:18086/actuator/health` returned HTTP 200 with `db: UP`
  and all 20 services registered in Eureka. The login round-trip also succeeds
  against alpha through the tunnel (`[Auth] Login successful.` as
  `admin.alpha`, after `SecurityBootstrap` granted 429 permissions to
  SYSTEM_ADMINISTRATOR and confirmed the role assignment).
- [x] **Step 4: Run the suite through the tunnel.** `npm run test:integration`
  with the printed exports completes against alpha; afterward, query one
  created record by runId (any suite's entity) through the API to confirm the
  records persisted in the alpha database.

  **Green (2026-08-22).** `npm run test:integration` through the tunnel:
  `Test Suites: 1 passed`, `Tests: 3 passed`, exit 0, with the bootstrap
  fixture fully idempotent on a second run (location, 7 people, 12 services and
  30 products all reported as skipped). The runId query half of this step waits
  on Suites A-D, which do not exist yet - `00-harness.itest.ts` creates no
  records of its own.

  The 2026-08-21 blocker (staffing assignment 404 "Person not found") was a
  propagation race after all, and is fixed in the seeder: the assignment now
  retries while the person replicates (SDK #11).

  Four further faults surfaced and were fixed on the harness side:

  - `BootstrapOrchestrator` demanded `/system/time`, which exists only under
    the accelerated profile, so the bootstrap died on a normal backend. It now
    falls back to the real clock.
  - Purchase orders moved to pos-order (`/v1/orders/purchase-orders`);
    `@durion-sdk/inventory` still carries a pre-move `PurchaseOrdersApi` whose
    paths 404. `InventoryBootstrap` now takes an order client for POs and keeps
    the inventory client for ASNs and goods receipts.
  - Jest does not apply `moduleNameMapper` to `globalSetup`, so the fixtures ran
    `packages/sdk-seeder/dist` - whatever was last built - while the suites ran
    current sources. `globalSetup` now imports the seeder by path.
  - Catalog idempotency was resolved through by-name lookups that cannot work:
    `listProductsByName` returns 500 on alpha, and `listServicesByName` returns
    a JSON array while the generated client declares a single DTO, so every run
    re-created all 12 services. Both now resolve through the search endpoints
    (`sku` for products, exact-name filter for services).

  Two backend faults remain open and are **not** harness bugs:

  - **pos-order is down on alpha** - `GET /order/actuator/health` returns 503
    while catalog, inventory, people, location and workorder all return 200.
    Every `POST /v1/orders/purchase-orders` fails, so `InventoryBootstrap`
    seeds no stock (30 products reported as "skipped" are really 30 failed POs;
    the counter conflates the two). Suite D will need this service up.
  - **`GET /catalog/v1/products/name/{name}` returns 500** for a name that
    exists (`Oil Filter 1`), on every call. Diagnosing it needs the pos-catalog
    stack trace from the alpha host.

  Earlier aborted runs wrote to alpha: location `MAIN-01`, its three bays,
  employee records, and duplicate service rows from the runs that predate the
  service-idempotency fix (`searchCatalogServices` shows more than one row per
  seeded service name).

Note: token lifetime must cover a full suite run; `SeederAuth.refreshIfNeeded`
already handles refresh — the harness reuses it between suites (the seeder
refreshes per virtual day for the same reason).

### Task 8: Wire Personas to the Seeded Operational Accounts (enables role mode)

The backend seeds the accounts already:
`pos-security-service/.../db/migration/R__seed_security_operational_data.sql`
creates 16 operational users (one shared password hash) with `user_roles`
assignments, so role mode needs **no user creation at all**. The persona →
seeded-account mapping:

| Persona | Role | Seeded users |
| --- | --- | --- |
| `advisor` | SERVICE_ADVISOR | `rachel.kim`, `tyrone.williams` |
| `tech` | TECHNICIAN | `kyle.brennan`, `deshawn.morris`, `carlos.ruiz`, `amber.nguyen`, `eddie.vasquez`, `priya.patel`, `james.okafor` |
| `manager` | LOCATION_MANAGER | `diana.rowe` |
| `acct` | ACCOUNT_MANAGER | `irene.torres` |
| `parts` | INVENTORY_LEAD | `gloria.mendez` |
| `admin` | SYSTEM_ADMINISTRATOR | `marcus.webb` (also `admin.alpha` from the reference seed) |

Operators point the `ITEST_<PERSONA>_*` variables at these usernames with
the shared operational password.

**Updated 2026-08-23:** this section used to say no seeded user held an
INVENTORY_* role and proposed adding one upstream. That happened.
`R__seed_security_operational_data.sql` now seeds 17 users, and
`gloria.mendez` carries INVENTORY_LEAD, so the `parts` persona needs no
provisioning on a freshly seeded database. The preflight still performs the
grant, because an environment seeded before that change — alpha may be one —
has the user without the role, and the two cases are indistinguishable from
the client side.

When the grant is needed it is one role assignment
(`PUT /v1/users/{userId}/roles/{roleId}`, requires `security:role:assign`).
Resolve the role **by name** from the roles listing rather than hardcoding its
UUID: on databases populated before backend #1440 (alpha included) the formerly
initializer-created roles keep their originally generated ids. Use
`assignUserRole`, which adds one scoped assignment — never
`assignUserRolesByUsername`, which **replaces** the user's entire direct role
set and would strip whatever else the account holds. Never grant individual
permissions — the seeded roles carry their full sets from
`R__seed_role_permissions.sql` — and never grant from the unenforced legacy
`inventory:purchase_order:*` family.

**Files:**

- Create: `packages/sdk-integration-tests/src/harness/PersonaBootstrap.ts`
  (role-mode preflight: verify + the single INVENTORY_LEAD assignment)
- Modify: `src/harness/globalSetup.ts` (invoke when role mode is configured)
- Test: unit tests for the preflight logic (mocked HTTP)

- [x] **Step 1: Verify the configured accounts.** In role mode, for each
  configured persona resolve the user by username and read
  `GET /v1/users/{userId}/permissions` (requires `security:permission:view`)
  as admin; assert the authorities the suites rely on are present. This
  catches a wrong username or missing role assignment before any suite
  runs, with a far clearer failure than a scattered 403.
- [x] **Step 2: Assign INVENTORY_LEAD for the parts persona.** When
  `ITEST_PARTS_*` is configured and that user lacks INVENTORY_LEAD, assign
  it (`PUT /v1/users/{userId}/roles/{roleId}`, role id resolved by name).
  Idempotent: already-assigned is a no-op. Record in the run log that the
  assignment was made. Separately, propose the upstream seed change adding
  a dedicated INVENTORY_LEAD operational user.
- [x] **Step 3: Link personas to people records.** The seeded operational
  users have no `person_id` (only `admin.alpha` does). Where the backend
  supports it, associate each persona user with the matching
  `PeopleBootstrap` employee (e.g. the tech login ↔ a TECHNICIAN employee
  id) so labor attribution and assignment views line up. If no linkage API
  exists, record that as a known limitation next to the affected C-suite
  assertions.
- [x] **Step 4: Hygiene.** Re-runs are no-ops. Passwords come only from the
  `ITEST_*` variables — never generated, logged, or stored; the shared
  operational password never appears in code or docs.
- [x] **Step 5: Verify role mode end-to-end.** With persona credentials set,
  global setup logs in all personas; suites A–D pass with per-persona
  execution; the role-enforcement negatives run (passing or as documented
  `test.failing` gaps).

  Done 2026-08-24 against alpha. All five personas configured
  (`rachel.kim`, `kyle.brennan`, `diana.rowe`, `irene.torres`,
  `gloria.mendez`); the preflight verifies each, and the person-link step
  reports which personas were already linked elsewhere. Suites A–D pass
  **46/46 with nothing skipped**, the seven role-enforcement negatives among
  them, repeated across several runs and once more from `main` after the work
  merged.

  All five personas are now configured (`rachel.kim`, `kyle.brennan`,
  `diana.rowe`, `irene.torres`, `gloria.mendez`), so the next run executes in
  role mode with each persona on its own login and the seven
  role-enforcement negatives running. Steps 1-4 are implemented and
  unit-tested (`src/harness/PersonaBootstrap.test.ts`, 15 cases). Still
  unchecked because it has not actually been run: alpha is mid-deploy for the
  #1477/#1479/#1480/#1481 fixes.

  Every call the suites make was checked against
  `R__seed_role_permissions.sql` and the operations' own
  `x-required-permissions` before enabling role mode. Two findings:

  - **C6 created its pick list as the technician.** `createPickList` requires
    `inventory:pick_list:create`, which TECHNICIAN does not hold — it carries
    `pick_list:execute` and `pick_list:view`. The manager raises the list now;
    the technician still releases and reads it. Single-credential mode hid
    this, because every persona was the admin login.
  - **All seven negatives are consistent with the seed**: TECHNICIAN lacks
    `workorder:estimate:approve`, `appointments:create`,
    `workorder:estimate:create`, `order:purchase_order:approve` and
    `workorder:workorder:complete`; INVENTORY_LEAD lacks
    `order:purchase_order:approve`; SERVICE_ADVISOR lacks `workorder:start`
    and `workorder:labor:add`. Each should therefore get its expected 403,
    provided the backend enforces what the registry declares — which is the
    thing these tests exist to find out.

### Task 9: Documentation

**Files:**

- Create: `packages/sdk-integration-tests/README.md`
- Modify: root `README.md` (one section pointing at the new package)

- [x] **Step 1: README.** Environment contract table (including the persona
  credential variables and the two run modes), the persona/role matrix,
  local and alpha run paths, the append-only data policy (records
  intentionally persist in the alpha database, found by runId), the
  timer-before-assignment constraint, the accelerated-profile guard, and the
  waitFor-not-sleep rule.

  `packages/sdk-integration-tests/README.md`, with a section in the root
  README pointing at it. The waitFor rule carries the observed round-trip
  latencies, because "read once and assert" is the mistake this suite has
  actually made.
- [x] **Step 2: Full verification.**

  Run from `main` on 2026-08-24 after the README merged. `npm test` 530
  passing and collecting **no** `*.itest.ts`; `npm run build` clean;
  `npm run test:integration` through the tunnel against alpha **46/46 in role
  mode**, runId `itest-1787593385-227v`, whose workorders are retrievable
  afterwards through `GET /v1/workorders/search?q=<runId>` (4 records).

  Two caveats, neither hidden:

  - The local-Compose leg was not run - there is no local stack up on this
    machine. Every alpha leg was.
  - Traceability was proved through the API rather than by connecting to the
    alpha database directly, which needs credentials this run did not have.
    The estimate search endpoint does not match on the runId marker; the
    workorder one does.

```bash
npm test            # unit suite still green, no itest files collected
npm run build       # workspace compiles including the new package
npm run test:integration   # against a local backend: all suites green
# then one tunneled run from the laptop against alpha: all suites green,
# records visible in the alpha database by runId
```

---

### Completion Criteria

- [x] `packages/sdk-integration-tests` exists as a private workspace package;
      `npm test` (unit) and `npm run test:integration` are fully independent.
      Verified by `jest --listTests`: the unit run collects zero `*.itest.ts`.
- [x] Seeder fixtures (`SeederAuth`, bootstraps, `ReferenceCache`,
      `SeederRandom`, `SEED_VENDOR_ID`) are consumed as a library, not
      copy-pasted; the seeder's own entrypoint and image are unchanged.
- [x] No test depends on virtual time: `/system/time` is touched only by the
      global-setup guard that aborts when alpha is mid-accelerated-run; no
      test waits for a clock boundary or uses an unbounded/fixed sleep; all
      asynchrony goes through `waitFor`.

      With one deliberate exception, recorded rather than waved through: suite
      C sleeps 1.5s in three places to let **real time elapse**, because a
      labor entry has to carry a duration above zero and the backend measures
      the wall clock. That is what C3 specifies. No amount of polling
      substitutes for elapsed time; every wait *for state* goes through
      `waitFor`.
- [x] Suites A–D pass against a non-accelerated backend, covering:
      appointment lifecycle + idempotent appointment→estimate bridge;
      estimate draft→lines→totals→approve/decline→promote; workorder
      approve→start→timers (incl. 409 recovery)→assignment→pick/consume→
      change request→item completion→complete→invoice→payment; receiving of
      a new SKU (PO→ASN→receipt→availability delta→putaway) and
      workorder-directed receiving (shortage→receive→cross-dock→pick
      completable), each with at least one negative case.
- [x] Every created entity is traceable to a run via the runId marker, and a
      completed alpha run's records are queryable in the alpha database.
      Verified through the API (`/v1/workorders/search?q=<runId>`), not by a
      direct database connection.
- [x] The full suite runs from a developer laptop against alpha through the
      SSM tunnel with no new public ingress on the alpha host.
- [x] Every test step declares its acting persona; the suite passes in
      single-credential mode, and in role mode each persona acts under its
      own login with the role-enforcement negatives running (passing or
      recorded as documented gaps).
- [x] Credentials appear only in shell environment variables or a git-ignored
      env file; they are never committed, logged, or passed on a command line.
- [ ] Root Jest unit run, TypeScript build, and lint remain green.

      Unit run and build: green (530 passing, `tsc` clean). **Lint is not, and
      never has been.** `npm run lint` reports 6,669 errors, of which 6,332 are
      in generated client code (`apis/`, `models/`, `runtime.ts`) and 300 in
      `dist/`. Only **37** are in hand-written source, and those are almost all
      deliberate `as any` mock casts in two unit-test files.

      ESLint has no `.eslintignore` and no `ignorePatterns`, so it lints build
      output and generated clients that `jest.config.js` already excludes from
      coverage. Making this criterion achievable means scoping ESLint the same
      way; that is a config decision left for its own change rather than folded
      into a documentation pass.
