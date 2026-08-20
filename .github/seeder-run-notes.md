# sdk-seeder Run Notes

This file is maintained by the **SeederDebug** agent. It is updated after every seeder run to capture outcomes, errors, and observations.

---

## Last Updated

2026-07-28

---

## Package Structure

```
packages/sdk-seeder/
  src/
    index.ts                        ← Entry point; wires config, auth, bootstrap, daily loop
    SeederConfig.ts                 ← Reads env vars (SEEDER_BASE_URL, SEEDER_SECURITY_SERVICE_URL,
                                       SEEDER_USERNAME, SEEDER_PASSWORD, SEEDER_DAYS, SEEDER_SEED,
                                       SEEDER_MIN_CUSTOMERS_PER_DAY, SEEDER_MAX_CUSTOMERS_PER_DAY,
                                       SEEDER_POLL_INTERVAL_MS)
    SeederAuth.ts                   ← Handles login, token cache, refresh-if-needed, buildSdkConfig()
    bootstrap/
      BootstrapOrchestrator.ts      ← Orchestrates location lookup, people, catalog, inventory in order
      SecurityBootstrap.ts          ← Runs before auth login; ensures admin user exists
      LocationBootstrap.ts          ← Location + bay setup
      PeopleBootstrap.ts            ← Employee creation (idempotent via getAllPeople + getEmployee)
      CatalogBootstrap.ts           ← Service and product catalog seeding
      InventoryBootstrap.ts         ← Initial inventory levels
    loop/
      DailyLoopRunner.ts            ← Outer loop: iterates over config.days virtual days
      CustomerEventSimulator.ts     ← Simulates one customer visit per iteration
      ShiftSimulator.ts             ← Clock-in/clock-out for employees
      InventoryMaintenanceSimulator.ts ← Replenishment and adjustments
    support/
      ReferenceCache.ts             ← Shared in-memory store: locationId, bayIds, employees, catalog IDs
      CustomerPool.ts               ← Manages reusable customer identities across days
      SeederRandom.ts               ← Deterministic RNG (seeded or random)
```

## Execution Flow

1. `run-seeder.ps1` sets env vars and runs `npm run seed -w packages/sdk-seeder`
2. `SeederConfig.fromEnv()` parses all env vars
3. `SecurityBootstrap.run()` — ensures auth works (pre-login step)
4. `SeederAuth.login()` — authenticates as admin; stores token with 10-hour TTL
5. `BootstrapOrchestrator.run()` — resolves location `MAIN-01`, bootstraps people/catalog/inventory, returns `ReferenceCache`
6. `DailyLoopRunner.run()` — simulates `config.days` virtual days, calling `auth.refreshIfNeeded()` each day

## Gateway URL Routing

All SDK clients are constructed with a `baseUrl` of `http://localhost:8080/<service-prefix>`.  
`SeederAuth.buildSdkConfig(servicePrefix)` produces the right URL per service.

Known service prefixes (used in `BootstrapOrchestrator` and sub-bootstraps):
| Service | Prefix |
|---------|--------|
| Security | `security-service` |
| Location | `location` |
| People | `people` |
| Catalog | `catalog` |
| Inventory | `inventory` |
| Workorder | `workorder` |
| Customer | `customer` |
| Order | `order` |
| Accounting | `accounting` |
| Vehicle Inventory | `vehicle-inventory` |
| Invoice | `invoice` |

## Environment Variables (set by run-seeder.ps1)

| Variable | Default in ps1 | Description |
|----------|----------------|-------------|
| `SEEDER_BASE_URL` | `http://localhost:8080` | Backend gateway root |
| `SEEDER_USERNAME` | `admin.alpha` | Admin credential |
| `SEEDER_PASSWORD` | _(must be set out-of-band before running — never committed)_ | Admin credential |
| `SEEDER_DAYS` | _(not set — uses SeederConfig default)_ | Number of virtual days to simulate |
| `SEEDER_POLL_INTERVAL_MS` | `1000` | Poll interval for the backend `/system/time` endpoint |

## Backend Project Reference

The backend is located at `C:\POS\durion-positivity-backend`.  
If a seeder call fails with a 4xx/5xx, check the corresponding controller/service in the backend to understand the expected request shape and DB constraints.  
The backend runs **locally via Docker** (`docker compose up`). Ensure containers are healthy before running the seeder.

