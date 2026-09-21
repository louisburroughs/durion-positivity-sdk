# Deploying and launching the accelerated backend

The accelerated integration suite needs a backend whose clock starts **one year in
the past** and runs at a few thousand times wall speed. This file is how you get
one.

It is a separate document rather than a README section because the answer is not
one command: the anchors have to be generated once and shared by every JVM, a
deployment is spent once its clock converges, and putting the environment *back*
afterwards matters as much as standing it up.

- Operator's guide to the suite itself: [`README.md`](./README.md)
- Backend-side alpha runbook (the dispatch, the on-box verifier, the teardown):
  `durion-positivity-backend` → `docs/runbooks/accelerated-alpha-deployment.md`
- What the suite asserts and why:
  [`BACKEND_INTERACTION_TEST_SPEC_ACCELERATED.md`](./BACKEND_INTERACTION_TEST_SPEC_ACCELERATED.md)
- Backend-side design of the clock:
  `durion-positivity-backend` → `packages/sdk-seeder/ACCELERATED_CLOCK_ALPHA_PLAN.md`
  in this repo describes it, and the backend implements it.

---

## Read this first: the accelerated profile is not a normal state

While a backend runs the `accelerated` profile:

- **every non-accelerated integration run is blocked.** `npm run test:integration`
  probes `GET /system/time` and aborts on a 200, by design — a test that measures
  real elapsed time is meaningless while the clock moves a thousandfold.
- **the records it writes are back-dated**, by design. That is the deliverable, but
  it means a year of history lands in whatever database the stack points at.
- **only one accelerated run may write at a time.** The suite takes a lock file and
  will refuse a second run on the same machine; two machines are not stopped by
  that, so agree the window (see *Holding the environment* below).

So: on a shared alpha, treat this as a booked maintenance window, and put the
profile back when you are done. On a local stack, do as you like.

---

## What exists

The clock itself is **implemented and unit-tested in the backend**:

| Piece | Where |
| --- | --- |
| Anchors, validation, the `min(...)` convergence rule | `pos-events/src/main/java/com/positivity/time/AcceleratedTimeProperties.java` |
| The clock bean | `pos-events` → `ScaledClock` (`getScale`, `isConverged`, `getRealStart`, `getVirtualStart`) |
| `GET /system/time`, `@Profile("accelerated")` | `pos-api-gateway/src/main/java/com/positivity/gateway/internal/controller/SystemTimeController.java` |
| Response shape | `pos-api-gateway/.../dto/SystemTimeResponse.java` |
| Timestamp verification queries | `deployment/alpha/verify-accelerated-timestamps.sql` |

