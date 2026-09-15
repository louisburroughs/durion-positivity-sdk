# @durion-sdk/integration-tests

Interaction tests that drive a **real** Durion backend through the generated
SDK clients — the same clients a consumer application uses. Nothing is mocked
and nothing is stubbed: if a suite passes, that request/response really
happened against a running stack.

These are deliberately separate from the repo's unit tests. `npm test` never
collects a `*.itest.ts` file, and `npm run test:integration` never runs a unit
test.

The full specification, including the reasoning behind each suite, lives in
[`BACKEND_INTERACTION_TEST_SPEC.md`](./BACKEND_INTERACTION_TEST_SPEC.md). This
file is the operator's guide.

---

## What runs

| Suite | Covers |
| --- | --- |
| `00-harness` | Configuration, credentials, and the shared reference fixture |
| `a-appointments` | Appointment lifecycle, and the appointment → estimate bridge |
| `b-estimates` | Draft → lines → totals → approve/decline → promote |
| `c-workorder-execution` | Approve → start → timers → assignment → pick → change request → complete → invoice → payment |
| `d-receiving` | PO → ASN → receipt → availability → putaway, and workorder-directed receiving |
| `e-cycle-count` | Plan → generate tasks → count → recount → adjustment → approve → post, in an isolated bin |
| `f-time-reporting` | Labor sessions and timers, the payroll clock, and who decides on reported time |
| `h-service-position` | A workorder's bay / mobile unit / HOLD position and its technician: one open workorder per bay or unit, HOLD unbounded, the two assignments independent |

Current state on alpha: **46 passing, 0 skipped, 0 failing**, in role mode, for
suites 00-D. Suites E and F have not yet had a green run recorded here: the
alpha `pos-location` service was returning 503 when they were written, which
stops global setup before any suite starts.

---

## Prerequisites

1. **A backend to talk to** — either a local Compose stack or alpha through the
   SSM tunnel (below).
2. **A seeded environment.** Backend #1556 retired the Flyway seeds that used to
   supply locations, storage topology, staffing, putaway rules and stock; that
   reference data now enters through the API seed pipeline. Run the backend's
   `scripts/seed-alpha.py` against the target before the first run. Existing
   databases already carry the old rows — removing a repeatable migration only
   stops it re-applying — so this bites a *fresh* environment, where suite D
   fails at putaway with nothing to route to.
3. **Credentials** — at minimum an admin login. See *Environment contract*.
   On a tenant-aware backend a freshly provisioned login is not usable as
   issued: see *Starter credentials must be activated before login*.
4. **The accelerated profile must be off.** Global setup probes
   `GET /system/time`: a 404 means the normal clock and the run proceeds, a 200
   means the backend is mid-accelerated-run and the suite aborts before writing
   anything. Never run these tests against an accelerated backend — the virtual
   clock will move underneath assertions that depend on real elapsed time.

---

## Running

### Against alpha (the usual case)

The suite runs from a developer laptop; only network reachability is missing.
The tunnel uses AWS SSM port forwarding — the same control plane alpha already
uses for deploys — so no security-group ingress is opened and nothing on alpha
changes.

```bash
# terminal 1 — open the tunnel, leave it running
./scripts/alpha-itest-tunnel.sh          # PowerShell twin: .\scripts\alpha-itest-tunnel.ps1

# terminal 2 — run the suite from the repo root
npm run test:integration                 # everything
npm run test:integration -- appointments # one suite, by filename substring
```

The tunnel prints the two exports it has made available
(`http://localhost:18080` and `http://localhost:18086`); put them in
`.env.itest` or the shell.

If the tunnel drops mid-session — the SSM session has its own idle timeout —
global setup says so directly: *"cannot reach the backend at … Is the tunnel up
/ the local stack running?"*. Restart the tunnel and re-run.

### Against a local stack

Same commands, no tunnel, with `ITEST_BASE_URL=http://localhost:8080` and
`ITEST_SECURITY_SERVICE_URL=http://localhost:8086` — which are the defaults, so
usually just credentials are needed.

---