## Known Issues / Observations

- Root cause for recurring shift clock-in 404s after ADR-0044 split: `WorkSessionServiceImpl.startSession()` now validates `personId` against `ext_people_contact_person` (identity replica), not `employee`. The `employee` row can exist while replica row is missing because migration V5 dropped local `person` table/FKs and left `employee.person_id` as an unfenced UUID. In docker-compose defaults, both `POS_PEOPLE_KAFKA_ENABLED` and `POS_PEOPLE_CONTACT_KAFKA_ENABLED` are `false`, so `createEmployee` writes employment rows but does not emit/consume identity upsert events; this creates orphan `employee.person_id` values that fail work-session start with 404.
- Clock-in failures that only print `Response returned an error code` can mask backend `404 Person not found with id: ...` responses from `POST /people/v1/people/workSessions/start`. In current `pos-people`, `WorkSessionServiceImpl.startSession()` requires `ext_person_replica` to contain the provided `personId`; otherwise it throws `PersonNotFoundException` (mapped to 404 by `PeopleExceptionHandler`). This can happen when employee records still resolve via `GET /v1/people/employees/by-number/{employeeNumber}` but their person identity replica rows are missing/drifted.
- Backend `pos-people` no longer exposes `GET /v1/people` (there is no `PersonController` in the current runtime), while `packages/sdk-people` still includes `PeopleAPIApi.getAllPeople()` targeting that route. Seeder must not call the deprecated endpoint. `PeopleBootstrap` now resolves existing employees only via `GET /v1/people/employees/by-number/{employeeNumber}` and uses the returned `personId`.
- SDK packages using `Object.entries()` must target/lib ES2017 or later. If a package build fails with `TS2550: Property 'entries' does not exist on type 'ObjectConstructor'`, update that package `tsconfig.json` target/lib to `es2017` or later.
- The generated OpenAPI SDK clients (in `sdk-people`, `sdk-customer`, etc.) throw `ResponseError` from their `runtime.ts`, NOT `DurionSdkError` from `sdk-transport`. `ResponseError` has a `response: Response` field. To check HTTP status in seeder catch blocks, use `(error as { response?: { status?: number } }).response?.status`.
- `SecurityBootstrap.ensureSysAdminRole` must use `X-Authorities: security:role:assign` (not `security:user:edit`) when calling `PUT /v1/users/{userId}/roles/{roleId}`. The endpoint is guarded by `@PreAuthorize("hasAuthority('security:role:assign')")` in `UserRoleController.java`.
- All SDK package `dist/` dirs are not rebuilt automatically. If any `src/index.ts` changes (new `createXxxClient` factory or workflow export), the dist will be stale and the seeder will get either a TS2305 compile error or a runtime "is not a function" error. Fix: rebuild all seeder dependencies at once with `npm run build -w packages/sdk-security -w packages/sdk-people -w packages/sdk-customer -w packages/sdk-location -w packages/sdk-catalog -w packages/sdk-inventory -w packages/sdk-workorder -w packages/sdk-order -w packages/sdk-accounting -w packages/sdk-vehicle-inventory -w packages/sdk-invoice`.
- `CatalogServiceImpl.getProductsByName()` (and `getServicesByName()`) in the backend has no `@Transactional` annotation. `ProductEntity.attributes` and `.specifications` are `@Lob` fields. Reading them outside a transaction throws `PSQLException: Large Objects may not be used in auto-commit mode` → backend returns 500. The seeder's `findCatalogEntityIdByName` silently swallows this 500, causing the "product exists but can't be found" deadlock (409 on create, null on fallback fetch → fatal re-throw). **Workaround**: use `productsApi.searchProducts({ sku })` instead of `productsApi.getProductByName({ name })` — the search path goes through `ProductSearchServiceImpl` which IS `@Transactional(readOnly=true)` and maps to `ProductSummary` (no LOB access).
- Seeder now issues explicit per-item completion calls before `completeWorkorder`: `POST /v1/workorders/{workorderId}/services/{serviceLineId}/complete` and `POST /v1/workorders/{workorderId}/parts/{partId}/complete`. If these endpoints (and/or state-machine auto-complete during workorder completion) are not deployed in the running backend container image yet, line completion attempts return non-success and workorder completion can still fail with "service/part items not in COMPLETED/CANCELLED state".
- Accounting event submission (`POST /accounting/v1/accounting/events`) can intermittently return HTTP 503 in the current local runtime. Seeder already treats `processPayment` failures as non-fatal and continues customer flow.

