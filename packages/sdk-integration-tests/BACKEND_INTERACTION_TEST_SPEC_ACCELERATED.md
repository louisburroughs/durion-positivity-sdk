# Backend Interaction Test Specification (Accelerated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** produce **a year of real financial transactions in one sitting**.
The backend is deployed with an injected clock whose virtual start is one year
in the past; the suite then drives 365 virtual days of shop activity in **1-6
hours of real time** and asserts each step, so the result is both a populated
year of history and a passing test run.

A virtual day is a shop day, not a script:

- mechanics clock in when the shop opens and clock out when it closes;
- appointments are booked, arrive, and become estimates;
- estimates are lined, totalled, approved or declined, and promoted;
- workorders get a mechanic and a bay or mobile unit, start, run their labor
  and parts, and are completed;
- completed workorders are invoiced, the invoice is finalized, and the invoice
  is paid;
- weekly cycle counts and monthly restocks land on their due virtual days.

Two rules constrain all of it, and they are the reason this suite needs a clock
and a timer rather than a loop:

1. **Nobody works outside working hours.** No labor-bearing call is made
   outside the site's open window, on a weekend, or on a holiday — *except*
   mobile units, which take work at any hour.
2. **No resource is double-booked.** A mechanic, a bay, or a mobile unit holds
   at most one open workorder at a time. The backend should refuse a
   double-booking; this suite does not test that refusal, it declines to ask.

**Behavioral parity:** the accelerated suites are **copies** of the
non-accelerated suites in `src/suites`, with real-date arithmetic replaced by
virtual-date arithmetic and every labor-bearing step passed through the
calendar gate. Parity is a copy-and-substitute exercise with an enumerated
substitution list (Task A6), not a rewrite.

**Target environment:** the **alpha** stack on EC2 with the `accelerated`
profile enabled, against the persistent alpha PostgreSQL. Test runs write real
records that remain in the alpha database afterward — that persistence is the
deliverable. Only one accelerated run may write to alpha at a time, enforced by
an execution lock (Task A11).

**Execution model:** the suite runs from the developer's laptop over the
existing AWS SSM port-forwarding tunnel, or from the guarded alpha workflow. No
public ingress is added. `ITEST_BASE_URL` points at the forwarded gateway and
authoritative virtual time is read from `GET /system/time` — never derived from
`Date.now()`.

**Component:** the existing private workspace package,
`packages/sdk-integration-tests`. The accelerated work adds a second Jest entry
point, a `src/suites-accelerated/` tree, and four harness modules. It **forks no
shared code**: builders, `http`, `personas`, `waitFor`, `ItestConfig`,
`StarterActivation`, `TenantPreflight`, and `PersonaBootstrap` are imported as
they are.

**Tech stack:** Jest 29 + ts-jest, TypeScript, Node 22, the `@durion-sdk/*`
workspace packages, and the seeder's bootstrap fixtures as a library.

---

## Relationship to the Accelerated Seeder

`BACKEND_INTERACTION_TEST_SPEC.md` is the coverage baseline and the copy source.
`packages/sdk-seeder` is the behavioral reference for the year loop, and
`packages/sdk-seeder/ACCELERATED_CLOCK_ALPHA_PLAN.md` is the reference for the
clock itself.

The seeder is a *generator*: it drives the same endpoints but tolerates and logs
most failures so a year-long run survives. This suite is a *verifier*: each step
asserts its response, and a failed step fails the test. The mapping:

| Seeder source | This suite |
| --- | --- |
| `loop/DailyLoopRunner.ts` | `AcceleratedDayRunner` (Task A5), with calendar gating, a resource ledger, and per-day assertions the seeder has none of |
| `loop/ShiftSimulator.ts` | Clock-in at open / clock-out at close as asserted steps, driven by the calendar rather than by loop position |
| `loop/CustomerEventSimulator.ts` | Suites B, C and the year run: estimate → workorder → assignment → completion → invoice → payment |
| `loop/InventoryMaintenanceSimulator.ts` | Suites D and E on their due virtual days |
| `support/VirtualClock.ts` | Ported to `harness/virtualClock.ts` (Task A2) and given the validation, convergence and skew rules the seeder's copy has no need for |
| `bootstrap/*` | Reused verbatim as global test fixtures |
| Appointments | **Not in the seeder at all.** Suite A adds them, and the accelerated copy is the only place the full book → arrive → convert path is exercised, because only a virtual clock makes an appointment's own start time arrive inside a test run |

What the seeder does *not* answer, and this spec must:

- The seeder works every virtual day at whatever hour the loop reaches. This
  suite works only inside the open window, so the day loop is driven by the
  clock, not by iteration count.
- The seeder takes whatever bay answers first and logs a 409. This suite claims
  resources up front and never issues a call it knows would conflict.
- The seeder's per-day work is unbounded, so a fast scale silently drops work
  past midnight. This suite computes a per-day budget from the observed scale
  and refuses to start when the budget is below one job (Task A3).

---

## The Accelerated Clock Contract

The clock is injected **into the backend**, not into the tests. Every
accelerated backend JVM gets the same anchors, generated once immediately
before deployment, with `virtual-start` exactly one year before `real-start`:

```properties
spring.profiles.include=accelerated
pos.time.accelerated.scale=1460
pos.time.accelerated.zone=UTC
pos.time.accelerated.real-start=2026-09-17T12:00:00Z
pos.time.accelerated.virtual-start=2025-09-17T12:00:00Z
pos.time.accelerated.converge=true
```

Virtual time is `virtual(t) = min(virtualStart + scale * (now - realStart), now)`
— it converges on wall time and then ticks at scale 1 forever.

`GET /system/time` is the only source of virtual time the suite may read:

```json
{
  "virtualTime": "2025-11-03T08:30:00Z",
  "scale": 1460.0,
  "zone": "UTC",
  "accelerated": true,
  "converged": false,
  "realStart": "2026-09-17T12:00:00Z",
  "virtualStart": "2025-09-17T12:00:00Z"
}
```

Rules the harness enforces:

- A 404 or a non-200 from `/system/time` fails global setup: the backend is on
  the normal clock and this is the wrong entry point. **This is the exact
  inverse of the non-accelerated guard** in `harness/acceleratedClock.ts`, which
  aborts on a 200.
- `accelerated` must be `true`, `scale` must be finite and `> 1`, `zone` must
  parse as an IANA zone, and `realStart`/`virtualStart` must both parse.