## Environment contract

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `ITEST_BASE_URL` | `http://localhost:8080` | No | API gateway base URL |
| `ITEST_SECURITY_SERVICE_URL` | `http://localhost:8086` | No | Security service URL (bootstrap + login) |
| `ITEST_USERNAME` | — | **Yes** | Admin login (SYSTEM_ADMINISTRATOR) |
| `ITEST_PASSWORD` | — | **Yes** | Admin password |
| `ITEST_ADVISOR_USERNAME` / `_PASSWORD` | _(admin)_ | No | SERVICE_ADVISOR persona |
| `ITEST_TECH_USERNAME` / `_PASSWORD` | _(admin)_ | No | TECHNICIAN persona |
| `ITEST_MANAGER_USERNAME` / `_PASSWORD` | _(admin)_ | No | LOCATION_MANAGER persona |
| `ITEST_PARTS_USERNAME` / `_PASSWORD` | _(admin)_ | No | INVENTORY_LEAD persona |
| `ITEST_ACCT_USERNAME` / `_PASSWORD` | _(admin)_ | No | ACCOUNT_MANAGER persona |
| `ITEST_CONTROLLER_USERNAME` / `_PASSWORD` | _(admin)_ | No | CONTROLLER persona; submits C9's accounting event |
| `ITEST_SEED` | _(random)_ | No | Integer RNG seed for reproducible values |
| `ITEST_WAIT_TIMEOUT_MS` | `30000` | No | Default `waitFor` timeout |
| `ITEST_WAIT_INTERVAL_MS` | `500` | No | Default `waitFor` interval |
| `ITEST_STAGING_LOCATION_ID` | _(resolved)_ | No | Forces suite D's staging bin. Unset, the suite asks the site for its declared staging default and falls back the way `StagingLocationResolver` does |
| `ITEST_ENV_FILE` | `.env.itest` at the repo root | No | Alternate credentials file |
| `ALPHA_TENANT_SLUG` / `ALPHA_TENANT_ID` | — | **Yes** | The tenant every suite runs in. Every login sends the slug, the security bootstrap sends the id as `X-Tenant-Id`, and global setup refuses a login bound anywhere else |
| `PLATFORM_TENANT_SLUG` / `PLATFORM_TENANT_ID` | — | With a platform login | The platform tenant (platform tables). Must differ from the alpha tenant |
| `ITEST_PLATFORM_USERNAME` / `_PASSWORD` | — | No | Platform-tenant login, activated and checked in the platform tenant |
| `ITEST_SEED_PASSWORD` | — | No | Shared starter password. An account that cannot log in yet is activated to its configured password before anything else logs in (one-shot per account) |

Persona credentials are **all-or-none per persona**: a username without its
password fails configuration validation rather than silently falling back.

### Where credentials live

In your shell, or in a git-ignored `.env.itest` at the repo root
(`.env.itest.example` is the template). Precedence: a non-empty real
environment variable always wins over the file, so CI and one-off
`VAR=x npm run …` overrides are unaffected. Only the *names* of applied keys
are ever logged.

Credentials are never committed, never printed, and never passed on a command
line.

### Starter credentials must be activated before login

Global setup handles this when `ITEST_SEED_PASSWORD` is set (see
`harness/StarterActivation.ts`): it attempts each account's login, activates
only those whose login is refused and that are still awaiting activation, and
sets them to the
`ITEST_*_PASSWORD` configured for them. `ALPHA_TENANT_SLUG` is passed to
activation and to every login, and the tenant preflight then refuses any
login bound to a tenant other than `ALPHA_TENANT_ID`.

Accounts bulk-loaded from `users.csv` are provisioned with one shared *starter*
password rather than a usable credential of their own. Such an account is
awaiting activation and carries credential-expiry provisioning, so **login is
refused until the starter password is traded through
`POST /v1/auth/activate-starter`** for a password of its own. The refusal is a
property of the account, not of the request: retrying the login, re-seeding, or
fixing `.env.itest` will not clear it. `loginUser` reports it as 401
`INVALID_CREDENTIALS`, the same answer as a wrong password: Spring checks
credential expiry only after a password matches, and nothing matches an
unclaimed account's password.

The generated client is `AuthAPIApi.activateAccountWithStarterPassword`
(`@durion-sdk/security`). Note the shape: it takes an
`ActivateAccountWithStarterPasswordRequest` *wrapper*, with the payload nested
under `activateWithStarterRequest` and the tenant header beside it, not the
payload fields at the top level. Passing them flat throws `RequiredError`
before any request leaves the process.

```ts
await securityClient.authAPIApi.activateAccountWithStarterPassword({
  activateWithStarterRequest: {
    username,
    starterPassword,
    newPassword,
    tenantSlug,        // optional here...
  },
  xTenantSlug: tenantSlug, // ...or as the X-Tenant-Slug header, beside it
});
```