---

## Run History

### 2026-07-28 — Backend root cause traced to identity-replica split + compose defaults
- Duration: ~35 min
- Days simulated: 0 (backend runtime unavailable during final probe)
- Customers: completed=0, declined=0, errors=0
- Issues encountered: Clock-in 404s persisted despite valid employee-number lookups. Backend endpoint and migration review showed `startWorkSession` gates on `ext_people_contact_person` existence, while `employee` rows survive without person FK after ADR-0044 migration (`V5__drop_identity_tables.sql`). docker-compose defaults currently set `POS_PEOPLE_KAFKA_ENABLED=false` and `POS_PEOPLE_CONTACT_KAFKA_ENABLED=false`, which disables outbox/replica sync and allows orphan `employee.person_id` values.
- Fix applied: No backend code changes (investigation-only). Seeder diagnostics updated to include explicit Kafka-flag hint in fail-fast message when all selected employees hit 404 person-not-found.

### 2026-07-28 — Clock-in 404 root cause confirmed; shift diagnostics improved
- Duration: ~20 min
- Days simulated: 1 (aborted at Day 1 SHIFT-IN)
- Customers: completed=0, declined=0, errors=0
- Issues encountered: All selected employees failed `startWorkSession` with generic SDK error text (`Response returned an error code`). Direct gateway probes confirmed HTTP 404 with detail `Person not found with id: ...` for all seeded person IDs (James/Marcus/Elena/Olivia/Daniel/Michelle/Avery), while `GET /v1/people/employees/by-number/*` still returns ACTIVE employee records for those numbers.
- Fix applied: Updated `ShiftSimulator` to parse `ResponseError.response` and log actionable HTTP status/detail for clock-in failures. Added fail-fast guard that throws when all selected employees fail with 404 person-not-found, preventing the seeder from continuing into customer flow with zero active staff and hiding the real root cause.

### 2026-07-28 — People bootstrap migrated to new endpoint only
- Duration: ~1 min
- Days simulated: 1
- Customers: completed=0, declined=0, errors=9
- Issues encountered: Legacy `GET /v1/people` is fully deprecated in current backend runtime; downstream customer-flow still fails at `pickOrRegisterVehicle` with HTTP 405 on `POST /v1/crm/{partyId}/vehicles`.
- Fix applied: Removed legacy `peopleApi.getAllPeople()` usage and all 404 fallback logic from `PeopleBootstrap`; seeder now indexes existing employees exclusively with `GET /v1/people/employees/by-number/{employeeNumber}`.

### 2026-07-28 — People bootstrap 404 mitigated via by-number fallback
- Duration: ~1 min
- Days simulated: 1
- Customers: completed=0, declined=0, errors=7
- Issues encountered: Legacy `GET /people/v1/people` returned 404 in current backend runtime. Also observed downstream customer-flow failures at `pickOrRegisterVehicle` with HTTP 405 on `POST /v1/crm/{partyId}/vehicles`.
- Fix applied: Updated `PeopleBootstrap` to treat 404 from `peopleApi.getAllPeople()` as a contract-drift signal and fallback to `GET /v1/people/employees/by-number/{employeeNumber}` lookups using the existing seeder token.

### 2026-06-30 — Timer conflicts and invoice tax-jurisdiction failure resolved
- Duration: ~1 min
- Days simulated: 1
- Customers: completed=5, declined=1, errors=0
- Issues encountered: Non-fatal HTTP 503 during `processPayment` (`/accounting/v1/accounting/events`); one shift time-entry approval warning still logged by `ShiftSimulator`.
- Fix applied: Updated `CustomerEventSimulator` labor loop to handle timer start/stop per-service with one-shot 409 recovery (clear active timer then retry). Updated `LocationBootstrap` to always seed address fields on create and to backfill `country`/`postalCode` via `updateLocation` for existing `MAIN-01`, which removed `generateInvoice` failures caused by missing tax-jurisdiction data.