- `virtualStart` must precede `realStart`, and at least one virtual day must still
  be drivable. The length is not checked: the deploy workflow anchors the pair from
  its `days` input (durion-positivity-backend#2136) and the clock has been closing
  the gap since the containers booted, so what was deployed and what is left are
  different numbers. The run drives `min(ITEST_ACCEL_DAYS, remaining)` and logs when
  it clamps, so the deliverable is the history of the run that was actually
  drivable. A clock with nothing left produces no run at all and is refused.
- `virtualTime` must be `>= virtualStart` and must never exceed the local wall
  clock by more than `ITEST_ACCEL_MAX_SKEW_MS`. Beyond that the JVMs disagree
  with each other or with the laptop, and virtual dates on records would be
  untrustworthy.
- `converged: true` **ends the run**: the year is spent, the clock is wall time,
  and any further writes would be dated today. The run reports the virtual date
  it reached and stops writing. Reaching convergence with the configured day
  count complete is a pass; reaching it early is a failure that names the day.
- Virtual-time waits go through `VirtualTimer` (Task A2) only. A fixed sleep is
  never a substitute for a clock read.

---

## Run Budget, Scale, and Feasibility

This is the part the seeder never had to answer, and getting it wrong is how an
accelerated run silently produces a tenth of the history it claims.

A one-year gap `G` closes in `G / (scale - 1)` real time, because wall time
advances during catch-up:

| scale  | real time for the year | real seconds per virtual day | real seconds inside a 10 h open window |
| ------ | ---------------------- | ---------------------------- | -------------------------------------- |
| 1,460  | ≈ 6 h 0 m              | 59.2                         | 24.7                                   |
| 2,920  | ≈ 3 h 0 m              | 29.6                         | 12.3                                   |
| 4,380  | ≈ 2 h 0 m              | 19.7                         | 8.2                                    |
| 8,760  | ≈ 1 h 0 m              | 9.9                          | 4.1                                    |
| 26,280 | ≈ 20 m                 | 3.3                          | 1.4                                    |

The right-hand column is the constraint. **Throughput is bounded by real event
latency, not by the virtual clock.** One full lifecycle — customer, vehicle,
estimate, lines, totals, submit, approve, promote, approve workorder, assign
technician, assign position, start, timers, item completion, complete, invoice,
finalize, pay — is roughly 20-25 gateway calls plus Kafka replication waits:
call it `L` real seconds, measured, typically 15-45 s against alpha through the
tunnel.

The naive response — insist a job finish inside one open window — does not
survive contact with the numbers: at scale 8,760 no lifecycle fits in 4.1
seconds, and sampling does not help, because working fewer days does not make a
day's window any wider. **Sampling is not a feasibility lever.** It only thins
intake.

What does work is **slicing**. A job is advanced one step at a time and spans as
many open windows as it needs, keeping its bay and its mechanic overnight. That
is what a multi-day repair looks like, it is why the resource ledger has to carry
holds across day boundaries, and it is what keeps every labor call inside working
hours at any scale. So:

- **Concurrency is mandatory.** `C` jobs run in parallel, one per claimed
  position. A job occupies its slot for `openWindowsPerJob = ceil(L /
  openRealSeconds)` open days, so the per-day completion rate is
  `jobsPerDay = floor(C / openWindowsPerJob)`.
- **A feasibility guard runs before day 1** (Task A3), and what it requires is
  only that a *few steps* fit in a window: `openRealSeconds >= stepLatency ×
  MIN_STEPS_PER_WINDOW` (2). Below that a job advances less than once per virtual
  day and the run is a very slow way of writing nothing.
- **The guard measures rather than assumes, and measures without writing.** It
  times five `/system/time` round trips, takes the slowest, and multiplies it up
  to a step and a lifecycle estimate. Deliberately *not* a warm-up workorder: a
  warm-up job would write a record before the guard had decided whether the run
  should write anything, which is the outcome the guard exists to prevent. The
  multiplier is what stands in for the cross-service replication waits a clock
  read cannot see.
- **Scale 1,460 (≈6 h) is the supported default** for a full-density year. At
  `L = 20 s` and `C = 8` a job fits in one window: about 2,000 workorders across
  ~250 open days, which is a plausible year for a multi-bay site.
- **Scale 8,760 (≈1 h) works by slicing**: a job takes about 5 open windows, so
  `C = 8` completes roughly one job per open day — a few hundred workorders
  spanning the same year. Thinner, still a year.
- **The run is refused** when the guard fails, with the measured numbers and the
  highest scale that would have passed. `ADVISORY_SCALE_CEILING` (8,760) is the
  documented comfortable maximum; past it the guard, not the constant, decides.
- **Sampling** (`ITEST_ACCEL_SAMPLE_EVERY=N`) works every Nth open day and lets
  the clock race through the rest, to cut API load on a shared alpha. Carried
  jobs are still advanced on the days in between, and weekly and monthly
  scheduled work is still asserted on its due virtual day.

`ITEST_ACCEL_RUN_BUDGET_MS` (default 6 h 30 m) is a wall-clock ceiling. Passing
it aborts the run with the virtual date reached and the counts written so far —
a budget overrun is a failure with evidence, not a hang.

---

## The Shop Calendar: When Work May Happen

`GET /v1/locations/{id}` does **not** return `operatingHours`, `holidayClosures`
or `timezone` — `LocationResponseDTO` carries neither. The hours are write-only
on the API surface (`createLocation` and `patchLocation` accept them). So the
calendar cannot be discovered; the suite **owns** it and **publishes** it.

`harness/shopCalendar.ts` (Task A4) is pure: no SDK, no clients, no clock. It
takes a configured calendar and answers questions about an instant.

- `openWindow(dayOfWeek)` → `{ openTime, closeTime }` or closed.
  Default Mon-Fri 08:00-18:00, Sat 09:00-13:00, Sun closed.
- `holidays` — a set of virtual dates. Default: the US federal set for the
  covered year, resolved from `virtualStart`. `ITEST_ACCEL_HOLIDAYS` overrides
  it with a comma-separated ISO list.
- `isOpen(instant, kind)` → `true` for `MOBILE_UNIT` **always**, and for `BAY`
  only inside the window on a non-holiday working day.
- `nextOpen(instant, kind)` → the next instant work may start; for a mobile unit
  that is `instant` itself.
- `closesAt(instant)` → the close boundary of the window `instant` falls in, or
  `null` when the position kind is unbounded.

Publishing (`ITEST_ACCEL_PUBLISH_CALENDAR`, default `true`): global setup
`patchLocation`s the same `operatingHours` and `holidayClosures` onto every site
the run will touch, so the backend's own scheduling refusals agree with the gate
the tests apply. With publishing off the suite still gates itself but records in
its log that the backend was not told.

Gating rules, stated once so every suite copy can cite them:

- **Labor-bearing steps are gated**: `startWorkSession` / `stopWorkSession`
  (payroll), `startWorkorder`, timer start/stop, item completion, and
  `completeWorkorder`.
- **Advisor and back-office steps on a bay job are gated too** — estimate
  creation and approval, promotion, invoice generation, finalization, payment —
  because a service advisor is not at the desk at 03:00 on a Sunday. This is an
  assumption the spec makes deliberately, not a backend constraint.
- **A mobile-unit job is ungated end to end**, paperwork included: the crew
  carries its own. This is what keeps a closed window productive instead of
  idle, and it is why `ITEST_ACCEL_MOBILE_AFTER_HOURS` defaults to `true`.
  Out of hours and on closed days the runner **starts** new mobile jobs, not merely
  advances carried ones. No shift is opened on a closed day: a payroll entry there
  would sit outside the shop's hours and fail the end-of-run audit, so a weekend
  mobile crew is on call rather than on the clock.
- **Maintenance is floor work** and runs only on worked open days.
- **Every time bound comes from one clock reading**, derived together by
  `harness/daySchedule.ts` — `dayEnd`, `opensAt`, `closesAt`, `workBound`,
  `graceWorkBound`, `graceLimit` — and re-derived after anything that costs virtual
  time (the wait for opening, the shift and appointment phases). This is structural
  rather than stylistic: four remediation cycles each fixed a bound computed at the
  wrong instant and each produced the next instance, because bounds computed one at a
  time where they are used can disagree with each other. A whole set derived at once
  cannot. The schedule also says up front whether the day is workable, so "the window
  had already closed by the time work started" is a reported failure rather than a
  successful day with nothing in it.
- **The in-hours work loop is bounded at bay close**, and
  `ITEST_ACCEL_OVERRUN_GRACE_MINUTES` (default 90) is the margin that keeps the
  overshoot legal rather than a second working window.
- **A loop refuses a step it predicts would cross its bound.** A bound checked only
  *between* steps is a bound exceeded *by* a step, and at a thousandfold scale one step
  can be virtual hours — the feasibility guard admits steps larger than the whole grace.
  Each loop therefore records what steps actually cost and stops before starting one that
  would not fit, rather than after overshooting.
- **A job already started finishes inside the grace, on the clock.** That stretch gets
  *half* the grace and runs before clock-out, so the labor and the payroll entry agree
  about who was working, and the remaining half covers the overshooting tick and the
  clock-out fan-out. It runs whatever `ITEST_ACCEL_MOBILE_AFTER_HOURS` says — the grace
  belongs to the mechanic finishing a car, not to the mobile flag. No *new* bay work
  starts after close, and a job still open at the grace end is carried to the next open
  day, because the car stays in the shop overnight.
- **The shift fan-out is parallel, and that is load-bearing.** The backend stamps each
  `endAtUtc` when its own `stopWorkSession` runs, so clocking people out one at a time
  puts the last entry N gateway calls past the first. At scale 4,380 that is ~15 virtual
  minutes per call: ten people sequentially is 146 minutes, past the grace, and the
  payroll audit fails on the tail for a run that did nothing wrong. In parallel the whole
  fan-out costs about one call.
- **Bounds are derived from a clock read taken after the shift and appointment
  phases.** Those are gateway calls, and at a thousandfold scale a handful of them is
  virtual hours; a bound taken before them can already be in the past. A day whose
  window has closed by the time work is due to start reports a failure rather than a
  successful day with nothing in it.
- **The shift must end strictly inside the grace.** `withinGrace` is strict, so the
  grace end itself is illegal, and this cannot be fixed at the call site: the shift
  port's `clockOut` takes no instant, and the backend stamps `endAtUtc` from its own
  clock when `stopWorkSession` runs. Exiting the loop at close is therefore the only
  thing that actually keeps the payroll entry legal.
- **The after-hours mobile stretch runs after the shift is closed**, so nobody is on
  the clock for it — the same reason no shift is opened on a closed day.
- **A day whose open window was already missed** when the clock reached it (a wait that
  overshot) opens no shift at all and is reported as `window-missed`. Clocking in there
  would stamp a start outside the window.
- **A day boundary may arrive mid-request.** Every scenario records the virtual
  instant it observed before a transition and asserts the date the *backend*
  used, never the date the test started with.

---

## Resource Discipline: No Double-Booking

`harness/resourceLedger.ts` (Task A4) is pure, and it is the only thing allowed
to hand out a resource.

- A **claim** covers one `{ technicianId, positionId }` pair and is taken
  *before* the first assign call. A claim on a held resource is not issued —
  the job waits for a free slot instead of asking the backend and taking a 409.
- A claim is **released** when the workorder closes, and on any failure path.
  The orphaned-technician release that `runs/shopFloorLoad.ts` already performs
  is the model: a technician assigned to a workorder that never got a position
  reads as busy to the next day's discovery until someone unpicks it by hand.
- **Day-start reconciliation**: every open day begins by reading each site's
  dispatch board (`getDispatchDashboard`) and people availability, through the
  existing pure `buildRoster` / `busyTechnicianIds` in `runs/shopFloorRoster.ts`.
  Anything the board reports as occupied — including records left open by a
  previous day, a previous run, or the seeder — starts the day claimed.
  `dataQualityWarning` skips the site for that day, for the reason `buildRoster`
  already gives: placing work on a board that may be incomplete is how a double
  booking happens.
- **Interleaving by kind** is reused from `runs/shopFloorPlan.ts`
  (`interleaveByKind`): a technician shortfall is shared between bays and mobile
  units instead of leaving every mobile unit idle at exactly the short sites.
- **Concurrency** is `min(free positions, idle technicians)` per site, capped by
  `ITEST_ACCEL_CONCURRENCY` (default 8). One worker holds exactly one claim.
- **Per-day assertions**: no resource appears in two concurrent claims; every
  claim taken is released by end of day or explicitly carried as work in
  progress; and the day-end board reports at most one open workorder per bay or
  unit.

---

## The Virtual Day: Activity Script

One open virtual day, in order. Each phase is asserted; a failed assertion fails
the run and names the virtual date.

| Phase | Actions | Persona |
| --- | --- | --- |
| **WAIT-OPEN** | `VirtualTimer.waitUntil(calendar.nextOpen(now, 'BAY'))`. Weekends and holidays pass here; mobile work may run meanwhile. | — |
| **RECONCILE** | Read dispatch board + people availability per site; seed the ledger from what is already occupied. | manager, admin |
| **SHIFT-IN** | `startWorkSession` for every mechanic the day will use, plus advisor / manager / parts. Assert a session id per person and that the session's recorded start falls inside the open window. | admin |
| **APPOINTMENTS** | Book 1-3 appointments per site for 1-5 virtual days ahead, inside a future open window. Convert every appointment whose start the clock has now reached into an estimate through the A-suite bridge, and assert the bridge is idempotent. | advisor |
| **ESTIMATES** | Per job: customer (new or repeat from the pool), vehicle, draft estimate, 2-4 labor lines, 0-2 part lines, totals, submit. Then the customer decision — approve ~78 %, decline ~14 %, ignore the rest, matching the seeder's distribution. | advisor |
| **PROMOTE** | Promote approved estimates; manager approves the resulting workorder. | advisor, manager |
| **ASSIGN** | Claim a `{ technician, position }` pair from the ledger, then `assignTechnician` and `assignServicePosition` in that order — the backend needs both before a start (backend #2011, #2010). Mobile-unit claims may be made in a closed window. | manager |
| **EXECUTE** | `startWorkorder`, per-service timer start/stop, item completion, `completeWorkorder`. Labor durations are asserted in **virtual** minutes. | tech |
| **INVOICE** | `generateWorkorderInvoice`, then `finalizeInvoice`; assert a total greater than zero and an invoice dated inside the virtual day. | advisor |
| **PAYMENT** | `submitAccountingEvent` with `INVOICE_PAYMENT` for the finalized total; assert the invoice reaches a paid state. `ITEST_ACCEL_UNPAID_RATIO` (default `0`) leaves a fraction unpaid when AR aging is wanted. | controller, acct |
| **RELEASE** | Release every claim; carry anything still open as work in progress. | manager |
| **SHIFT-OUT** | `stopWorkSession` for everyone clocked in, then submit and approve the day's time entries. Assert the recorded span sits inside the open window plus grace. | admin, manager |
| **MAINTENANCE** | Virtual day-of-year `% 7 == 0`: cycle count (Suite E path). `% 30 == 0`: monthly restock (Suite D path). Assert neither fires on an adjacent non-due day. | parts |
| **CLOSE** | Journal the day: virtual date, counts, claims, ids. Then `waitUntil(next open day)`. | — |

Mobile-unit jobs run on the same script with the calendar gate disabled, and are
the only work permitted in a WAIT-OPEN stretch.

---

## Financial Volume Targets

The run's purpose is a ledger, so the ledger is asserted. At the end of the run,
scoped by `runId`:

- **Invoices**: one finalized invoice per completed workorder, none with a zero
  or negative total.
- **Payments**: `(1 - ITEST_ACCEL_UNPAID_RATIO)` of finalized invoices reach a
  paid state; each payment amount equals its invoice total.
- **Spread**: invoices exist in at least 11 of the 12 virtual months the run
  covers, and none is dated outside `[virtualStart, virtualTime at run end]`.
- **Calendar compliance**: no labor session, timer, or bay-job invoice carries a
  backend timestamp outside an open window plus grace — this is the assertion
  that proves rule 1 held, and it is checked against persisted timestamps rather
  than against what the test intended.
- **Resource compliance**: no bay or mobile unit ever held two open workorders
  at the same virtual instant, and no technician did either.
- **Minimum volume**: the run fails if it wrote fewer than
  `ITEST_ACCEL_MIN_WORKORDERS` (default: `0.6 × jobsPerDay × sampledOpenDays`).
  A run that technically passed every step while producing almost nothing is the
  failure mode this catches.

---

## Test Framework Layout

```
packages/sdk-integration-tests/
  jest.integration.config.js        # existing: *.itest.ts, normal clock
  jest.accelerated.config.js        # NEW: *.accel.itest.ts, accelerated clock
  src/harness/                      # shared, unforked
    virtualClock.ts                 # NEW  /system/time adapter + validation
    virtualTimer.ts                 # NEW  waitUntil / waitForNextDay, bounded
    shopCalendar.ts                 # NEW  pure: hours, holidays, gate
    resourceLedger.ts               # NEW  pure: claims, no double-booking
    acceleratedConfig.ts            # NEW  ITEST_ACCEL_* parsing + validation
    acceleratedGlobalSetup.ts       # NEW  inverse clock guard, lock, calendar publish, feasibility
    acceleratedJournal.ts           # NEW  run journal for restart/resume
    acceleratedClock.ts             # existing: the non-accelerated guard, unchanged
    ... everything else unchanged and reused ...
  src/suites-accelerated/
    00-harness.accel.itest.ts       # copy + clock/calendar/ledger fixtures
    a-appointments.accel.itest.ts   # copy + virtual windows + arrival
    b-estimates.accel.itest.ts      # copy
    c-workorder-execution.accel.itest.ts  # copy + virtual durations
    d-receiving.accel.itest.ts      # copy
    e-cycle-count.accel.itest.ts    # copy + day-7 scheduling
    f-time-reporting.accel.itest.ts # copy + shift boundaries
    h-service-position.accel.itest.ts     # copy + occupancy across a boundary
    z-year-volume.accel.itest.ts    # NEW: the 365-day run and its ledger assertions
  src/runs/
    acceleratedYear.ts              # NEW: the same day runner as a populate run
```

`src/suites-accelerated/*.accel.itest.ts` run **before** `z-year-volume`, so a
broken contract fails in minutes instead of at hour five. That order is enforced
by `jest.accelerated.sequencer.js`, not by the file names: Jest orders by
recorded duration, slowest first, and once it had a timing cache it put the
5.6-hour year at the head, ending the accelerated clock before any other suite
ran. `z-year-volume` carries its own `testTimeout`
of `ITEST_ACCEL_RUN_BUDGET_MS`.

---

## Build Plan

### Task A1: Deploy an accelerated backend anchored one year back

**Procedure: [`ACCELERATED_BACKEND_DEPLOYMENT.md`](./ACCELERATED_BACKEND_DEPLOYMENT.md).**
The clock, its validation and `GET /system/time` are already implemented in the
backend (`pos-events` `AcceleratedTimeProperties` / `ScaledClock`, `pos-api-gateway`
`SystemTimeController`). The alpha deploy path landed in
[durion-positivity-backend#2066](https://github.com/louisburroughs/durion-positivity-backend/pull/2066)
(closes [#2065](https://github.com/louisburroughs/durion-positivity-backend/issues/2065)):
a checksummed compose override, `ACCELERATED=true` in `deploy-backend.sh`, and the
`Deploy Alpha (Accelerated Clock)` workflow, which generates the anchors in CI at
dispatch and verifies every JVM on the box. The local Compose path remains for runs
off alpha. A deployment is single-use: once its clock converges, the restart is a
fresh dispatch.

- [ ] Generate the anchors immediately before deployment, `virtual-start` =
  `real-start` minus one year, UTC, and pass them to every backend JVM
  (`POS_TIME_ACCELERATED_REAL_START`, `_VIRTUAL_START`, `_SCALE`, `_ZONE`,
  `_CONVERGE=true`). Reference: `sdk-seeder/ACCELERATED_CLOCK_ALPHA_PLAN.md`
  Tasks 1-7.
- [ ] Verify `GET /system/time` returns `accelerated: true`, the expected
  anchors, and a `virtualTime` advancing at `scale` virtual seconds per real
  second across at least two representative services.
- [ ] Record the anchors and the scale in the run log. They are the run's
  identity: two runs against the same `realStart` are the same timeline.

### Task A2: Virtual clock and virtual timer

- [x] `harness/virtualClock.ts`: port `sdk-seeder/src/support/VirtualClock.ts`
  and add the validation from *The Accelerated Clock Contract* — 404 is a
  failure here, `accelerated`/`scale`/`zone`/anchors are checked, the one-year
  gap is checked, skew against the local wall clock is checked, `converged` is
  surfaced.
- [x] `harness/virtualTimer.ts`: `waitUntil(virtualInstant)`,
  `waitForNextDay(from)`, `remainingRealMs(untilVirtualInstant, scale)`. All
  bounded, all polling `/system/time` at `ITEST_ACCEL_POLL_MS`; a deadline
  overrun throws with both the target and the observed virtual time.
- [x] Unit tests with a faked `fetch`: valid response, 404, 5xx, malformed JSON,
  `accelerated: false`, `scale <= 1`, invalid zone, sub-year anchor gap,
  excessive skew, convergence mid-wait, and a day boundary crossed while
  waiting.

### Task A3: Accelerated config and feasibility guard

- [x] `harness/acceleratedConfig.ts`: parse and validate every `ITEST_ACCEL_*`
  variable in *Environment Contract (Accelerated)*, with the same fail-fast,
  single-message style as `ItestConfig`.
- [x] Compute `openRealSeconds` from the observed `scale` and the calendar's
  *tightest* window, measure step latency from `/system/time` round trips without
  writing anything, derive `openWindowsPerJob` and `jobsPerDay`, and refuse to
  start when fewer than `MIN_STEPS_PER_WINDOW` steps fit — with the measured
  numbers and the highest workable scale in the message.
- [x] Unit-test the arithmetic and every refusal.

  **Corrected during implementation.** The first draft of this task said to
  measure with a warm-up job and to let sampling rescue a fast scale. Both were
  wrong: a warm-up job writes before the guard has decided anything, and working
  fewer days does not widen a day's window. See *Run Budget, Scale, and
  Feasibility* above for the slicing model that replaced it.

### Task A4: Shop calendar and resource ledger (both pure)

- [x] `harness/shopCalendar.ts` per *The Shop Calendar*. Unit tests: weekday
  inside/outside the window, Saturday's short window, Sunday, a holiday, a
  `MOBILE_UNIT` at every one of those instants, `nextOpen` across a weekend and
  across a holiday-adjacent weekend, DST-free UTC arithmetic, and `closesAt`.
- [x] `harness/resourceLedger.ts` per *Resource Discipline*. Unit tests: claim,
  double-claim refused, release, release of an unheld resource, reconciliation
  from a board that reports occupancy, a claim while every resource is held,
  carry-over across a day boundary, and the interaction with
  `interleaveByKind`.
- [x] Neither module imports an SDK client, a clock, or `Date.now()`.

### Task A5: Accelerated global setup and day runner

- [x] `harness/acceleratedGlobalSetup.ts`: load env file → `ItestConfig` +
  `acceleratedConfig` → assert the accelerated clock → acquire the execution
  lock (Task A11) → security bootstrap, starter activation, tenant preflight,
  persona preflight, reference bootstrap (all reused verbatim from
  `globalSetup.ts`) → publish the calendar → warm-up job and feasibility guard →
  save context including the observed clock anchors → release the lock on both
  success and failure.
- [x] `AcceleratedDayRunner`: one open virtual day per *The Virtual Day*, with
  the concurrency pool, the ledger, and the calendar gate. Injectable clock,
  calendar and ledger so the phase ordering is unit-testable without a backend.
- [x] Unit-test: a closed day is skipped without work, a weekend is waited
  through, mobile work proceeds in a closed window, the grace period bounds an
  overrunning job, a job past grace is carried, and a mid-request day boundary
  is recorded rather than assumed.

### Task A6: Copy suites A-H, with the substitution list

Copy each `src/suites/X.itest.ts` to `src/suites-accelerated/X.accel.itest.ts`
and apply exactly these substitutions. Anything else is a rewrite and is out of
scope for this task.

| In the copy | Replace with |
| --- | --- |
| `new Date()` / `Date.now()` for a business instant | `await clock.now()` |
| Suite A's `window(offsetMinutes, …)` built on tomorrow 09:00 real | a virtual window inside a future open day, from `calendar.nextOpen(virtualNow + lead)` |
| the fixed real slot spread (`randomOffsetMinutes` over ~140 real days) | a spread over future **open** virtual days |
| Suite C's three 1.5 s real sleeps for a non-zero duration | a virtual-minute duration assertion — one real second is `scale` virtual seconds, so the duration is already non-zero; assert it in virtual minutes and assert it against the backend's own timestamps |
| bare `assignTechnician` / `assignServicePosition` | a ledger claim first, then the same two calls in the same order |
| any labor-bearing step | the same step behind `calendar.isOpen(virtualNow, kind)` |
| `assertNonAcceleratedBackend` | `assertAcceleratedBackend` |
| real-date assertions on persisted timestamps | virtual-date assertions, tolerant of a boundary crossed mid-request |

- [x] Copy and substitute all eight suites.
- [x] Keep every role negative and every authorization assertion unchanged: both
  single-credential and role mode remain supported.
- [x] Each copy exercises at least one virtual-day boundary, and
  `h-service-position` holds a position across one.
- [x] No shared harness module is forked to make a copy pass. If a copy needs a
  change in shared code, change the shared code and keep the non-accelerated
  suite green.

### Task A7: The year run — `z-year-volume.accel.itest.ts`

- [x] Drive `ITEST_ACCEL_DAYS` (default 365) virtual days through
  `AcceleratedDayRunner`, respecting `ITEST_ACCEL_SAMPLE_EVERY`.
- [x] Assert per day: mechanics clocked in and out, every claim released or
  carried, no double-booking, at least one workorder completed on a sampled open
  day, and every completed workorder invoiced and paid.
- [x] Assert the weekly cycle count on each virtual day-of-year multiple of 7
  and the monthly restock on each multiple of 30 — and that neither fires on the
  adjacent days.
- [x] Assert the end-of-run ledger per *Financial Volume Targets*, including the
  minimum-volume floor and the calendar-compliance check against persisted
  timestamps.
- [x] Stop cleanly on `converged: true` or on `ITEST_ACCEL_RUN_BUDGET_MS`,
  reporting the virtual date reached and the counts written.

### Task A8: Restart and resume

- [x] `harness/acceleratedJournal.ts`: append-only JSON journal of `runId`,
  observed anchors, per-day counts, open claims, and created ids. Path from
  `ITEST_ACCEL_JOURNAL`; git-ignored.
- [x] A restart re-reads `/system/time`, refuses a journal whose `realStart`
  differs (a different timeline), resumes at the current virtual day, and
  reconciles open claims from the dispatch board rather than from the journal
  alone.
- [x] Idempotent bootstrap data is not duplicated and no virtual day is silently
  skipped: the journal records skipped days with the reason.
- [x] Unit-test resume, timeline mismatch, a journal ahead of the clock, and a
  corrupt journal.

### Task A9: Jest entry point and scripts

- [x] `jest.accelerated.config.js`: `testMatch: ['**/*.accel.itest.ts']`,
  `maxWorkers: 1`, `globalSetup: acceleratedGlobalSetup.ts`, the same
  `moduleNameMapper` and `moduleFileExtensions` as the integration config,
  `passWithNoTests: false`.
- [x] Root scripts: `test:accelerated` (whole accelerated suite),
  `test:accelerated:parity` (the A-H copies only, `--testPathIgnorePatterns
  z-year-volume`), and `populate:accelerated-year` for `src/runs/acceleratedYear.ts`.
- [x] `npm test` still collects zero `*.accel.itest.ts`, and
  `npm run test:integration` still collects zero of them either — verified by
  `jest --listTests`.

### Task A10: The non-accelerated guard stays correct

- [x] `assertNonAcceleratedBackend` keeps aborting the normal suite on a 200,
  unchanged. The two guards are inverses and both are unit-tested.
- [x] `runs/shopFloorLoad.ts` keeps its non-accelerated guard: a floor load on
  an accelerated backend would place work at a virtual instant it never checked.

### Task A11: Execution lock — one accelerated run at a time

- [x] `harness/acceleratedLock.ts`: a lock file, taken by global setup as soon as
  the timeline is known and before anything is written. It records the holder's
  run id, pid, host, user and `realStart`; fails naming them when held; releases
  on success, on failure, on the feasibility refusal, and on exit / SIGINT /
  SIGTERM. A lock whose process is gone is taken over; one held by another host
  never is, because a pid number there means nothing here. Unit-tested, including
  the takeover and the release races.
- [x] Documented that the accelerated profile is not the normal alpha state and
  that leaving it on blocks every non-accelerated run (their guard aborts on a
  200), and that the profile must be put back afterwards.
- [x] **Deployment-side, built in backend #2066.** The alpha workflow's
  `concurrency` group: `Deploy Alpha (Accelerated Clock)` shares `alpha-deploy`
  with `Build and Push to ECR` and `Sync Alpha Config`, so no two dispatches
  interleave on the box.
- [ ] **Not built — deployment-side.** The SSM run script's advisory S3 object
  holding the anchors, the `runId` and the operator; #2066 did not add one.
  `ITEST_ACCEL_LOCK_URI` names that object and is
  logged into the run record, but **this process does not enforce it**: a lock
  file cannot see another machine, and claiming otherwise would be worse than
  saying so. Two operators on two laptops are stopped by the workflow and by
  agreement, not by this code.

### Task A12: Documentation

- [ ] `README.md` gains an *Accelerated year run* section: prerequisites, how
  the clock is injected, the scale/budget table, the commands, what the run
  writes, how to find its records afterwards, and how to stop it.
- [x] `.env.itest.example` gains every `ITEST_ACCEL_*` variable with its
  default.
- [x] `ACCELERATED_BACKEND_DEPLOYMENT.md` covers standing the backend up: the
  clock contract, the scale table, the verified local Compose override, the alpha
  dispatch and its restart after convergence, verification, teardown and
  troubleshooting. Its own document
  rather than a README section, because the answer is not one command.
- [ ] This spec's completion criteria are checked off against a real run, with
  the observed scale, the virtual date range reached, and the counts.

---

## Environment Contract (Accelerated)

Every `ITEST_*` variable from the non-accelerated contract applies unchanged
(see *Environment Contract* in `BACKEND_INTERACTION_TEST_SPEC.md`, reproduced in
the appendix below). The accelerated entry point adds:

| Variable | Default | Required | Description |
| --- | --- | --- | --- |
| `ITEST_ACCEL_DAYS` | `365` | No | Virtual days to drive |
| `ITEST_ACCEL_RUN_BUDGET_MS` | `23400000` (6 h 30 m) | No | Wall-clock ceiling; an overrun aborts with the virtual date and counts reached |
| `ITEST_ACCEL_SAMPLE_EVERY` | `1` | No | Work every Nth open day; `>1` is how a faster scale stays feasible |
| `ITEST_ACCEL_CONCURRENCY` | `8` | No | Parallel jobs, capped by `min(free positions, idle technicians)` per site |
| `ITEST_ACCEL_JOBS_PER_DAY_MIN` / `_MAX` | `4` / `12` | No | Customer count per open day, before the feasibility cap |
| `ITEST_ACCEL_OPEN_TIME` / `_CLOSE_TIME` | `08:00` / `18:00` | No | Weekday window, site-local |
| `ITEST_ACCEL_SATURDAY` | `09:00-13:00` | No | Saturday window; `closed` to close it |
| `ITEST_ACCEL_SUNDAY` | `closed` | No | Sunday window |
| `ITEST_ACCEL_HOLIDAYS` | *(US federal set for the covered year)* | No | Comma-separated ISO dates the shop is closed |
| `ITEST_ACCEL_PUBLISH_CALENDAR` | `true` | No | `patchLocation` the same hours and closures onto every site the run touches |
| `ITEST_ACCEL_MOBILE_AFTER_HOURS` | `true` | No | Mobile units take work at any hour |
| `ITEST_ACCEL_OVERRUN_GRACE_MINUTES` | `90` | No | Virtual minutes a started job may run past close |
| `ITEST_ACCEL_UNPAID_RATIO` | `0` | No | Fraction of finalized invoices left unpaid, for AR aging |
| `ITEST_ACCEL_MIN_WORKORDERS` | *(derived)* | No | Volume floor; default `0.6 × jobsPerDay × sampledOpenDays` |
| `ITEST_ACCEL_APPOINTMENT_LEAD_DAYS_MIN` / `_MAX` | `1` / `5` | No | How far ahead appointments are booked, in virtual days |
| `ITEST_ACCEL_POLL_MS` | `500` | No | `/system/time` poll interval |
| `ITEST_ACCEL_MAX_SKEW_MS` | `60000` | No | How far `virtualTime` may exceed the local wall clock before the run refuses to trust it |
| `ITEST_ACCEL_JOURNAL` | `.itest-accel-journal.json` | No | Run journal path (git-ignored) |
| `ITEST_ACCEL_LOCK_URI` | — | With the alpha workflow | Advisory lock object, e.g. `s3://durion-alpha-deploy/locks/accelerated.json` |

The accelerated entry point **requires** `GET /system/time` to answer 200 with
`accelerated: true`. A 404 fails setup with the message that this is the
non-accelerated backend and `npm run test:integration` is the right command.

Run commands (repo root):

```bash
# terminal 1: open the tunnel to alpha (stays running)
./scripts/alpha-itest-tunnel.sh            # PowerShell twin: .\scripts\alpha-itest-tunnel.ps1

# terminal 2
npm run test:accelerated:parity            # suites A-H copies, minutes
npm run test:accelerated                   # parity copies, then the year run (1-6 h)
```

The same commands with `ITEST_BASE_URL=http://localhost:8080` run against a
local Compose stack started with the accelerated override and explicit anchors.

---

## Completion Criteria (Accelerated)

**Status as built.** The four criteria below that can be checked without an
accelerated backend are checked, with what they showed. Everything else needs a
deployment anchored a year back and a run against it, and is deliberately left
open rather than assumed:

- `jest --listTests` on all three configs: the unit run collects **0**
  `*.itest.ts`, the integration run collects the **8** non-accelerated suites and
  **0** accelerated ones, the accelerated run collects the **9**
  `*.accel.itest.ts`. The integration config needed an explicit
  `testPathIgnorePatterns` for this — `*.accel.itest.ts` also ends in
  `.itest.ts`, so `testMatch` alone had it collecting the accelerated suites.
- Unit coverage of the new harness: **255 tests** in the package, all passing,
  covering the clock, the timer, the calendar, the ledger, the config and its
  feasibility arithmetic, the journal, the lock, the mutex, the audit predicates
  and the day runner's phase ordering and gating.
- No accelerated *business* instant comes from the real clock. The real clock is
  still used where the quantity genuinely is real time: the wall-clock run
  budget, wait durations, the skew comparison, lock and journal bookkeeping
  timestamps, and the one harness test that deliberately measures the virtual
  rate against the real one.
- `npm test` (846 tests), `tsc --noEmit` on the package, and `eslint` across the
  repo are green.

- [ ] `GET /system/time` on the target reports `accelerated: true`, `scale`
      matching the deployment, and a `virtualStart` before
      `realStart`. The anchors are recorded in the run log.
- [x] `npm test` collects zero `*.accel.itest.ts`; `npm run test:integration`
      collects zero of them; `npm run test:accelerated` collects only them.
      Verified by `jest --listTests`.
- [x] `virtualClock`, `virtualTimer`, `shopCalendar`, `resourceLedger`,
      `acceleratedConfig` and `acceleratedJournal` are unit-tested, including
      every refusal. `shopCalendar` and `resourceLedger` import no SDK client
      and no clock.
- [x] No accelerated test derives a business instant from `Date.now()`. Every
      virtual-time wait goes through `VirtualTimer`; no fixed sleep stands in
      for a clock read.
- [ ] Suites A-H accelerated copies pass against an accelerated backend, with
      the same assertions and role negatives as their non-accelerated twins,
      each crossing at least one virtual-day boundary.
- [ ] A year run completes within its budget: `ITEST_ACCEL_DAYS` virtual days
      driven, or a clean stop on `converged: true` with the virtual date
      reported.
- [ ] Every completed workorder has a finalized invoice, and
      `(1 - ITEST_ACCEL_UNPAID_RATIO)` of those invoices are paid, with payment
      amounts equal to invoice totals.
- [ ] Invoices span at least 11 of the 12 virtual months covered, and none is
      dated outside the run's virtual range.
- [ ] **Calendar compliance, checked against persisted backend timestamps:** no
      labor session, timer, or bay-job invoice falls outside an open window plus
      grace; mobile-unit work outside it is present and is the only such work.
      Checked over **every** worked virtual date, not a sample — a violation on an
      unsampled date would pass, and this is the assertion that carries the claim.
- [ ] **Resource compliance:** no bay, mobile unit, or technician ever held two
      open workorders at the same virtual instant.
- [ ] Volume floor met: at least `ITEST_ACCEL_MIN_WORKORDERS` workorders written.
- [ ] Weekly cycle count fired on every virtual day-of-year multiple of 7 and
      monthly restock on every multiple of 30, and neither fired on an adjacent
      day.
- [ ] A mid-run process restart resumed on the same timeline without duplicating
      bootstrap data or silently skipping a virtual day.
- [ ] The execution lock prevented a second concurrent accelerated run, and was
      released on success and on failure.
- [ ] Records are retrievable afterwards by `runId` through the API, and the
      run's virtual date range is visible on them.
- [ ] The alpha backend is returned to the non-accelerated profile afterwards,
      and `npm run test:integration` passes again (its guard proves the profile
      is off).
- [x] Root Jest unit run, TypeScript build, and lint remain green.

---

# Appendix: Non-Accelerated Baseline (copy source)

Everything below is the non-accelerated specification, carried here verbatim as
the copy source for Task A6 and as the authority on personas, credentials,
fixtures and per-suite assertions. Where it and the accelerated sections above
disagree — the `/system/time` guard direction, real versus virtual date
arithmetic, resource claiming, calendar gating — **the accelerated sections
win**. Its `[x]` marks and its "RAN" notes record the non-accelerated run and
are not accelerated evidence.

## Personas, Roles, and Credentials

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
- **Timer identity:** `startTimer` tracks the request's technician, else the
  workorder's assigned technician, else the authenticated user, and records the
  authenticated user as the initiating actor when those differ; `stopTimers`
  stops timers the caller tracks *or* initiated. Work is assigned — technician
  and bay — before it starts (backend #2011), so suite C and F timers track the
  assigned technician and the `tech` persona that started them can stop them.
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

## Test Framework Layout

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
      e-cycle-count.itest.ts
      f-time-reporting.itest.ts
      h-service-position.itest.ts
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

## Fixtures: Reuse the Seeder Bootstrap

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

## Task 1: Export Seeder Fixtures as a Library

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

## Task 2: Scaffold the Integration Package and Harness

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
  prerequisite after install: the root `npm run build`, which compiles the
  workspace in dependency order (the same build the alpha host runs).
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

## Task 3: Suite A — Appointments

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

## Task 4: Suite B — Estimates

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

## Task 5: Suite C — Workorder Execution

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
- [x] **C1b — Assign technician.** Before any work, `assignTechnician` with a
  bootstrap technician id. Assert the assignment is visible.
- [x] **C1c — Place on a bay.** On a bay the run creates (retrying while the
  `ext_bay` replica answers `Unknown bay`); it stays there until C8. Assert the
  position names the bay and the technician, and the status is `ASSIGNED`.
  Work is assigned — technician and bay — before it starts (backend #2011).
- [x] **C2 — Start execution.** `operationalContextApi.startWorkorder` from
  `ASSIGNED`. Assert the detail status reflects execution start.
- [x] **C3 — Timer lifecycle.** The technician is already assigned, so the
  timer tracks that technician with the tech persona as initiating actor, and
  `stopTimers` (tracked technician or initiating actor) still reaches it. For
  the first service item: `stopTimers` (tolerate no-active-timer),
  `startTimer` with `{workorderId, workorderItemId, laborCode}`, wait ≥1s of
  real time, `stopTimers`. Assert via the workorder labor/time-entry API that
  a labor entry exists for that item with duration > 0.
- [x] **C4 — Timer conflict.** Start a timer, then `startTimer` again for the
  second item without stopping: assert 409. Recover exactly as the seeder
  does (stop, restart), then stop. Assert both items have labor entries.
- [x] **C5 — One technician per workorder.** A second `assignTechnician` → 409
  `TECHNICIAN_ALREADY_ASSIGNED` naming the current technician; reassign away
  and back.
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

## Task 6: Suite D — Receiving

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
- [x] **D5 — Putaway, refused and then driven.** A shop-floor receipt is
  refused with **422 `RECEIPT_NOT_STAGED`**. A receipt booked into staging then
  runs the whole path: `generatePutawayTasks` → `claimPutawayTask` →
  `executePutaway` against the task's own `suggestedDestinationLocationId`,
  asserting staging on-hand falls by the received quantity and the
  destination's rises by it. See *Putaway* in the backend-findings section for
  what this took (backend #1496, #1514, #1538).
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

## Task 10: Suite E — Cycle Counting

**File:** `src/suites/e-cycle-count.itest.ts`

SDK surface: `@durion-sdk/inventory` (`CycleCountPlansApi`,
`CycleCountOperationsApi`, `CycleCountQueryApi`, `CycleCountAdjustmentsApi`,
`InventoryBulkIngestAPIApi`, `StockMovementsApi`) and
`@durion-sdk/location` (`StorageLocationAPIApi`).

**Isolation is the design.** Task generation counts every stocked
(bin, SKU) pair in the plan's scope, so a plan aimed at the shop's real bins
would take an unbounded number of tasks and reconcile stock suites C and D are
asserting deltas against. The suite creates its own storage location and puts
two synthetic SKUs in it, which makes expected quantity, variance and the
posted adjustment exactly predictable.

**Stock is fed through the API, not Flyway.** `harness/stock.ts` mirrors the
backend's own seed driver: bulk ingest raises one adjustment *request* per row
and approving that request writes the ledger entry. Ingest alone leaves
availability at zero — the single most likely way to misread this flow.

**Acting personas:** `parts` (INVENTORY_LEAD) plans the count: the alpha data
load grants it `inventory:cycle_count:initiate|view|complete`. `admin` generates
and records the count itself. `parts` also raises
the adjustment (`inventory:adjustment:create`) and reads it back
(`:view`); `admin` approves it, because `inventory:adjustment:approve` goes to
INVENTORY_CONTROLLER, INVENTORY_MANAGER and ADMIN and never to the raiser.

**Fixed points the assertions rest on.** No tolerance row is configured for a
synthetic SKU at a brand-new bin, so `CycleCountToleranceResolver` falls
through to zero tolerance and only an exact match is accepted. The seeded
`TIER_1_MANAGER` threshold is 0 units, so any variance at all requires a
decision and nothing auto-approves. `createCycleCountPlan` requires a non-empty
`zoneIds` and a `scheduledDate` strictly in the future, neither of which the
generated model marks required.

- [ ] **E1 — Plan.** `createCycleCountPlan` as `parts`, scoped to the run's own bin;
  assert `PLANNED` and that `zoneIds` carries the bin.
- [ ] **E2 — RBAC positive.** In role mode the E1 plan was created by the
  parts clerk, and the clerk can list its tasks (`inventory:cycle_count:view`).
- [ ] **E3 — Generate.** `generateCycleCountTasks` for the clerk as auditor;
  assert exactly the two seeded SKUs, `binLocation` equal to the bin's UUID as
  text, `ASSIGNED`, expected quantity as seeded, and the plan moved to
  `STARTED`.
- [ ] **E4 — Read back.** `listCycleCountPlanTasks` and `getCycleCountTask`
  agree, with no count entries yet.
- [ ] **E5 — Exact count.** Variance 0, `withinTolerance` true, task
  `ACCEPTED_WITHIN_TOLERANCE`, and no adjustment is created.
- [ ] **E6 — Short count.** Variance negative, `withinTolerance` false, task
  `COUNTED_PENDING_REVIEW` — held for a reviewer rather than auto-reconciled.
- [ ] **E7 — Recount.** `TRIGGER_RECOUNT_SELF` is the auditor's one immediate
  recount; assert sequence 1, two count entries, and the task's latest entry
  pointing at the recount.
- [ ] **E8 — Adjustment.** The clerk raises it from the task; assert
  `PENDING_APPROVAL`, tier `TIER_1_MANAGER`, and the quantity change.
- [ ] **E9 — RBAC negative.** The clerk who raised it cannot approve it.
- [ ] **E10 — Post.** Approval carries an approver and a `ledgerEntryId`, and
  the pending-adjustment count falls.
- [ ] **E11 — Plan completes.** `STARTED` →
  `COMPLETED_PENDING_APPROVAL` → `APPROVED`.
- [ ] **E12 — Lifecycle negatives.** `APPROVED` is terminal (409); a closed
  task is not re-counted (409); an unknown plan is 404, not an empty list.
- [ ] **E13 — RBAC negative.** A technician can neither read nor record a
  count.

## Task 11: Suite F — Time Reporting and Approval

**File:** `src/suites/f-time-reporting.itest.ts`

SDK surface: `@durion-sdk/workorder` (`WorkorderLaborAPIApi`,
`WorkexecTimeTrackingAPIApi`, `TimeEntryAPIApi`) and `@durion-sdk/people`
(`WorkSessionsAPIApi`, `TimekeepingApprovalAPIApi`,
`TimeEntryApprovalAPIApi`).

**Two clocks, kept separate.** pos-workorder's labor entries bill a
technician's time to one service line on one workorder. pos-people's work
sessions are the payroll clock — in, break, out, submit — and know nothing
about workorders. F1-F7 cover the first, F8-F9 the second.

**The gap the approval tests are shaped around.** Nothing in either service
creates a decidable time entry. pos-workorder's `time_entry` table has approve
and reject endpoints and no writer at all. pos-people's `timekeeping_entry` is
written by `TimekeepingIngestionService.ingestWorkSession`, whose
`WorkSessionCompletedEvent` is published nowhere outside that service's unit
tests — `submitWorkSession` only flips the session's own status. So no call
this suite can make will reach an APPROVED entry, and a test that waited for
one would hang rather than report the cause. F10-F13 therefore assert what is
reachable and stays true either way: who the decision belongs to, and the
documented batch contract. When the ingestion bridge lands, a positive
approval belongs alongside them.

**Acting personas:** `tech` (TECHNICIAN) reports time —
`workorder:labor:add` covers starting, stopping *and adjusting* a labor entry
and is granted to TECHNICIAN and ADMIN only, so the manager reads labor but
never rewrites it. `manager` (LOCATION_MANAGER) reads
(`workorder:labor:view`, `people:timekeeping:view`) and decides
(`people:timeEntry:approve|reject`, `workorder:timeEntry:approve|reject`).
The payroll clock itself is `isAuthenticated()` — no permission gates it.

**Shared-environment hazard.** The seeder's shift loop clocks the same seeded
employees in and out, so F8 closes any session already open for the technician
before starting its own, and F9 leaves the person clocked out.

- [ ] **F1 — Labor session opens.** Active, stamped with a start time and the
  technician, no end time.
- [ ] **F2 — One session per service.** A second concurrent session is
  refused.
- [ ] **F3 — Stop records hours.** Real elapsed time, so the entry closes with
  an end time and hours worked.
- [ ] **F4 — History.** The manager reads the entry the technician recorded.
- [ ] **F5 — Adjustment.** The technician corrects the hours; the reason is
  recorded on the entry.
- [ ] **F6 — RBAC negative.** The manager cannot rewrite the hours.
- [ ] **F7 — Timers and totals.** `getActiveTimers` shows the technician's own
  running timer; `stopTimers` stops it; `getJobTimeTotals` answers for the day.
- [ ] **F8 — The payroll clock.** Clock in → break start → break stop → clock
  out → submit, asserting `ACTIVE`, the open and closed break, `ENDED`, then
  `SUBMITTED` with the submitted minutes.
- [ ] **F9 — Clock negatives.** A submitted session is not re-submitted (409);
  a second clock-in while one is open is a conflict (409).
- [ ] **F10 — Timekeeping is the manager's.** Pay periods list for
  LOCATION_MANAGER and are refused for TECHNICIAN. Periods are opened by the
  scheduled rollover, so the per-period read runs only when one exists.
- [ ] **F11 — Unknown pay period.** 404, not an empty timesheet.
- [ ] **F12 — Batch decision contract.** An unknown entry comes back as a
  per-entry `NOT_FOUND` inside a 200 rather than a failed batch; a rejection
  with no reason is a 400; an empty batch is a 400.
- [ ] **F13 — Workorder decisions.** The technician is refused; an unknown
  entry is 404 for both approve and reject.

## SDK client factories were missing generated APIs (2026-08-28)

Writing suites E and F surfaced the same defect in three client factories:
APIs that the generator produces and the `apis` barrel exports, but that
`create<Domain>Client` never constructs — so no consumer of the factory can
reach them at all. `createInventoryClient` already carried a comment noting
this for availability, backorders and putaway; the same hole covered the whole
cycle-count family bar adjustments, plus bulk ingest and stock movements.
`createWorkorderClient` was missing labor and time-entry decisions;
`createPeopleClient` was missing timekeeping approval, pay-period management,
compliance and bulk ingest. All were added. Regeneration does not fix this —
the factory bodies are hand-maintained — so a new endpoint is invisible until
someone adds the line.

## Role mode: what the first real run found (2026-08-24)

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

# 1483 implements all three through Kafka - pos-workorder publishes a command,
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
  accepted before, then answered 403, and now answers **422
  `OVER_RECEIPT_NOT_PERMITTED`** (backend #1493).
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

**Backend fixes landed 2026-08-25.** #1492, #1493, #1494 and #1496 are all
closed, and three of them changed what the suites see. Every one of them was
absorbed *silently* - the run stayed 46/46 - which is why the suites were
re-read against the new behaviour rather than trusted:

- **#1492.** `createReceivingSession` answers **409
  `SOURCE_DOCUMENT_LINES_UNAVAILABLE`** with a `nextAction` while
  `ext_purchase_order_line` catches up; a 404 now means the document genuinely
  is not there. D6 and D9 were retrying the 404 and would have thrown on a real
  lag - they passed only because the projection happened to be current. Both now
  retry the 409.
- **#1493.** Over-receipt is **422 `OVER_RECEIPT_NOT_PERMITTED`**, not the bare
  403 that a client could not tell from a missing permission. D11 asserts the
  code rather than recording whatever arrives.
- **#1496.** `generatePutawayTasks` refuses a receipt whose stock is not in
  staging, with **422 `RECEIPT_NOT_STAGED`**, instead of emitting a task that
  could never be executed. See the putaway note below.
- **#1494** is fixed: `getAvailabilityBySku` now requires
  `inventory:availability:read`, the permission TECHNICIAN already held, and a
  technician reading availability on alpha gets a 404 for an unknown SKU rather
  than a 403. An earlier draft of this note said the condition was unchanged;
  that was read from a local backend checkout 73 commits behind `origin/main`,
  and is wrong. Stock reads still act as the parts clerk, because stock is the
  parts clerk's concern in that flow, not because the technician is barred.

**Putaway, corrected 2026-08-24, 2026-08-25, and again 2026-08-27.** D5 concluded for twelve runs
that this backend "auto-putaways", on the evidence that a goods receipt raises
no putaway tasks. That was the wrong inference from a true observation: tasks
are not raised automatically, they are raised *on request*.
`generatePutawayTasks` returns one task per received line, and
`claimPutawayTask` works on it - so two thirds of the path had never been
exercised.

The task the backend generated then could not be executed by either available
route:

- From the task's own `sourceLocationId` - the staging location, `...0002` -
  **422 `NO_ON_HAND_AT_SOURCE_LOCATION`**, "Data consistency error -
  reconciliation required". Nothing was in staging, because `createGoodsReceipt`
  puts stock directly on hand at the receiving location. That is precisely why
  D4 sees on-hand rise and why no task appears on its own.
- From the receiving location, where the stock actually was - **422
  `LOCATION_NOT_VALID_FOR_SKU`** against the task's *own*
  `suggestedDestinationLocationId`, "SKU is not configured in replenishment
  policies".

So generation rooted the task at a location the receipt never touched, and
resolved a destination that execution rejected. Filed as #1496 and **fixed**:
generation now refuses up front rather than emitting an unworkable task.

The second refusal outlived that fix, and D5 asserted it as a boundary for a
while: a receipt booked into staging cleared the `RECEIPT_NOT_STAGED` guard and
stopped at `LOCATION_NOT_VALID_FOR_SKU`, because the resolved destination was
validated against replenishment policy and D1's SKU had been created moments
earlier. That was read as a fixture gap - the ask was to seed policies - and it
was not. Backend #1514 concluded the model was wrong: no mature WMS gates
putaway on restock configuration, and using an `(itemSKU, locationId)` policy
row as a proxy for "this SKU belongs here" made a brand-new SKU unputawayable
anywhere while letting a tire into oil storage on the strength of a min/max row.

**Backend #1538 replaced it, and D5 now drives the whole path.** What changed:

- Both replenishment-policy gates are gone from putaway validation.
  `ReplenishmentPolicy` is untouched and keeps its documented job - min/max for
  the replenishment scan.
- Eligibility is a seeded `storage_compatibility` matrix keyed on catalog
  category and subcategory against the location's `storageCategoryCode`.
  `LOCATION_NOT_VALID_FOR_SKU` survives as a code, but it now means "a tire does
  not go in oil storage" rather than "nobody wrote a min/max row".
- Rules match the item. The dead `criteria` JSON column became
  `match_type`/`match_value`, resolved **per line** with precedence
  `SKU > SUBCATEGORY > CATEGORY > ANY`. Previously one rule applied to every
  line of every receipt, which is why every fresh SKU resolved to the same
  destination and failed there.
- A seeded `ANY` rule is the terminal fallback, so a brand-new SKU never
  dead-ends, and the hardcoded `00000000-…-0001` destination is gone.

D5 therefore asserts one refusal and one complete flow:

1. A receipt booked to the shop floor - which is what `createGoodsReceipt` does
   on the ASN path, and why D4 sees on-hand rise - is refused with **422
   `RECEIPT_NOT_STAGED`**. Unchanged.
2. A receipt booked into the staging location generates a task, `parts` claims
   it, and `parts` executes it against the task's own
   `suggestedDestinationLocationId`. Staging on-hand falls by the received
   quantity and the destination's rises by the same amount.

Both halves run as `parts` (INVENTORY_LEAD), which holds
`inventory:putaway:view/generate/claim/execute` and deliberately holds neither
override. So execution succeeds on the merits - the destination is genuinely
compatible and genuinely has room - and D5 must not start passing
`overrideCapacity` or `overrideLocationCompatibility` to stay green.

Two environment faults surface here as ordinary 4xx and are fixed outside the
suite; D5's `executePutaway` failure message names both:

- **The destination storage location does not exist.** The resolved
  destination has no row in pos-inventory's `ext_storage_location`:
  `StorageLocationValidationService` resolves the replica by primary key and
  reports `exists=false` on a miss. Two different faults produce this, and they
  have opposite fixes, so establish which one first with
  `SELECT * FROM storage_location WHERE id = '<destination>'` on pos-location.
  - *No row there either* — the terminal `ANY` `putaway_rule` targets a bin that
    never existed. This is what alpha hit (backend
    [#1543](https://github.com/louisburroughs/durion-positivity-backend/issues/1543)):
    the seeded rule's retarget lives in a repeatable migration under
    `ON CONFLICT (rule_id) DO NOTHING`, so it never reaches an environment whose
    rule row already exists. The fix is to retarget the rule; hydration would
    achieve nothing, because there is no bin to replicate.
  - *A row there but not in the replica* — a real bin pos-inventory has not seen.
    pos-location's outbox replay re-emits already-serialized payloads, so this
    one does need a fresh write via `patchStorageLocation` (backend
    `docs/OPERATIONS_RUNBOOK.md`).
- **A capacity refusal.** The resolved bin cannot hold the received quantity;
  the putaway-rule fixture pack
  (`scripts/fixtures/seed/alpha/inventory/putaway-rules.csv`) needs a roomier
  destination.

Note also that #1538 bumped the permission catalog to v64, which invalidates
every previously issued JWT - the suite re-authenticates after that deploy.

---

## Task 12: Suite H — Service Position and Technician Assignment

Backend #1983-#1985 made a workorder's service position and its technician two
first-class, independent assignments (`PUT/DELETE/GET /v1/workorders/{id}/position`,
`DELETE /v1/workorders/{id}/technician`). A `BAY` or `MOBILE_UNIT` holds at most
one open workorder (`409 RESOURCE_OCCUPIED`, `referenceId` = the occupant);
`HOLD` is the workorder's own site and holds any number; a workorder has at most
one current technician (`409 TECHNICIAN_ALREADY_ASSIGNED` on a second assign,
`TECHNICIAN_NOT_ASSIGNED` on a reassign with none); closing a workorder frees its
position.

**Acting personas:** `manager` (LOCATION_MANAGER holds
`workorder:operationalContext:override` and `:assign-technician`) places and
releases; `admin` creates and deletes the run's bay and lists mobile units;
`advisor` builds the workorders; `tech` is the role-mode negative.

**Isolation.** The suite creates its own bay and mobile unit: any shared position
may already hold an open workorder. The unit is left INACTIVE, the default — an
ACTIVE unit needs a travel buffer policy, capabilities and coverage rules, and
pos-workorder does not consult the unit's status when placing a workorder. Both
reach pos-workorder through Kafka-fed replicas (`ext_bay`, `ext_mobile_unit`), so
H1 and H8 retry while the refusal says `Unknown bay` / `Unknown mobile unit`.
`afterAll` releases W2's and W3's positions; W1 is left open on the run's bay with
a technician (H10). The bay and unit are kept, run-tagged, like every record a run
creates.

- [ ] **H1** W1 placed on the run's bay; the read and the current history row name it.
- [ ] **H2** W2 on the same bay → 409 `RESOURCE_OCCUPIED`, `referenceId` = W1.
- [ ] **H3** W2 and W3 on `HOLD` with no id → both `HOLD`, `resourceId` = the site.
- [ ] **H4** `HOLD` naming another real location (from `listLocations`) → 422 `SERVICE_POSITION_INVALID`; the workorder stays on `HOLD` at its own site.
- [ ] **H5** W1 approved and given a technician; moving W1 to `HOLD` keeps the technician, releasing the technician keeps `HOLD`.
- [ ] **H6** W2 takes the bay W1 left.
- [ ] **H7** Releasing W2 leaves no position; the bay claim stays in history.
- [ ] **H8** On a mobile unit the run creates (INACTIVE, based at the site): W3 takes it, W1 is refused naming W3.
- [ ] **H9** (role mode) A technician cannot place a workorder (401/403).
- [ ] **H10** W1 given a technician again and placed on the freed bay → `BAY`, the technician, status `ASSIGNED`; left that way. H5 logs W1's status after its technician release (ASSIGNED today; to revert to APPROVED).

Suite C adds the lifecycle half: **C1b/C1c** (a technician, then a bay the run
creates, before work starts; status `ASSIGNED`), **C5** (second assign refused
naming the current technician; reassign away and back) and a check after **C8**
that completion freed that bay. Suite F puts its workorder on its own run bay
before starting it and leaves it there (F never completes its workorder).

## Suites A-D: what alpha actually does (2026-08-23)

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
  **D5** no putaway tasks are created for a receipt on its own - but that is
  not auto-putaway, as this note first concluded. Tasks are raised on request,
  and since backend #1538 the requested task can be claimed and executed; see
  *Putaway, corrected 2026-08-24, 2026-08-25, and again 2026-08-27* in the
  preceding section.
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
# 1477 (estimate promotion discards the reason it refused, making a transient
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

## Task 7: Laptop → Alpha Access Tunnel

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

## Task 8: Wire Personas to the Seeded Operational Accounts (enables role mode)

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

## Task 9: Documentation

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

The sequence this step specifies, annotated with what was actually run:

```bash
npm test            # RAN: 530 passing, zero *.itest.ts collected
npm run build       # RAN: clean
npm run test:integration   # NOT RUN against a local backend - no local stack here
# RAN: one tunneled run from the laptop against alpha, 46/46 in role mode.
# Records were confirmed by runId through the API
# (GET /v1/workorders/search?q=<runId>), not by connecting to the database.
```

---

## Completion Criteria

- [x] `packages/sdk-integration-tests` exists as a private workspace package;
      `npm test` (unit) and `npm run test:integration` are fully independent.
      Verified by `jest --listTests`: the unit run collects zero `*.itest.ts`.
- [x] Seeder fixtures (`SeederAuth`, bootstraps, `ReferenceCache`,
      `SeederRandom`, `SEED_VENDOR_ID`) are consumed as a library, not
      copy-pasted; the seeder's own entrypoint and image are unchanged.
- [x] No test depends on virtual time: `/system/time` is touched only by the
      global-setup guard that aborts when alpha is mid-accelerated-run, and no
      test waits for a clock boundary. **Every wait for state goes through
      `waitFor`** - no polling loop, no unbounded sleep, and no sleep standing
      in for a poll.

      A fixed sleep is allowed for one purpose only: letting **real time
      elapse** where the assertion is about duration. Suite C does this in
      three places, sleeping 1.5s so a labor entry carries a duration above
      zero, which is what C3 specifies and which no amount of polling can
      substitute for. Waiting for something to *become true* that way would be
      a defect; waiting for the clock to move is the measurement.
- [x] Suites A–D pass against a non-accelerated backend, covering:
      appointment lifecycle + idempotent appointment→estimate bridge;
      estimate draft→lines→totals→approve/decline→promote; workorder
      approve→start→timers (incl. 409 recovery)→assignment→pick/consume→
      change request→item completion→complete→invoice→payment; receiving of
      a new SKU (PO→ASN→receipt→availability delta→putaway) and
      workorder-directed receiving (shortage→receive→cross-dock→pick
      completable), each with at least one negative case.
- [x] Every created entity is traceable to a run via the runId marker, and a
      completed alpha run's records are retrievable afterwards by that marker.

      Verified through the API - `GET /v1/workorders/search?q=<runId>` returned
      the run's four workorders. The original wording said "queryable in the
      alpha database"; a direct database connection needs credentials this run
      did not have, so that specific check is still outstanding and the
      criterion is recorded against what was actually demonstrated.
- [x] The full suite runs from a developer laptop against alpha through the
      SSM tunnel with no new public ingress on the alpha host.
- [x] Every test step declares its acting persona; the suite passes in
      single-credential mode, and in role mode each persona acts under its
      own login with the role-enforcement negatives running (passing or
      recorded as documented gaps).
- [x] Credentials appear only in shell environment variables or a git-ignored
      env file; they are never committed, logged, or passed on a command line.
- [x] Root Jest unit run, TypeScript build, and lint remain green.

      Lint had never been green: `npm run lint` reported 6,669 errors. **6,632
      of them were in `packages/*/dist` and `coverage/`** - git-ignored build
      output that a clean checkout does not even contain, which is why CI never
      saw it. ESLint carried no `.eslintignore` and no `ignorePatterns`, so it
      walked compiled JavaScript and drowned the handful of errors in code
      anyone could act on.

      Generated clients were never the problem: each one opens with its own
      `/* eslint-disable */`, so it is suppressed at source. They are
      deliberately *not* added to `ignorePatterns`, so the day the generator
      stops emitting that header, the errors become visible instead of hidden
      by config.

      That left 37 real errors, now fixed rather than silenced: two dead
      helpers and a `let` that should have been `const` in
      `CustomerEventSimulator`, an unused `LogContext` in `Logger`, and a
      `while (true)` in `VirtualClock` rewritten as the `for (;;)` used
      everywhere else in this repo. The 32 remaining were `no-explicit-any` on
      deliberate mock casts in two unit-test files; the rule is switched off for
      test files through an `overrides` block that says why.
