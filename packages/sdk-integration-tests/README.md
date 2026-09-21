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

Each of these has an accelerated copy under `src/suites-accelerated`
(`*.accel.itest.ts`) that runs against a backend whose clock starts a year in the
past, plus `z-year-volume`, which drives 365 virtual days of shop activity. They
are a separate run with a separate entry point — see *Accelerated year run*.

Current state on alpha: **46 passing, 0 skipped, 0 failing**, in role mode, for
suites 00-D. Suites E and F have not yet had a green run recorded here: the
alpha `pos-location` service was returning 503 when they were written, which
stops global setup before any suite starts.

### Populate runs (`src/runs`)

Separate from the suites: these *load* a backend instead of asserting against
it. They take the same environment contract below, but they are not
`*.itest.ts`, so `jest.integration.config.js` never collects them, they do not
execute `globalSetup`, and they share no fixture or run id with a suite run.

| Run | Does |
| --- | --- |
| `shopFloorLoad` (`npm run populate:shop-floor`) | Puts one active workorder on every free bay and mobile unit it can staff, at every site that has them |

`shopFloorLoad` **uses what is there**: sites, bays, mobile units and
technicians are discovered, never created. It does not run the seeder's
`BootstrapOrchestrator` or the security bootstrap — both write reference and
role data a populate run has no business changing. It does create the work
itself (a customer, a vehicle and an approved estimate per job), because a
workorder cannot be placed on a bay without one.

How it decides:

- **Positions** come from the dispatch board (`getDispatchDashboard`), which
  lists every ACTIVE bay and mobile unit at a location with the open workorder
  holding it — so "free" is read from the same place the shop's own board reads
  it, and an INACTIVE unit is absent by that endpoint's contract.
- **Technicians** come from people availability filtered to an ACTIVE
  `TECHNICIAN` staffing assignment; the board then says which are already on a
  job. Only idle ones are used.
- **One technician per position, never two.** Where a site has more free
  positions than idle technicians, it fills what it can and names every
  position it left empty. A spare technician at one site cannot cover a gap at
  another, so the floor's shortfall is the sum of the per-site gaps.
- **Bays and mobile units are staffed alternately**, so a short-staffed site
  still ends with both kinds working rather than every mobile unit idle.
- **Starting is best-effort.** `startWorkorder` acts as the calling persona, and
  in role mode that is the one configured technician login rather than whichever
  technician the job was assigned to, so workexec can refuse it. Such a job is
  reported as placed-but-not-started (`ASSIGNED`, not `WORK_IN_PROGRESS`); it
  still occupies the position, and it is not counted as a failure.
- **Both clocks are written, and both are closed.** Every technician the run is
  about to use is clocked in before the first job — best-effort: one who cannot
  be, because the payroll service refused it, is reported and skipped rather
  than costing the floor its position — and out after the last
  (pos-people work sessions — the payroll clock), and every job it manages to
  start carries a labor session — where workexec lets that login write one —
  opened at the start and closed at the end of the load (pos-workorder labor
  entries — the job clock). The backend stamps each
  instant from its own clock and computes `hoursWorked`; the run declares no
  figure, and the summary reports the total it got back. The closing runs in a
  `finally`, because an entry left open has no hours at all and an open work
  session is stamped shut by whatever closes it next — the following morning, on
  a later run, which books the night as worked. A job whose start was refused
  books no labor: there is no work to book it against. A labor session refused
  with 401/403 (the same role-mode shape as the start) leaves that position
  working with no hours, reported and not fatal.
- **The payroll clock is keyed by person, and only by person.** The work session
  API is start, break, stop and submit by `personId`, with no read, so closing a
  stale session before clocking in closes whatever that person has open — the
  seeder's shift loop, or another run. Nothing can tell the difference; there is
  nothing to ask. Not closing it means the clock-in hits the conflict an open
  session raises and the run writes no payroll at all, which is why suite F and
  the accelerated shift port do the same. The clock-out is narrowed to the people
  this run clocked in; a session another run opens mid-load is the part that
  cannot be narrowed away.

Build the workspace packages first with the root `npm run build`: it compiles
every package in dependency order and writes the `dist` a run imports.
(`npm run build --workspaces` is unordered and can compile a package before
`@durion-sdk/transport`; do not use it.)

Records carry a `floor-*` run id, distinct from the suites' `itest-*`. The
pairing and shortfall arithmetic lives in `shopFloorPlan.ts`, which is pure and
unit-tested — the only part of a populate run that can be checked without a
backend.

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
   clock will move underneath assertions that depend on real elapsed time. For a
   backend that *is* accelerated, use the separate entry point in *Accelerated
   year run* below.

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