### 2026-06-25 — Explicit completion endpoints confirmed 404 in active runtime
- Duration: ~3 min (1-day run)
- Days simulated: 1 (partial)
- Customers: completed=0, declined=2, errors=4+
- Issues encountered: Explicit item completion calls now log per-request outcomes and consistently returned 404 `Not Found` for `/v1/workorders/{workorderId}/services/{serviceLineId}/complete` in the running environment. Subsequent `completeWorkorder` still failed with 400 due to non-terminal service/part items.
- Fix applied: Added response-body logging for item completion 400/404 responses to make endpoint availability and routing issues immediately visible during runs.

### 2026-06-25 — Seeder wired for explicit item completion, runtime backend appears outdated
- Duration: ~4 min (1-day run)
- Days simulated: 1 (partial; failed during customer flow)
- Customers: completed=0, declined=0, errors=3+
- Issues encountered: Seeder attempted explicit service/part line completion before workorder close (`attempted=2`), but no item completions succeeded and `completeWorkorder` still returned 400 requiring terminal item states. Direct probe to `POST /workorder/v1/workorders/{id}/services/{serviceLineId}/complete` returned 404 from the running environment, indicating the active backend containers likely do not yet include the new completion endpoints and/or auto-complete logic.
- Fix applied: Updated `CustomerEventSimulator` to perform explicit per-item completion pass using line IDs from `workorderDetail` before closing the workorder, with graceful handling for 400/404 outcomes so newer and older backends can both be exercised.

### 2026-05-12 — 403 on role assignment fixed
- Duration: N/A (failed at bootstrap)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `SecurityBootstrap.ensureSysAdminRole` sent `X-Authorities: security:user:edit` but endpoint requires `security:role:assign` → 403 FORBIDDEN
- Fix applied: Changed `X-Authorities` header to `security:role:assign` in `SecurityBootstrap.ensureSysAdminRole`

### 2026-05-12 — 403 on GET /people/v1/people
- Duration: N/A (failed at PeopleBootstrap)
- Days simulated: 0f
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `PeopleBootstrap.run()` calls `peopleApi.getAllPeople()` which hits `GET /v1/people`. `PersonController.getAllPeople()` is guarded by `@PreAuthorize("hasAuthority('people:person:view')")`, but `people:person:view` (and the other `people:person:*` authorities) were absent from `pos-people/src/main/resources/permissions.yaml`. As a result they were never registered with the security service, never included in the 248-permission bulk grant by `SecurityBootstrap`, and never present in the JWT → 403 FORBIDDEN.
- Fix applied: Added `people:person:view`, `people:person:create`, `people:person:edit`, `people:person:delete` to `C:\POS\durion-positivity-backend\pos-people\src\main\resources\permissions.yaml`. Restart the `pos-people` container before the next run so `PermissionRegistration` re-pushes the updated list to the security service.

### 2026-05-13 — TypeScript compile error on SeederAuth imports
- Duration: N/A (failed at startup)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `SeederAuth.ts` could not import `createSecurityClient` or `SecurityAuthWorkflow` from `@durion-sdk/security`. `dist/index.js` and `dist/index.d.ts` were stale — compiled from an older `src/index.ts` that predated both exports.
- Fix applied: Ran `npm run build -w packages/sdk-security` to regenerate `dist/`. Both exports now present in `dist/index.d.ts`.

### 2026-05-13 — Runtime "is not a function" on createPeopleClient (and all other SDK factories)
- Duration: N/A (failed at PeopleBootstrap)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `createPeopleClient` (and all remaining `createXxxClient` factories for customer, inventory, workorder, order, accounting, vehicle-inventory, invoice) were absent from their respective `dist/index.js`. TypeScript compiled because location/catalog had just been rebuilt (types resolved), but at runtime the CJS exports were missing.
- Fix applied: Rebuilt all 8 stale packages in one command: `npm run build -w packages/sdk-people -w packages/sdk-customer -w packages/sdk-inventory -w packages/sdk-workorder -w packages/sdk-order -w packages/sdk-accounting -w packages/sdk-vehicle-inventory -w packages/sdk-invoice`.