The nested `ActivateWithStarterRequest`:

| Field | Required | Notes |
| --- | --- | --- |
| `username` | Yes | The account to claim |
| `starterPassword` | Yes | The shared password the operator handed out |
| `newPassword` | Yes | What the account gets instead; hashed server-side |
| `tenantSlug` | No | Needed only when the request host does not already name the tenant |

`xTenantSlug` sits on the wrapper, not in the payload, and carries the same
thing as `tenantSlug` via the `X-Tenant-Slug` header. The call is
unauthenticated and binds no tenant of its own; it returns 204, 400 on a blank
field, and 401 `ACTIVATION_TOKEN_INVALID` otherwise.

Consequences for the suite, all of which the harness has to learn:

- **It is per account, not per tenant.** Every persona in role mode
  (`ITEST_ADVISOR_*`, `ITEST_TECH_*`, `ITEST_MANAGER_*`, `ITEST_PARTS_*`,
  `ITEST_ACCT_*`, `ITEST_CONTROLLER_*`) has to be traded through activation
  individually, and so does the admin login. One activated persona says nothing
  about the other six.
- **The tunnel host names no tenant.** The suite reaches the backend at
  `localhost:18086`, so `tenantSlug` (or `X-Tenant-Slug`) is not optional here
  the way it is for a tenant-hosted request. The harness sends
  `ALPHA_TENANT_SLUG`.
- **Activation issues no token, and revokes the ones already minted.** It sets
  the password and returns; the login that follows is a separate call, and any
  token the account already held dies with the exchange. So every activation has
  to happen in `globalSetup` before any persona logs in — activating a persona
  mid-run invalidates a session another step is holding — and ahead of
  `PersonaBootstrap`'s preflight, which reads each persona's own token and so
  cannot run until every persona can log in.
- **The password in `.env.itest` is the post-activation password.** Whoever
  activates the account chooses it; the file holds the result, not the starter
  value.
- **Activation is one-shot, and failure is deliberately uninformative.** An
  account already claimed, an unknown username and a wrong starter password all
  return the same 401 `ACTIVATION_TOKEN_INVALID`, so a failed exchange cannot
  tell the harness which happened. Attempt the login first and fall back to
  activation only when login is refused (it answers `INVALID_CREDENTIALS`, not
  `CREDENTIALS_EXPIRED`), rather than activating unconditionally
  and trying to interpret the refusal — on a re-run against an already-activated
  environment every account is in the claimed state.

### The two activation flows are not interchangeable

`@durion-sdk/security` carries both flows, plus the platform-side calls around
them. They are not substitutes — each is for a different kind of account:

| Operation | Endpoint | For |
| --- | --- | --- |
| `AuthAPIApi.activateAccountWithStarterPassword` | `POST /v1/auth/activate-starter` | Bulk-provisioned accounts sharing one starter password — the flow a persona in the awaiting-activation state needs |
| `AuthAPIApi.activateAccount` | `POST /v1/auth/activate` | A tenant's first administrator, via a one-time token |
| `PlatformAdministratorAPIApi.mintAdministratorActivationToken` | `POST /v1/platform/tenants/{tenantId}/administrators/{userId}/activation-token` | Minting that token, as a platform operator |
| `PlatformSupportAPIApi.mintImpersonationToken` | `POST /v1/platform/tenants/{tenantId}/impersonation-token` | Platform support impersonation |
| `TenantAPIApi.getMyTenant` | `GET /v1/tenants/me` | Which tenant the caller's token is bound to |

`activateAccount` exchanges a one-time token minted by a platform operator
(valid 72 hours, single use) and is the wrong call for a bulk-provisioned
account, which is never given one.

---

## The two run modes

Mode is not a flag — it follows from whether any persona credentials are set.

### Single-credential mode

No persona variables. Every persona is the admin login. Suites still declare
who acts in each step, but the backend is not checking it, so the seven
role-enforcement negatives are skipped.

Use this for developing a suite, or against a local stack with no seeded
operational users.

### Role mode

One or more personas configured. Each configured persona logs in as itself;
unconfigured ones fall back to admin. The role-enforcement negatives run.

Before any seeding happens, `PersonaBootstrap` verifies every configured
persona and fails once, listing every problem, rather than surfacing a 403 in
the middle of a suite:

1. Each persona resolves to a real user, and holds the authorities its steps
   need. **Verified through the `perm_bits` bitmap in the persona's own token**,
   decoded against the `perm_ver` it was minted with — not
   `GET /v1/users/{id}/permissions`, which reports only *directly attached*
   permissions and reads empty for an account whose access comes from its role.
2. The parts persona is granted INVENTORY_LEAD if it lacks it, resolving the
   role by name (on databases seeded before backend #1440 the roles keep their
   original ids).
3. Each persona is linked to its matching seeded employee, so labor attributes
   to a real person. Never fatal — a persona already linked elsewhere, or one
   with no matching employee, is logged as a limitation.

### Persona → role → seeded account

| Persona | Role | Alpha account |
| --- | --- | --- |
| `admin` | SYSTEM_ADMINISTRATOR | `marcus.webb`, `admin.alpha` |
| `advisor` | SERVICE_ADVISOR | `rachel.kim`, `tyrone.williams` |
| `tech` | TECHNICIAN | `kyle.brennan` (+6 others) |
| `manager` | LOCATION_MANAGER | `diana.rowe` |
| `parts` | INVENTORY_LEAD | `gloria.mendez` |
| `acct` | ACCOUNT_MANAGER | `irene.torres` |
| `controller` | CONTROLLER | `margaret.olsen` |

All are seeded by the backend's `R__seed_security_operational_data.sql` and
share one operational password.

`acct` and `controller` have no matching employee record — PeopleBootstrap
seeds technicians, service writers, a manager and a parts clerk, and no
accounting employee — so labor attributed to either has no person behind it.
Reported at startup, not silently.