## Accelerated year run

A second, separate entry point that builds **a year of financial transactions in
1-6 hours** against a backend whose clock starts one year in the past.

- How to stand that backend up:
  [`ACCELERATED_BACKEND_DEPLOYMENT.md`](./ACCELERATED_BACKEND_DEPLOYMENT.md)
- What the suite asserts and why:
  [`BACKEND_INTERACTION_TEST_SPEC_ACCELERATED.md`](./BACKEND_INTERACTION_TEST_SPEC_ACCELERATED.md)

It is not the same run as `npm run test:integration`, and the two cannot share a
backend: the normal suite aborts when `GET /system/time` answers 200, and the
accelerated suite aborts when it answers 404. That is deliberate — a normal test
that measures real elapsed time is meaningless while the clock is moving 1,460×.

| Command | Collects | Takes |
| --- | --- | --- |
| `npm run test:accelerated:parity` | the harness and A-H suite copies (`src/suites-accelerated/*.accel.itest.ts`, minus the year run) | minutes |
| `npm run test:accelerated` | the parity copies, then `z-year-volume.accel.itest.ts` | 1-6 h |
| `npm run populate:accelerated-year` | the same day runner as a populate run, asserting nothing | 1-6 h |

Run the parity copies first. They fail in minutes on a broken contract instead of
at hour five.

### 1. Get an accelerated backend

The clock lives in the backend, not in the tests, and standing one up is its own
job: the anchors have to be generated once and shared by all 25 JVMs, and a
deployment is spent once its clock converges. On alpha it is a dispatch of the
backend's `Deploy Alpha (Accelerated Clock)` workflow, made immediately before the
run; the window starts at dispatch.

**→ [`ACCELERATED_BACKEND_DEPLOYMENT.md`](./ACCELERATED_BACKEND_DEPLOYMENT.md)** —
the alpha dispatch and how to restart after convergence, the local Compose recipe,
how to verify every service really is on the accelerated clock, and how to put the
environment back afterwards.

The short version, for a local stack:

```bash
cd ~/IdeaProjects/durion-positivity-backend
export POS_TIME_ACCELERATED_REAL_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export POS_TIME_ACCELERATED_VIRTUAL_START=$(date -u -d '1 year ago' +%Y-%m-%dT%H:%M:%SZ)
export POS_TIME_ACCELERATED_SCALE=1460
# ...write docker-compose.accelerated.yml (see the deployment doc), then:
docker compose -f docker-compose.yml -f docker-compose.accelerated.yml up -d
```

Verify before running anything:

```bash
curl -s http://localhost:18080/system/time | jq
# {"virtualTime":"2025-09-18T...","scale":1460,"zone":"UTC",
#  "accelerated":true,"converged":false,
#  "realStart":"2026-09-17T...","virtualStart":"2025-09-17T..."}
```

`accelerated` must be `true`, the anchors must go backwards, and the clock must
still have at least a day left to drive. The run then takes the *smaller* of
`ITEST_ACCEL_DAYS` and what remains — the containers start closing the gap the
moment they boot, so a suite dispatched later has less than was deployed. A clock
with nothing left to drive is refused at setup. A 404 means the profile did not
apply.

### 2. Pick the scale from the time you have

Virtual time is `min(virtualStart + scale × (now − realStart), now)`, so a
one-year gap closes in `G / (scale − 1)` real time:

| scale | real time for the year | real seconds inside a 10 h open window | verdict |
| --- | --- | --- | --- |
| 1,460 | ≈ 6 h | 24.7 | **default** — a job fits in one window; ~2,000 workorders |
| 2,920 | ≈ 3 h | 12.3 | ~2 windows per job |
| 4,380 | ≈ 2 h | 8.2 | ~3 windows per job |
| 8,760 | ≈ 1 h | 4.1 | ~5 windows per job; a few hundred workorders |
| 26,280 | ≈ 20 m | 1.4 | refused — not even two steps fit |

The right-hand column is what matters: throughput is bounded by real event
latency, not by the clock. One full workorder lifecycle is 20-25 gateway calls
plus Kafka replication waits — 15-45 real seconds against alpha through the
tunnel, which is more than a 6-hour run's open window at the faster scales.

So a job is **not** required to finish in one window. It is advanced a step at a
time, keeps its bay and its mechanic overnight, and spans as many open windows as
it needs — a multi-day repair, which is also what keeps every labor call inside
working hours no matter how fast the clock is. A job takes about
`ceil(lifecycle / window)` open days, and with `C` in parallel the run completes
roughly `C / that` jobs per open day.