### 2026-05-13 — Catalog services not found during bootstrap
- Duration: N/A (failed at CatalogBootstrap)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `BootstrapOrchestrator` tried to look up catalog services/products by name via `productsApi.getServiceByName()` but never called `CatalogBootstrap.run()` to create them first. Since the DB was empty, every lookup returned no result and threw `[Bootstrap] Service "Oil Change - Full Synthetic" not found`.
- Fix applied: Replaced the manual name-lookup loops in `BootstrapOrchestrator` with a single `new CatalogBootstrap(...).run()` call (idempotent create-or-skip). Removed unused `SERVICE_NAMES`, `PRODUCT_NAMES`, `range()`, `extractId()`, and `createCatalogClient` import; added `CatalogBootstrap` import.

### 2026-05-19 — 409 Conflict on POST /catalog/v1/products (LOB auto-commit bug)
- Duration: N/A (failed at CatalogBootstrap)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: Products from a previous run exist in the DB. `getProductByName` calls `CatalogServiceImpl.getProductsByName()` which has no `@Transactional`. Reading `@Lob` fields (`attributes`, `specifications`) on the returned `ProductEntity` outside a transaction throws `PSQLException: Large Objects may not be used in auto-commit mode` (500 from backend). `findCatalogEntityIdByName` swallows the 500 → returns `undefined` → seeder tries `createProduct` → 409 Conflict (product exists by SKU) → fallback `getProductByName` also throws 500 → `duplicateId` is `undefined` → re-throws 409 → Fatal error.
- Fix applied: Replaced both `productsApi.getProductByName({ name: product.name })` calls in `CatalogBootstrap` (initial existence check and catch-block fallback) with `productsApi.searchProducts({ sku: product.sku, limit: 1 })`. The search path goes through `ProductSearchServiceImpl` which IS `@Transactional(readOnly=true)` and maps to `ProductSummary` (no LOB field access). `extractEntityId` finds `productId` in `data[0]`.

### 2026-06-01 — 409 on clock-in: stale active work session from prior run
- Duration: N/A (failed at Day 1 SHIFT-IN)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `ShiftSimulator.clockIn()` calls `POST /v1/people/workSessions/start`. If a previous seeder run crashed before `clockOut()`, employees retain an `ACTIVE` session in the DB. `WorkSessionServiceImpl.startSession()` checks `findByPerson_IdAndEndedAtIsNull` and throws `IllegalStateException` → `PeopleExceptionHandler` maps to HTTP 409 CONFLICT → SDK throws `DurionSdkError [409]`. Previously the catch block only logged the failure and skipped adding the person to `activePersonIds`, so they were never clocked out.
- Fix applied: Added `"noEmit": false` to `sdk-transport/tsconfig.json`. Added `closeStaleSession()` private method to `ShiftSimulator` — before each `startWorkSession`, it calls `stopWorkSession` for the person and silently swallows 404 (no active session). This ensures a clean slate on every run regardless of prior crashes, eliminating both the 409 on clock-in and the clock-out failures caused by mismatched `activePersonIds`. Removed the 409-handling workaround from the earlier fix. Note: generated OpenAPI clients throw `ResponseError` (from `runtime.ts`), not `DurionSdkError`; use `(error as { response?: { status?: number } }).response?.status` to inspect HTTP status in catch blocks.

### 2026-06-01 — 409 Conflict on POST /inventory/v1/inventory/asns
- Duration: N/A (failed at InventoryBootstrap)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `AsnServiceImpl.createAsn` throws `DuplicateAsnException` (409) when a re-run finds no existing PO (PO query failure is swallowed silently → `existingPurchaseOrders = []`), creates a fresh PO, approves it, then attempts `createAsn` with `asnReferenceNumber: ASN-${index+1}-${productEntityId}`. This reference was already used by the previous run's ASN, so the backend's `findByVendorIdAndAsnReferenceNumber` check returns a match → 409. The reference number was tied to the product array index, not the PO ID, making it identical across runs for the same product.
- Fix applied: Changed `asnReferenceNumber` from `` `ASN-${index + 1}-${productEntityId}` `` to `` `ASN-SEED-${poId}` `` in `InventoryBootstrap.ts`. Using the freshly created PO's UUID guarantees uniqueness per run — two runs cannot produce the same reference because each new PO gets a UUIDv7. Also promoted the silent PO query `console.error` to `console.warn` with a message indicating idempotency is degraded, so partial-run artifacts are easier to diagnose.