`controller` exists because backend V25 (#1499/#1512) rescoped ACCOUNT_MANAGER
to customer accounts (AR) and moved accounting management — including
`accounting:events:submit` — to the new CONTROLLER role. C9's
`submitAccountingEvent` therefore acts as `controller`; `acct` keeps the
payment, credit-memo and invoice authorities V25 left it. Leave
`ITEST_CONTROLLER_*` unset and that call falls back to admin, which still
passes but no longer proves enforcement.

---

## Rules the suites follow

Break these and tests fail intermittently, which is worse than failing outright.

### Wait, never sleep

All asynchrony goes through `waitFor` from `src/harness/waitFor.ts`. No fixed
sleeps, no unbounded loops, and no test may depend on a clock boundary.

This matters more than it sounds. Much of the backend is event-driven — a
promotion publishes a command, another service acts on it, a fact returns into
a replica — so **reading once and asserting proves nothing except what had
arrived by that instant**. Observed round trips on alpha:

| Signal | Typical latency |
| --- | --- |
| Receiving session becomes buildable after PO approval | ~3s |
| Pick tasks appear after promotion | ~30s |
| Shortage pick task for an unstocked part | ~55s |

Three test runs agreeing that something is absent is one measurement repeated,
not three observations.

### Assign technician and bay before work starts

Work is assigned — a technician and a bay — before it starts (backend #2011):
suite C does it in C1b/C1c before C2, suite F in its `beforeAll`, and the
seeder before `startWorkorder`. This used to be the other way round:
`stopTimers` once reached only timers tracking the authenticated user, so an
assigned technician stranded the timer. It now also stops timers the caller
started for someone else, which is what makes assigning first safe.

### Records are append-only

Nothing is torn down. Every run adds customers, vehicles, estimates,
workorders and purchase orders to the target database and leaves them there —
which is intentional, because a failed run's wreckage is the evidence.

Every entity carries the run's marker, so a run is findable afterwards:

```
runId = itest-<unix-seconds>-<4 random chars>     e.g. itest-1787589862-8utl
```

It appears in comments, notes, customer emails and SKUs. Two consequences:

- Appointment slots are booked in a band chosen at random across the coming
  months, because every appointment previous runs booked is still there and the
  backend refuses a double-booking. Booking retries on a slot conflict.
- Each suite seeds its RNG from its own name *as well as* the runId. A shared
  seed makes all four suites generate the same VIN, which must be globally
  unique across active vehicles.

---

## Layout

```
src/
  harness/
    globalSetup.ts        one-time: config, accelerated guard, security +
                          reference bootstrap, persona preflight
    ItestConfig.ts        environment contract, mode selection
    PersonaBootstrap.ts   role-mode preflight (verify, grant, link)
    personas.ts           persona → authenticated domain clients
    builders.ts           shared entity builders (customer, estimate, PO, ASN)
    availability.ts       stock reads
    stock.ts              seeds on-hand: bulk ingest + adjustment approval
    stagingLocation.ts    resolves the site's staging bin the way the backend does
    http.ts               call/expectHttpError/retryWhileReplicating/formatError
    waitFor.ts            the only sanctioned way to wait
    loadEnvFile.ts        .env.itest reader
  suites/
    00-harness.itest.ts   a-appointments.itest.ts   b-estimates.itest.ts
    c-workorder-execution.itest.ts                  d-receiving.itest.ts
    e-cycle-count.itest.ts                          f-time-reporting.itest.ts
    h-service-position.itest.ts
```

Suites receive the shared reference fixture through `ITEST_CONTEXT_FILE`,
written by global setup. Tokens are never serialized — each suite logs its
personas in itself.

---

## Environment notes worth knowing

- Only 10 of the 30 bootstrap products carry stock, so a test needing a part to
  pick must select a stocked one (`findStockedProduct`).
- **Reference data comes from the seed pipeline, not Flyway.** The suite creates
  what it owns — customers, vehicles, estimates, workorders, purchase orders,
  and its own catalog/inventory bootstrap — through the API, and never writes to
  a database. What it does *not* create is the storage topology and the terminal
  `ANY` putaway rule suite D routes through; those come from the backend's
  fixture packs (`scripts/fixtures/seed/alpha/`). The suite resolves them by
  name or by asking the owning service, so it does not care what ids they get,
  but it does need them to exist.
- No site declares a staging default today: `seed-alpha.py` seeds storage
  locations but never calls `PUT /v1/locations/{id}/defaults`, so pos-inventory
  falls through to its constant. The suite mirrors that chain rather than
  assuming either end of it.
- `crmAccountsApi.createVehicleForParty` does **not** create a vehicle. It
  files a VIN against the party and returns no id; vehicles are registered
  through pos-vehicle-inventory.
- Purchase orders live in pos-order, not pos-inventory.
- **The parts clerk plans cycle counts.** The alpha data load
  (`scripts/fixtures/seed/alpha/security/role-permissions.csv`) grants
  INVENTORY_LEAD — the parts clerk who counts stock in the building —
  `inventory:cycle_count:initiate`, `:view` and `:complete` alongside
  `inventory:adjustment:create` and `:view`. Suite E creates the plan as the
  clerk and E2 asserts it; generating and recording the count still run as the
  admin, and the clerk raises the adjustment.
  `inventory:adjustment:approve` is separate again: INVENTORY_CONTROLLER,
  INVENTORY_MANAGER and ADMIN, not the clerk who raised it.
- **Putting stock on hand takes two calls, not one.** Bulk ingest
  (`POST /v1/inventory/bulk-ingest/adjustments`) only raises an adjustment
  *request* per row; the ledger entry is written when that request is approved
  (`POST /v1/inventory/adjustments/{id}/approve`). Ingesting alone leaves
  availability at zero. `harness/stock.ts` does both, and needs two personas in
  role mode because create and approve are different permissions.
- **Nothing creates a decidable time entry.** pos-workorder's `time_entry` table
  has approve and reject endpoints and no writer at all. pos-people's
  `timekeeping_entry` is written by `TimekeepingIngestionService.ingestWorkSession`,
  but its `WorkSessionCompletedEvent` is published nowhere outside that service's
  unit tests — submitting a work session does not raise it. So no sequence of API
  calls reaches an APPROVED time entry today. Suite F covers the reporting half
  end to end and asserts the approval half's authorization and documented error
  contract, which stay true once the bridge lands.
- Time approval is split across two services and two permission families:
  `workorder:timeEntry:approve|reject` (MANAGER, LOCATION_MANAGER,
  GENERAL_MANAGER, SERVICE_ADVISOR, ADMIN) decides workorder hours;
  `people:timeEntry:approve|reject` (LOCATION_MANAGER, ADMIN) and
  `people:timekeeping:view|approve|reject` (MANAGER, LOCATION_MANAGER,
  GENERAL_MANAGER, ADMIN) decide payroll time. `workorder:labor:add` — which
  covers starting, stopping and *adjusting* a labor entry — is TECHNICIAN and
  ADMIN only, so a manager reads labor but never rewrites it.
- Stock reads act as the parts clerk. A technician *used* to be unable to read
  availability at all - `getAvailabilityBySku` required
  `inventory:on_hand:view`/`:search` while TECHNICIAN held only
  `inventory:availability:read`, which no endpoint asked for. Backend #1494
  fixed that by making the endpoint require the permission the role already
  had.
