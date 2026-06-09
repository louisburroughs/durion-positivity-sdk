# sdk-seeder Run Notes

This file is maintained by the **SeederDebug** agent. It is updated after every seeder run to capture outcomes, errors, and observations.

---

## Last Updated

2026-06-01

---

## Package Structure

```
packages/sdk-seeder/
  src/
    index.ts                        ← Entry point; wires config, auth, bootstrap, daily loop
    SeederConfig.ts                 ← Reads env vars (SEEDER_BASE_URL, SEEDER_USERNAME, SEEDER_PASSWORD,
                                       SEEDER_DAYS, SEEDER_SCALE, SEEDER_SEED, SEEDER_MIN_CUSTOMERS_PER_DAY,
                                       SEEDER_MAX_CUSTOMERS_PER_DAY, SEEDER_SLEEP_BETWEEN_DAYS_MS)
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
| `SEEDER_PASSWORD` | `s3cur1ty!` | Admin credential |
| `SEEDER_DAYS` | _(not set — uses SeederConfig default)_ | Number of virtual days to simulate |
| `SEEDER_SCALE` | _(not set)_ | Multiplier for customer volume |

## Backend Project Reference

The backend is located at `C:\POS\durion-positivity-backend`.  
If a seeder call fails with a 4xx/5xx, check the corresponding controller/service in the backend to understand the expected request shape and DB constraints.  
The backend runs **locally via Docker** (`docker compose up`). Ensure containers are healthy before running the seeder.

## Known Issues / Observations

- `sdk-transport/tsconfig.json` (and potentially other packages) inherit `"noEmit": true` from the root tsconfig. Any package that needs to emit to `dist/` must explicitly set `"noEmit": false` in its own tsconfig. If `tsc` runs silently with no errors but produces no `dist/` output, this is the cause.
- The generated OpenAPI SDK clients (in `sdk-people`, `sdk-customer`, etc.) throw `ResponseError` from their `runtime.ts`, NOT `DurionSdkError` from `sdk-transport`. `ResponseError` has a `response: Response` field. To check HTTP status in seeder catch blocks, use `(error as { response?: { status?: number } }).response?.status`.
- `SecurityBootstrap.ensureSysAdminRole` must use `X-Authorities: security:role:assign` (not `security:user:edit`) when calling `PUT /v1/users/{userId}/roles/{roleId}`. The endpoint is guarded by `@PreAuthorize("hasAuthority('security:role:assign')")` in `UserRoleController.java`.
- All SDK package `dist/` dirs are not rebuilt automatically. If any `src/index.ts` changes (new `createXxxClient` factory or workflow export), the dist will be stale and the seeder will get either a TS2305 compile error or a runtime "is not a function" error. Fix: rebuild all seeder dependencies at once with `npm run build -w packages/sdk-security -w packages/sdk-people -w packages/sdk-customer -w packages/sdk-location -w packages/sdk-catalog -w packages/sdk-inventory -w packages/sdk-workorder -w packages/sdk-order -w packages/sdk-accounting -w packages/sdk-vehicle-inventory -w packages/sdk-invoice`.
- `CatalogServiceImpl.getProductsByName()` (and `getServicesByName()`) in the backend has no `@Transactional` annotation. `ProductEntity.attributes` and `.specifications` are `@Lob` fields. Reading them outside a transaction throws `PSQLException: Large Objects may not be used in auto-commit mode` → backend returns 500. The seeder's `findCatalogEntityIdByName` silently swallows this 500, causing the "product exists but can't be found" deadlock (409 on create, null on fallback fetch → fatal re-throw). **Workaround**: use `productsApi.searchProducts({ sku })` instead of `productsApi.getProductByName({ name })` — the search path goes through `ProductSearchServiceImpl` which IS `@Transactional(readOnly=true)` and maps to `ProductSummary` (no LOB access).

---

## Run History

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