### 2026-06-08 — Systemic @LoadBalanced + http://api-gateway bug: full backend sweep + fixes
- Duration: ~3 hours (multi-session spanning two conversation contexts)
- Days simulated: 0 (blocked at pickOrRegisterVehicle before these fixes)
- Customers: completed=0, declined=0, errors=0
- Issues encountered:
  1. **PeopleClient (pos-customer)**: `@Qualifier("loadBalancedRestClientBuilder")` → Spring Cloud LoadBalancer tried to resolve `pos-people` as Eureka service ID. pos-people registers as `PEOPLE` in Eureka, not `pos-people` → `No instances available for pos-people` → HTTP 500 on `POST /v1/crm/accounts/parties`.
  2. **customer_number NOT NULL** (pos-customer `PartyServiceImpl`): `createCommercialAccount()` never called `generateCustomerNumber()`. Column is `NOT NULL UNIQUE` in `commercial_party` table → DB constraint violation.
  3. **UUID truncation collision** (pos-customer `PartyServiceImpl`): `generatePartyNumber()` and `generateCustomerNumber()` both truncated UUID to first 8 chars (`.substring(0,8)`). UUIDv7 high bits are timestamp — concurrent calls in same ms produce identical 8-char prefix → duplicate key constraint violation under load.
  4. **VehicleInventoryClient (pos-customer)**: Same `@LoadBalanced` + `http://api-gateway` bug. Also missing `X-Authorities`/`X-User` header forwarding, and wrong URI paths (`/v1/vehicles` instead of `/v1/vehicle-registry`).
  5. **Systemic pattern across entire backend**: Scan found 22 additional broken clients across 7 services using `@Qualifier("loadBalancedRestClientBuilder")` + `http://api-gateway` default URLs (gateway routing + LoadBalancer incompatible with direct service-to-service calls that need identity header forwarding).
- Fix applied (backend files changed):
  - `pos-customer`: PeopleClient, VehicleInventoryClient, PartyServiceImpl, application.yml (previous session)
  - `pos-workorder`: CustomerValidationClient, ShopmgrOperationalContextClient, CustomerReferenceService, InventoryClientConfig, InvoiceClientConfig, PeopleClientConfig, InventoryPickClient, InvoiceClient, PeopleAvailabilityClient, PeopleLocationClient, application.yml
  - `pos-inventory`: SiteDefaultsClient, StorageLocationValidationClient, WorkorderValidationClient, application.yml
  - `pos-shop-manager`: HrAvailabilityClient, LocationClient, PersonClient, ServiceEntityClient, application.yml
  - `pos-catalog`: InventoryClientImpl, PricingClientImpl
  - `pos-location`: LocationInventoryInquiryClient, PersonClient, application.yml
  - `pos-people`: RestClientConfig (securityServiceRestClient, workexecRestClient), application.yml
  - `pos-security-service`: RestClientConfig (peopleRegistrationRestClient, customerRegistrationRestClient), application.yml
- Architectural note: `pos-mcp-server` intentionally uses `@LoadBalanced` + `BearerTokenRelayInterceptor` (JWT relay) — this is correct by design for an AI gateway aggregator and must NOT be changed.

### 2026-06-18 — Duplicate key on `commercial_party_party_number_key` (recurring)
- Duration: N/A (failed at CustomerEventSimulator.simulate → pickOrCreateCustomer)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `generatePartyNumber()` in `PartyServiceImpl` still used `.toString().substring(0, 8)` without stripping hyphens first. In a UUIDv7 string (format `019EDAFC-ECFB-7079-...`), the first 8 characters are the high 32 bits of the millisecond timestamp, which only increments every **65,536 ms (~65 seconds)**. Every commercial party created within the same 65-second window receives the same `party_number` (e.g. `PARTY-019EDAFC`), guaranteed to violate the `UNIQUE` constraint. The 2026-06-08 session identified this pattern but the fix was not fully applied — `generateCustomerNumber()` was corrected (strips hyphens, takes last 8 random chars) but `generatePartyNumber()` was left in the broken state.
- Fix applied: Changed `generatePartyNumber()` in `pos-customer/PartyServiceImpl.java` to match the `generateCustomerNumber()` pattern — strip hyphens first, then take the last 12 chars (pure `rand_b` random bits, ~48-bit entropy). Format changes from `PARTY-XXXXXXXX` (8 timestamp chars, 65-sec collision window) to `PARTY-XXXXXXXXXXXX` (12 random chars, essentially zero collision probability). Column is `varchar(255)` so no schema change required.

