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

Current state on alpha: **46 passing, 0 skipped, 0 failing**, in role mode.

---

## Prerequisites

1. **A backend to talk to** — either a local Compose stack or alpha through the
   SSM tunnel (below).
2. **Credentials** — at minimum an admin login. See *Environment contract*.
3. **The accelerated profile must be off.** Global setup probes
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
| `ITEST_SEED` | _(random)_ | No | Integer RNG seed for reproducible values |
| `ITEST_WAIT_TIMEOUT_MS` | `30000` | No | Default `waitFor` timeout |
| `ITEST_WAIT_INTERVAL_MS` | `500` | No | Default `waitFor` interval |
| `ITEST_ENV_FILE` | `.env.itest` at the repo root | No | Alternate credentials file |

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

All are seeded by the backend's `R__seed_security_operational_data.sql` and
share one operational password.

`acct` has no matching employee record — PeopleBootstrap seeds technicians,
service writers, a manager and a parts clerk, and no accounting employee — so
labor attributed to it has no person behind it. Reported at startup, not
silently.

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

### Do not assign a technician before the timer loop

`stopTimers` targets the authenticated user. Assigning a technician first
strands the timer where the acting persona cannot stop it. Suite C therefore
runs the timer work (C3, C4) *before* the assignment (C5). This ordering was
learned the hard way in the seeder; it is not stylistic.

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
    http.ts               call/expectHttpError/retryWhileReplicating/formatError
    waitFor.ts            the only sanctioned way to wait
    loadEnvFile.ts        .env.itest reader
  suites/
    00-harness.itest.ts   a-appointments.itest.ts   b-estimates.itest.ts
    c-workorder-execution.itest.ts                  d-receiving.itest.ts
```

Suites receive the shared reference fixture through `ITEST_CONTEXT_FILE`,
written by global setup. Tokens are never serialized — each suite logs its
personas in itself.

---

## Environment notes worth knowing

- Only 10 of the 30 bootstrap products carry stock, so a test needing a part to
  pick must select a stocked one (`findStockedProduct`).
- `crmAccountsApi.createVehicleForParty` does **not** create a vehicle. It
  files a VIN against the party and returns no id; vehicles are registered
  through pos-vehicle-inventory.
- Purchase orders live in pos-order, not pos-inventory.
- Stock reads act as the parts clerk. A technician *used* to be unable to read
  availability at all - `getAvailabilityBySku` required
  `inventory:on_hand:view`/`:search` while TECHNICIAN held only
  `inventory:availability:read`, which no endpoint asked for. Backend #1494
  fixed that by making the endpoint require the permission the role already
  had.