Global setup checks this before writing anything: it times `/system/time` round
trips, works out whether at least a couple of steps fit in the tightest window,
and **refuses to start** when they do not — printing the measured numbers and the
highest scale that would have worked. It does not spend six hours writing two
invoices, and it does not book a warm-up job to find out, because that would
write a record before the decision was made.

`ITEST_ACCEL_SAMPLE_EVERY=N` works every Nth open day and lets the clock race
through the rest. It is a way to cut API load on a shared alpha, **not** a way to
make a fast scale feasible — working fewer days does not make a day's window any
wider. Carried jobs still advance on the days in between, and the weekly and
monthly scheduled work is still asserted on its due virtual day.

### 3. Hold the lock

Only one accelerated run may write to alpha at a time, and while the accelerated
profile is on **every non-accelerated run is blocked** (their guard aborts on a
200). Take the advisory lock, and put the profile back afterwards.

Global setup takes a **lock file** — `<journal>.lock` by default — before it
writes anything, and releases it on success, on failure, and on Ctrl-C. A second
run on the same machine fails immediately, naming the holder's run id, user, pid
and timeline. A lock whose process is gone is taken over automatically, so a
killed run does not need a hand edit; a lock held by another host never is,
because a pid number there means nothing here.

```bash
# Optional: move the lock off the default path next to the journal.
export ITEST_ACCEL_LOCK_FILE=/tmp/durion-accelerated.lock

# The CI workflow's advisory object. Logged into the run record, NOT enforced by
# this process — a lock file cannot see another machine.
export ITEST_ACCEL_LOCK_URI=s3://durion-alpha-deploy/locks/accelerated.json
```

Cross-machine exclusion is the alpha workflow's `concurrency` group plus whoever
holds that advisory object. Two operators on two laptops are not stopped by a
lock file, so agree the window.

### 4. Run it

```bash
# terminal 1 — the tunnel, left running
./scripts/alpha-itest-tunnel.sh            # PowerShell twin: .\scripts\alpha-itest-tunnel.ps1

# terminal 2 — from the repo root
npm run test:accelerated:parity            # first: minutes
npm run test:accelerated                   # then: the year
```

Same commands against a local Compose stack started with the accelerated
override, with `ITEST_BASE_URL=http://localhost:8080`.

### What a virtual day does

Mechanics clock in when the shop opens and out when it closes. Appointments are
booked a few virtual days ahead and converted when the clock reaches them.
Estimates are lined, totalled and approved or declined; approved ones are
promoted, given a mechanic and a bay or mobile unit, started, worked, completed,
invoiced, and the invoice is paid. Cycle counts land on every 7th virtual day and
restocks on every 30th.

Two rules the run never breaks:

- **No work outside working hours.** Default Mon-Fri 08:00-18:00, Sat
  09:00-13:00, Sun and holidays closed. A job already started may finish up to
  90 virtual minutes past close; nothing new starts after it. **Mobile units are
  exempt** — they take work at any hour, which is what keeps a weekend
  productive instead of idle.
- **No double-booking.** A mechanic, bay, or mobile unit holds at most one open
  workorder. The run claims the pair before it calls `assignTechnician` and
  `assignServicePosition`, so it never asks for a resource it knows is held.
  Each open day starts by reconciling against the dispatch board, so records left
  open by a previous day or run count as occupied.

Out of hours, a closed day still **starts** new mobile jobs as well as finishing
carried ones — otherwise "any hour" would only mean "carried mobile work finishes".
No shift is opened on a closed day, though: a mobile crew turning out on a Sunday is
on call, not on the shop's clock, and a payroll entry there would fail the very audit
that proves the hours rule.

Hours cannot be read back from the API — `LocationResponseDTO` returns no
`operatingHours`, `holidayClosures` or `timezone`, they are write-only on
`patchLocation`. So the suite owns its calendar and, with
`ITEST_ACCEL_PUBLISH_CALENDAR=true` (the default), patches the same hours and
closures onto every site it touches so the backend's own refusals agree with the
gate the tests apply.

### Accelerated environment variables

Every `ITEST_*` variable in *Environment contract* below applies unchanged. The
accelerated entry point adds:

| Variable | Default | Description |
| --- | --- | --- |
| `ITEST_ACCEL_DAYS` | `365` | Virtual days to drive |
| `ITEST_ACCEL_RUN_BUDGET_MS` | `23400000` (6 h 30 m) | Wall-clock ceiling; an overrun aborts with the virtual date and counts reached |
| `ITEST_ACCEL_SAMPLE_EVERY` | `1` | Work every Nth open day; how a faster scale stays feasible |
| `ITEST_ACCEL_CONCURRENCY` | `8` | Parallel jobs, capped by `min(free positions, idle technicians)` per site |
| `ITEST_ACCEL_JOBS_PER_DAY_MIN` / `_MAX` | `4` / `12` | Customers per open day, before the feasibility cap |
| `ITEST_ACCEL_OPEN_TIME` / `_CLOSE_TIME` | `08:00` / `18:00` | Weekday window |
| `ITEST_ACCEL_SATURDAY` | `09:00-13:00` | Saturday window; `closed` to close it |
| `ITEST_ACCEL_SUNDAY` | `closed` | Sunday window |
| `ITEST_ACCEL_HOLIDAYS` | _(US federal set for the covered year)_ | Comma-separated ISO dates the shop is closed |
| `ITEST_ACCEL_PUBLISH_CALENDAR` | `true` | Patch the same hours and closures onto every site touched |
| `ITEST_ACCEL_MOBILE_AFTER_HOURS` | `true` | Mobile units take work at any hour |
| `ITEST_ACCEL_OVERRUN_GRACE_MINUTES` | `90` | Virtual minutes a started job may run past close |
| `ITEST_ACCEL_UNPAID_RATIO` | `0` | Fraction of finalized invoices left unpaid, for AR aging |
| `ITEST_ACCEL_MIN_WORKORDERS` | _(derived)_ | Volume floor; default `0.6 × jobsPerDay × sampledOpenDays` |
| `ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MIN` / `_MAX` | `1` / `5` | How far ahead appointments are booked, in virtual days |
| `ITEST_ACCEL_POLL_MS` | `500` | `/system/time` poll interval |
| `ITEST_ACCEL_MAX_SKEW_MS` | `60000` | How far `virtualTime` may exceed the local wall clock before the run stops trusting it |
| `ITEST_ACCEL_JOURNAL` | `.itest-accel-journal.json` | Run journal path (git-ignored) |
| `ITEST_ACCEL_LOCK_FILE` | _(`<journal>.lock`)_ | Lock file that stops a second run on this machine |
| `ITEST_ACCEL_LOCK_URI` | — | The CI workflow's advisory lock object; logged, not enforced in-process |

### Stopping, resuming, and finding the records

- **Stopping** is safe at any point: records are append-only and the journal
  holds what was written. Ctrl-C releases the lock.
- **Resuming** re-reads `/system/time`, refuses a journal whose `realStart`
  differs (that is a different timeline), picks up at the current virtual day,
  and reconciles open claims from the dispatch board rather than from the journal
  alone.
- **Staffing assignments are back-dated to the run's floor.** pos-shop-manager
  decides a mechanic is present by asking whether an ACTIVE staffing assignment
  covers the booked date, and one written in wall time covers nothing in a
  backend anchored a year back — a fully staffed shop answers
  `MECHANIC_UNAVAILABLE` to every appointment. Setup moves each ACTIVE
  assignment's `effectiveFrom` to a day below `virtualStart`, leaving
  `effectiveTo`, non-ACTIVE rows and anything already effective alone, so a
  re-run writes nothing. This is the staffing twin of the role back-dating
  above; the platform declined to special-case the dates and was right to
  (durion-positivity-backend#2140).
- **A journal that recorded nothing is not resumed, and its runId is dropped.**
  An attempt that died before its first virtual day still created the suites'
  fixtures — a bay, a bin, vehicles — all named or seeded from its runId and none
  of them journaled. A run that inherited that runId regenerated the same names
  and the same VIN stream and failed every suite on `DUPLICATE_NAME`, `CONFLICT`
  and `VEHICLE_VIN_CONFLICT`. The next run now keeps its own id and says which one
  it declined to wear. A journal carrying a workorder or invoice id is resumed as
  before: that work has to stay one retrievable set.
- **The run ends** on `converged: true` — the clock has caught up to wall time
  and any further write would be dated today. Finishing the configured day count
  at convergence is a pass; hitting it early fails and names the day.
- **Finding the records** afterwards: every entity carries the run's `runId`
  marker, so `GET /v1/workorders/search?q=<runId>` returns the run's workorders,
  and their virtual dates are on them.
- **Afterwards, put the profile back.** Redeploy without `accelerated` and
  confirm with `npm run test:integration` — its guard passing is the proof the
  profile is off.


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