### 2026-06-23 — 409 laborLoop + 404 pickAndConsumeParts
- Duration: ~30 min
- Days simulated: 1 (partial — errors at laborLoop and pickAndConsumeParts)
- Customers: completed=0, declined=1, errors=1+
- Issues encountered:
  1. **409 `TIMER_ALREADY_ACTIVE` at `laborLoop`**: `stopTimers()` errors were swallowed by a silent `catch {}` block. When `stopTimers` failed (e.g., 400 or 409 from the backend), the timer for the current service remained active. The next `startTimer` call in the loop hit 409 `TIMER_ALREADY_ACTIVE`, which propagated to the outer try-catch and aborted all remaining service timer iterations.
  2. **404 at `pickAndConsumeParts`**: When a workorder has no product/part items, the inventory service creates no pick list. `WorkorderPickFacadeServiceImpl.resolvePrimaryPickList()` throws a `ResponseStatusException(404)` which propagates back to the caller. The seeder logged this as an ERROR, but it is expected behavior when the estimate contained only labor services (no products).
- Fix applied:
  1. Wrapped each service iteration's `startTimer` + `stopTimers` in its own try-catch. Timer conflicts are now logged as `WARNING` and skipped per-service rather than aborting the entire loop.
  2. Added `isHttpStatus(error, status)` helper to `CustomerEventSimulator.ts`. In `pickAndConsumeParts`, 404 is now swallowed silently (no parts = no pick list = expected); all other errors still log as ERROR.

### 2026-06-23 — TIMER_ALREADY_ACTIVE caused by labor attribution mismatch
- Duration: ~20 min (investigation + fix)
- Days simulated: 0 (blocked at Day 1 laborLoop)
- Customers: completed=0, declined=1, errors=1
- Issues encountered: Pre-stop `stopTimers` throws 409 `NO_ACTIVE_TIMER`, then `startTimer` immediately throws 409 `TIMER_ALREADY_ACTIVE` for the second service in the loop. Appeared paradoxical.
- Root cause: `stopTimers` (backend) always resolves mechanic from the JWT → targets admin.alpha's labor entries. `startTimer`, when no `technicianId` is in the request body and the workorder has an assigned technician T1, attributes the timer to **T1** (via `resolveTrackedTechnician`). So the pre-stop and post-stop never find admin.alpha's timer, T1's timer is never closed, and the second `startTimer` for the same T1 hits TIMER_ALREADY_ACTIVE. Note: the SDK-generated `WorkexecTimerStartRequest` type does not expose a `technicianId` field, so the seeder cannot override the attribution target.
- Fix applied: Moved `assignTechnician` to after the timer loop (before pick parts) in `CustomerEventSimulator.ts`. With no assignment present during the loop, `resolveTrackedTechnician` falls back to `actorPersonId` (admin.alpha), so timers are attributed to admin.alpha and `stopTimers` correctly finds and stops them.

### 2026-06-23 — Duplicate key on `commercial_party_customer_number_key` (regression)
- Duration: N/A (failed at CustomerEventSimulator.simulate → pickOrCreateCustomer)
- Days simulated: 0
- Customers: completed=0, declined=0, errors=0
- Issues encountered: `duplicate key value violates unique constraint "commercial_party_customer_number_key"` — Key `(customer_number)=(CUST-019EF57F)`. The 2026-06-18 session fixed `generatePartyNumber()` but left `generateCustomerNumber()` in its broken state: `.toString().substring(0, 8)` extracts the UUIDv7 timestamp prefix without stripping hyphens first, giving every customer created within the same ~65-second window the same `CUST-XXXXXXXX` value → constraint violation.
- Fix applied: Changed `generateCustomerNumber()` in `pos-customer/PartyServiceImpl.java` from `.toString().substring(0, 8)` to `.toString().replace("-", "").substring(20)` — strips hyphens then takes the last 12 chars (positions 20–31 of the 32-char hex UUID, which are the pure `rand_b` random bits). This matches the corrected `generatePartyNumber()` pattern. **Requires rebuilding and restarting the `pos-customer` Docker container.**