And so is the **alpha deploy path**, added by
[durion-positivity-backend#2066](https://github.com/louisburroughs/durion-positivity-backend/pull/2066)
(closes [#2065](https://github.com/louisburroughs/durion-positivity-backend/issues/2065)):

| Piece | Where |
| --- | --- |
| The override: profile + five anchors on all 25 POS JVMs | `deployment/alpha/docker-compose.accelerated.yml` |
| `ACCELERATED=true`, anchor validation, `.env` persistence, teardown | `deployment/alpha/deploy-backend.sh` |
| The dispatch | `.github/workflows/deploy-alpha-accelerated.yml` (*Deploy Alpha (Accelerated Clock)*) |
| Post-deploy verification, on the box | `deployment/alpha/verify-accelerated-deployment.sh` |

Two ways to get an accelerated backend, then: **alpha**, through that workflow (see
*Launching on alpha*), or a **local Compose stack** (next section).

---

## The clock contract

Every backend JVM gets the same five values, generated **once**, immediately before
deployment:

| Env var | Property | Example | Notes |
| --- | --- | --- | --- |
| `SPRING_PROFILES_INCLUDE` | `spring.profiles.include` | `accelerated` | Additive; leaves an existing `SPRING_PROFILES_ACTIVE` (e.g. `alpha`) in place |
| `POS_TIME_ACCELERATED_SCALE` | `pos.time.accelerated.scale` | `1460` | Virtual seconds per real second. Must be finite and positive, and `> 1` to converge |
| `POS_TIME_ACCELERATED_ZONE` | `pos.time.accelerated.zone` | `UTC` | The suite's calendar arithmetic is UTC; keep it UTC |
| `POS_TIME_ACCELERATED_REAL_START` | `pos.time.accelerated.real-start` | `2026-09-17T12:00:00Z` | Wall-clock instant the run was launched |
| `POS_TIME_ACCELERATED_VIRTUAL_START` | `pos.time.accelerated.virtual-start` | `2025-09-17T12:00:00Z` | Exactly one year earlier. Must not be *after* `real-start` |
| `POS_TIME_ACCELERATED_CONVERGE` | `pos.time.accelerated.converge` | `true` | Stop accelerating on reaching wall time |

Virtual time is

```text
virtual(t) = min(virtualStart + scale × (now − realStart), now)
```

so it trails wall time, converges on it, and then ticks at scale 1 forever. It can
never exceed wall time, which is why an accelerated run cannot write future-dated
records.

**Generate the anchors once and share them.** A service that derives its own
`real-start` is a service skewed from every other: at scale 1,460, one real second
of staggered startup is 24 virtual minutes of disagreement, and the suite's skew
check exists to catch exactly that.

### Choosing the scale

A one-year gap closes in `G / (scale − 1)` real time, because wall time advances
during catch-up.

| scale | year closes in | real seconds per virtual day | real seconds in a 10 h open window |
| --- | --- | --- | --- |
| 1,460 | ≈ 6 h 0 m | 59.2 | 24.7 |
| 2,920 | ≈ 3 h 0 m | 29.6 | 12.3 |
| 4,380 | ≈ 2 h 0 m | 19.7 | 8.2 |
| 8,760 | ≈ 1 h 0 m | 9.9 | 4.1 |
| 26,280 | ≈ 20 m | 3.3 | 1.4 — the suite refuses this |

Pick from the right-hand column, not the second: the suite's throughput is bounded
by real event latency, and a job is advanced step by step across as many open
windows as it needs. **1,460 is the default** and gives a full-density year in about
six hours. See *Pick the scale from the time you have* in [`README.md`](./README.md)
for what the suite does with each.

---

## Launching on a local stack

### 1. Generate the anchors

```bash
cd ~/IdeaProjects/durion-positivity-backend

export POS_TIME_ACCELERATED_REAL_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export POS_TIME_ACCELERATED_VIRTUAL_START=$(date -u -d '1 year ago' +%Y-%m-%dT%H:%M:%SZ)
export POS_TIME_ACCELERATED_SCALE=1460
export POS_TIME_ACCELERATED_ZONE=UTC
export POS_TIME_ACCELERATED_CONVERGE=true

echo "virtual ${POS_TIME_ACCELERATED_VIRTUAL_START} -> real ${POS_TIME_ACCELERATED_REAL_START} at ${POS_TIME_ACCELERATED_SCALE}x"
```

On macOS, `date -u -v-1y +%Y-%m-%dT%H:%M:%SZ` instead of `date -u -d '1 year ago'`.

Write these down. They are the run's identity: the suite's journal refuses to resume
a run whose `realStart` differs, because that is a different year.

### 2. Write the override

A YAML anchor applied to every backend JVM, so no service can be left on the wall
clock. Uses `${VAR:?required}` so a missing anchor fails the `docker compose`
invocation rather than silently starting one service unaccelerated.

```bash
cat > docker-compose.accelerated.yml <<'YAML'
# Local accelerated-clock override. NOT for a shared environment without the
# backend deploy path (see ACCELERATED_BACKEND_DEPLOYMENT.md in the SDK repo).
#
#   docker compose -f docker-compose.yml -f docker-compose.accelerated.yml up -d
#
# Every JVM gets the SAME anchors from the shell: a service deriving its own would
# be skewed from the rest by scale x its startup delay.
x-accelerated-env: &accelerated-env
  SPRING_PROFILES_INCLUDE: accelerated
  POS_TIME_ACCELERATED_SCALE: ${POS_TIME_ACCELERATED_SCALE:-1460}
  POS_TIME_ACCELERATED_ZONE: ${POS_TIME_ACCELERATED_ZONE:-UTC}
  POS_TIME_ACCELERATED_CONVERGE: ${POS_TIME_ACCELERATED_CONVERGE:-true}
  POS_TIME_ACCELERATED_REAL_START: ${POS_TIME_ACCELERATED_REAL_START:?required}
  POS_TIME_ACCELERATED_VIRTUAL_START: ${POS_TIME_ACCELERATED_VIRTUAL_START:?required}

services:
  pos-api-gateway:      { environment: *accelerated-env }
  pos-security-service: { environment: *accelerated-env }
  pos-event-receiver:   { environment: *accelerated-env }
  pos-accounting:       { environment: *accelerated-env }
  pos-bulk-loader:      { environment: *accelerated-env }
  pos-catalog:          { environment: *accelerated-env }
  pos-customer:         { environment: *accelerated-env }
  pos-documents:        { environment: *accelerated-env }
  pos-image:            { environment: *accelerated-env }
  pos-inventory:        { environment: *accelerated-env }
  pos-invoice:          { environment: *accelerated-env }
  pos-location:         { environment: *accelerated-env }
  pos-marketing:        { environment: *accelerated-env }
  pos-mcp-server:       { environment: *accelerated-env }
  pos-order:            { environment: *accelerated-env }
  pos-people:           { environment: *accelerated-env }
  pos-people-contact:   { environment: *accelerated-env }
  pos-price:            { environment: *accelerated-env }
  pos-shop-manager:     { environment: *accelerated-env }
  pos-supplier:         { environment: *accelerated-env }
  pos-tax:              { environment: *accelerated-env }
  pos-tenant:           { environment: *accelerated-env }
  pos-vehicle-inventory: { environment: *accelerated-env }
  pos-warranty:         { environment: *accelerated-env }
  pos-workorder:        { environment: *accelerated-env }
YAML
```

**Verified against the real compose file** (Docker 29.8.1, `docker compose config`
on `durion-positivity-backend@main`), because two things about it are easy to get
wrong and expensive to discover an hour into a run:

- **Compose merges the environment mapping — it does not replace it.** The 25
  services each keep every variable they already had (datasource, Kafka, OTEL, the
  security and events client anchors) and gain the six above. `pos-mcp-server`
  ends up with `SPRING_PROFILES_ACTIVE: alpha` *and*
  `SPRING_PROFILES_INCLUDE: accelerated`, which is the additive behaviour this
  relies on.
- **A missing anchor fails the invocation**, it does not start one service
  unaccelerated: without the exports, `docker compose config` exits naming
  `POS_TIME_ACCELERATED_REAL_START` and `_VIRTUAL_START` as required.

`eureka-server` and `pos-reference-mock` are deliberately absent: a service
registry and a mock vendor write no business timestamps.

### 3. Bring it up

```bash
docker compose -f docker-compose.yml -f docker-compose.accelerated.yml up -d
```

### 4. Verify before you trust it

```bash
# The endpoint exists only under the profile, so a 404 here means it did not apply.
curl -s http://localhost:8080/system/time | jq
```

```json
{
  "virtualTime": "2025-09-18T04:11:07.512Z",
  "scale": 1460.0,
  "zone": "UTC",
  "accelerated": true,
  "converged": false,
  "realStart": "2026-09-17T12:00:00Z",
  "virtualStart": "2025-09-17T12:00:00Z"
}
```

Check, in this order:

1. `accelerated` is `true` and `converged` is `false`.
2. `virtualStart` precedes `realStart`, and **at least one virtual day is still
   drivable**. The deployed length is not checked — the clock has been closing the
   gap since the containers booted, so dispatch and start close together and the
   run will take whatever is left. The suite refuses only a spent clock, naming how
   much remained.
3. `virtualTime` moves. Two reads a second apart should differ by roughly `scale`
   seconds.
4. **Every JVM agrees.** One service left on the wall clock is the failure mode that
   costs a whole run, and the gateway alone cannot show it:

```bash
# Count the services that got the anchors. Expect 25 — one per service in the
# override. A lower number means a service name drifted from the compose file and
# that service is silently on the wall clock.
docker compose -f docker-compose.yml -f docker-compose.accelerated.yml config \
  | grep -c 'POS_TIME_ACCELERATED_REAL_START'

# Confirm nothing was lost in the merge: this service should still show its
# datasource, Kafka and OTEL variables alongside the accelerated ones.
docker compose -f docker-compose.yml -f docker-compose.accelerated.yml config \
  | sed -n '/^  pos-workorder:/,/^  [a-z]/p' | grep -E 'SPRING_|POS_TIME_|KAFKA_'

# And the container's own view, once it is up.
docker compose exec pos-workorder printenv | grep -E 'SPRING_PROFILES|POS_TIME_ACCELERATED'
```

### 5. Run the suite

```bash
cd ~/IdeaProjects/durion-positivity-sdk
export ITEST_BASE_URL=http://localhost:8080
export ITEST_SECURITY_SERVICE_URL=http://localhost:8086

npm run test:accelerated:parity   # minutes — fails fast on a bad clock
npm run test:accelerated          # the year: 1-6 h
```

The suite's own global setup repeats every check above and refuses to start on a
non-accelerated backend, a sub-year anchor gap, an already-converged clock, or a
scale too fast for the backend's measured latency.

### 6. Put it back

```bash
docker compose -f docker-compose.yml up -d   # without the override
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/system/time   # expect 404
```

A 404 is the proof the profile is off, and it is what lets
`npm run test:integration` run again.

---

## Launching on alpha

**Do not hand-edit the alpha box.** `deploy-backend.sh` verifies the sha256 of every
compose file it applies, the accelerated override included, so a hand-placed or
hand-edited override refuses the deploy. Everything below goes through CI. The
backend runbook (`docs/runbooks/accelerated-alpha-deployment.md`) is the full
procedure; this is the part the suite's operator needs.

### 1. Dispatch

The workflow builds nothing. It redeploys a tag already in ECR, so run
`Build and Push to ECR` for the commit you want first if it is not there yet.

```bash
gh workflow run deploy-alpha-accelerated.yml \
  -R louisburroughs/durion-positivity-backend \
  -f backend_tag=sha-a1b2c3d \
  -f scale=1460 \
  -f days=365 \
  -f sdk_run=test:accelerated \
  -f confirm='ACCELERATE ALPHA'
```

`backend_tag` blank means the dispatched ref's head commit. `scale` must be `> 1`
and `< 26280`. `confirm` must read exactly `ACCELERATE ALPHA`. CI generates both
anchors **once**, at dispatch, and hands the same pair to every JVM; the run
summary records them. Copy them from there rather than re-deriving them.

`sdk_run` is which script of this repo the workflow starts **on the alpha host**
the moment the stack verifies: `test:accelerated` (the default), `test:accelerated:parity`,
`populate:accelerated-year`, or `none` to deploy and start nothing. It runs from the
host's checkout of this repo (`/home/ec2-user/durion-positivity-sdk`, kept current by
`deploy-alpha-checkout.yml`) as `ec2-user`, with the host's `.env.itest` for
credentials and `ITEST_BASE_URL`/`ITEST_SECURITY_SERVICE_URL` pointed at the ports
the stack publishes there, detached, logging to `accelerated-<timestamp>.log` in the
checkout (`accelerated-latest.log` points at the newest; `.accelerated-run.pid` holds
the pid). Before starting it, the workflow moves the previous run's journal aside — every
dispatch re-anchors the stack, and the suite refuses a journal from another timeline —
renaming it in place with the stamp before the `.json`: the default becomes
`.itest-accel-journal.<its realStart, e.g. 20260920T120000Z>.json`, a custom
`ITEST_ACCEL_JOURNAL` such as `runs/alpha.json` becomes `runs/alpha.20260920T120000Z.json`.
That keeps past runs in order by the timeline they drove; a journal already on the new
timeline is left for the suite to resume. The path is read the way this suite reads it
(`harness/loadEnvFile.ts`: shell first, then `ITEST_ENV_FILE` or `.env.itest`). The workflow fails if the suite exits within its first
90 s — global setup's refusals — and otherwise leaves it to run. Steps 2 and 3 below are the by-hand
procedure for `sdk_run=none`, or for a run through the tunnel from a laptop; with the
default they have already happened.

The workflow runs `verify-accelerated-deployment.sh` on the box and fails unless all
25 JVMs share the same settings, `/system/time` answers `converged: false`, and
virtual time is measurably advancing at ~`scale`.

### 2. Dispatch immediately before you run

**The clock starts at dispatch, not when the suite starts.** The accelerated window
is `G / (scale − 1)` real time from `realStart` (see *Choosing the scale*), and every
minute between the deploy and `npm run test:accelerated` is spent out of it.
`npm run test:accelerated` also runs the parity copies before the year run, and
those minutes come out of the same window. At 8,760 the whole budget is about an
hour; at the 1,460 default it is about six.

### 3. Check the clock, then run

Through the tunnel (run commands: the spec's *Environment Contract (Accelerated)*):

```bash
./scripts/alpha-itest-tunnel.sh                  # terminal 1, from the repo root
curl -s http://localhost:18080/system/time | jq  # terminal 2
```

A usable deployment answers `accelerated: true`, `converged: false`, and a
`realStart` matching the dispatch summary.

### Restarting after convergence

A deployment is single-use. Once the gap has closed the stack is on wall time with
the profile still on, and `/system/time` says so:

```json
{"virtualTime":"2026-09-19T01:35:36.799316341Z","scale":8760.0,"zone":"UTC",
 "accelerated":true,"converged":true,
 "realStart":"2026-09-18T21:26:58Z","virtualStart":"2025-09-18T21:26:58Z"}
```

That was an 8,760× run dispatched at 21:26 UTC; its year closed about an hour later.
The suite refuses it at setup (`the accelerated clock has converged`). To go again:

1. **Re-dispatch** `Deploy Alpha (Accelerated Clock)`. There is no reset action; a new
   dispatch is the restart, and it re-anchors every JVM a year back from the new
   `realStart`. Never re-dispatch while a run is still inside its window. The same
   re-anchoring makes the live run's journal unresumable.
2. **Move the previous run's journal aside**, or point `ITEST_ACCEL_JOURNAL` at a new
   path. The journal is keyed on `realStart`; against the new anchors it is refused
   with `belongs to a different timeline`, by design, since its day list describes a
   year this deployment is not living.
3. Re-check `/system/time` for `converged: false` before running.

The previous run's records stay in the alpha database. A new dispatch writes a
second, overlapping year beside them under a new run id.

### Tearing down

An ordinary deploy is the teardown. `deploy-backend.sh` strips the profile and all
five anchors from the on-box `.env` and drops the override:

```bash
gh workflow run build-push-ecr.yml -R louisburroughs/durion-positivity-backend -f deploy_alpha=true
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:18080/system/time   # expect 404
```

Until it answers 404, `npm run test:integration` stays blocked. A converged
deployment still blocks it, because the profile is still on. Any ordinary deploy
ends a run, including the automatic promotion when `AUTO_DEPLOY_ALPHA` is on, so keep
that off while a run is in flight.

### Holding the environment

Per-machine exclusion is handled for you: the suite takes a lock file
(`<journal>.lock`) before writing, records the holder's run id, pid, host, user and
timeline, and releases on success, failure and Ctrl-C. It takes over a lock whose
process is gone; it never takes over one from another host, because a pid number
there means nothing locally.

Cross-machine exclusion it cannot do. On alpha, that is the deploy workflow's
`concurrency` group plus whoever holds the advisory object named by
`ITEST_ACCEL_LOCK_URI` — which the suite logs into the run record but does not
enforce.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `answered 404 — this backend is on the normal clock` | The profile did not apply | Check `SPRING_PROFILES_INCLUDE` reached the gateway (`docker compose exec pos-api-gateway printenv \| grep SPRING_PROFILES`) |
| Container exits at startup, `real-start is required` | An anchor was not exported before `docker compose` | Re-export all five and bring the stack up again; `${VAR:?required}` is what surfaced it |
| `virtual-start must not be after real-start` | Anchors generated in the wrong order, or a `date` flag difference | Regenerate; on macOS use `date -u -v-1y` |
| `scale must be greater than 1 to converge` | `scale` ≤ 1 with a back-dated `virtual-start` | The gap only closes above 1; use 1,460 |
| `only N virtual day(s) remain before the clock converges` | The timeline is nearly spent — the stack has been up too long | Re-dispatch the accelerated stack and start a fresh journal |
| `ahead of the local wall clock` | The backend host and your laptop disagree about now | Fix NTP on whichever is wrong; raise `ITEST_ACCEL_MAX_SKEW_MS` only if you know why |
| `the accelerated clock has converged` at setup | The deployment has already spent its year | Alpha: re-dispatch `Deploy Alpha (Accelerated Clock)` (*Restarting after convergence*). Local: regenerate the anchors and bring the stack up again |
| `belongs to a different timeline` | The journal is from an earlier deployment's anchors | Move it aside or set `ITEST_ACCEL_JOURNAL` to a new path |
| `this run cannot produce a usable year` | Scale too fast for the measured latency | Use the scale the message suggests |
| Timestamps look wrong in the database | A service missed the anchors | `deployment/alpha/verify-accelerated-timestamps.sql`, then check that service's env |
| `another accelerated run holds …` | A second run on this machine | Wait, or stop the holder and delete the named lock file |
