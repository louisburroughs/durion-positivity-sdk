# @durion-sdk/agent-qa

An agentic QA harness for the Durion Positivity SDK. Every day it puts a day's worth of realistic business through
a live backend, **for the whole tenant**: each of the tenant's shops opens, serves its own roster of customers —
new and returning, individuals and commercial accounts, with vehicles on file and vehicles never seen before —
receives its deliveries and closes, with a language model carrying every customer from the service counter to the
shop floor to checkout. Around that it runs the tenant-wide back office (receivables, payables, the monthly
close), deliberate error drills, and a sweep that makes sure every SDK gets called every month.

The model does the work through tools, and each tool is one method of a generated client. Nothing about a visit is
scripted beyond who walks in and what they want: finding the returning customer, choosing services that fit the
complaint, working around a full shop and coping with whatever state the tenant is in are left to the agent.

It is built from standard parts and owns very little: the TypeScript compiler reads the generated clients, **Zod**
validates every tool input, **Vercel's AI SDK** talks to the model, and one short loop sits between them.

```text
packages/sdk-*/src/apis/*.ts ──► catalog ──► Zod schema per operation ──┐
        (generated clients)      1,381 ops                              │
                                                                        ▼
day roster (visits) + staff scenarios ──► task ──► tools ──► loop ◄──► model (AI SDK, fallback chain)
                                                            │
                                              real generated client + transport
                                                            │
                                                         backend
                                                            │
                          call ledger ──► verdict (oracle) · monthly coverage · daily report
```

## Quick start

```bash
npm install
npm run build                       # the harness calls the built clients, as a consumer would
```

Point it at alpha's public API and give it a model, in the `.env.itest` you already use for the integration
suites (see the `QA_*` section of `.env.itest.example`):

```bash
ITEST_BASE_URL=https://durionpos.org/api
QA_MODELS=openrouter:anthropic/claude-sonnet-4.5,ollama:qwen3:14b
OPENROUTER_API_KEY=...
```

No tunnel is needed: the gateway is public at `https://durionpos.org/api` and every call the harness makes goes
through it. (The integration suites' `ITEST_SECURITY_SERVICE_URL` and the SSM tunnel are for their
direct-to-service bootstrap; the harness sends nothing there.) To run against a local stack or through the tunnel
instead, leave `ITEST_BASE_URL` at its `http://localhost:…` value.

```bash
npm run qa -- doctor                # configuration, model, backend and tenant binding, each checked
npm run qa -- plan                  # today's schedule and what is due now
npm run qa -- run error-not-found   # one scenario, right now
npm run qa:daemon                   # stay up and work the day
```

| Command | What it does |
| --- | --- |
| `npm run qa -- plan` | Asks the tenant for its sites if today's plan is not made yet, then prints today's tasks in shop time and their status. |
| `npm run qa:tick` | Runs what is due, then exits. For cron, Task Scheduler or CI. |
| `npm run qa:daemon` | Stays up, runs each scenario at its time of day. Ctrl-C stops after the current scenario. |
| `npm run qa -- run <id>…` | Runs scenarios now, ignoring the schedule. `coverage-sweep` is an id too. |
| `npm run qa -- coverage` | This month's SDK coverage, per package. |
| `npm run qa -- catalog [words…]` | Searches the tool catalog, with each operation's risk class. |
| `npm run qa -- doctor` | Checks everything a run needs and says which part is wrong. |
| `npm run qa:smoke` | End-to-end self-test with a mock model and a mock gateway. No credentials. |

Exit codes: `0` ok · `1` a scenario found a server error or an undecodable response · `2` the backend did not
answer · `64` configuration or usage.

## Launching it

The harness is one process with two ways in, sharing a state directory (`.agent-qa/`) and a lock, so they can be
mixed and can never run a slot twice.

**Run constantly (laptop).** `npm run qa:daemon` checks once a minute and runs each scenario when its time comes.
It survives a dropped connection or a restarted stack: the pass fails, it says why, and it tries again.

**Triggered regularly.** `npm run qa:tick` does one pass and exits. Schedule it every 10–15 minutes during shop
hours:

```bash
# cron (macOS / Linux / WSL)
*/15 7-18 * * 1-6  cd /path/to/durion-positivity-sdk && npm run --silent qa:tick >> .agent-qa/tick.log 2>&1
```

```powershell
# Windows Task Scheduler
schtasks /Create /TN "Durion Agent QA" /SC MINUTE /MO 15 /ST 07:30 /ET 18:30 `
  /TR "cmd /c cd /d C:\path\to\durion-positivity-sdk && npm run --silent qa:tick >> .agent-qa\tick.log 2>&1"
```

The task can fire on a closed day or with nothing due; the pass then exits without doing anything.

**GitHub runner.** `.github/workflows/agent-qa.yml` runs the same `tick` from a hosted runner against the public
API: it restores the state directory from the Actions cache, runs one pass and saves the state back. It is manual
(`workflow_dispatch`) until its schedule is uncommented; the secrets and variables it needs are listed at the top
of the file.

### How the day is spaced

Every visit stage and every scenario has a time of day in the shop's time zone (`QA_TIMEZONE`). Each slot is moved by a jitter of up to
`QA_JITTER_MINUTES` that is stable within a day and different the next, so the traffic does not arrive on the same
minute every morning.

A tenant's shops work at the same time, so tasks do too: each pass starts up to `QA_MAX_PER_TICK` (3) of the tasks
that are due and runs `QA_CONCURRENCY` (3) of them side by side, with at least `QA_MIN_GAP_MINUTES` (2) between
passes, so a backlog drains steadily rather than as a burst. With three sites a default day is roughly 50
agent runs between opening and closing. Set `QA_CONCURRENCY=1` for a single local model that cannot serve several
conversations at once, and lower the visit counts to match what it can get through in a day.

A laptop is not always on, so each cadence has a catch-up rule:

| Cadence | Due | If its time was missed |
| --- | --- | --- |
| daily | at its slot | still runs up to `QA_MAX_LATENESS_MINUTES` late; after that it is skipped for the day — opening the shop at 4pm is not a faithful replay |
| weekly | from its weekday | stays due until it has run once that ISO week |
| monthly | from its day of the month | stays due until it has run once that month |

Nothing runs on a day outside `QA_RUN_DAYS` (Monday–Saturday by default, matching alpha's operating hours).

## How an SDK method becomes a tool

`buildCatalog()` parses `packages/sdk-*/src/apis/*.ts` with the TypeScript parser and returns one `Operation` per
public method: its HTTP verb and route, the backend's own description of when to use it, and its input as a small
schema tree resolved from the request interface and the model files. There is no generated artifact to keep in
step: a regenerated client changes the tools on the next start, and the whole workspace reads in about a second.

`zodFromIr()` turns that tree into a strict Zod object. A `Date` crosses the tool boundary as an ISO-8601 string
and an upload as `{ text, contentType }`; `hydrate()` converts them back before the call. The same Zod schema is
what the model is shown (as JSON Schema) and what its tool call is validated against.

A model cannot be handed 1,381 tools, so each scenario exposes two layers:

- **Pinned tools** — the operations the scenario names, one tool each (`order__SalesOrdersApi__createCart`), with
  that operation's own schema. A scenario pins at most sixteen.
- **Catalog tools** — `sdk_search`, `sdk_describe` and `sdk_call` reach everything else on demand.

`SdkInvoker` then calls the real generated API class, configured the way the packages' `createXxxClient`
factories configure it, with headers from `@durion-sdk/transport`. So a run exercises the SDK's own path
building, serialization, auth and idempotency handling — nothing is re-implemented beside it.

## The loop, and what makes it hold up

`agent/loop.ts` is the whole execution loop: ask the model for a turn, validate each tool call, run it, feed the
results back, repeat. It is owned here rather than delegated to a framework's multi-step mode because the
properties that matter are properties of the loop:

- **Errors are results.** A rejected input comes back to the model as `invalid-input` with the Zod issues by
  path, and nothing is sent. An HTTP error comes back with its status and error code. A tool that throws is a
  result too. None of them ends a run.
- **It always ends, and says why.** Step, wall-clock, token and per-scenario call ceilings are checked between
  turns. A model that repeats one call is warned at three and stopped at five; one that answers in prose is
  reminded twice to call a tool.
- **Models fail over.** `QA_MODELS` is a chain. When a model errors after the AI SDK's own retries, the turn is
  retried on the next model, mid-conversation, and the run stays there.
- **Responses are bounded.** Bodies are pruned to a budget as valid JSON (lists cut with their true length
  stated), so three list calls cannot fill a small model's context.
- **The model is a port.** The loop sees a `ModelPort`; `agent/aiSdkModel.ts` is the only file that imports `ai`.
  That is what lets the loop be unit-tested with a scripted model.

## A day across the tenant

Each morning the harness asks the tenant which locations are open for work — every active location with at least
one bay or mobile unit — and plans a day **at each of them** (`day/sites.ts`, `day/dayPlan.ts`). Nothing about the
sites is configured: a shop added to the tenant is in the next morning's plan.

Every site gets:

- **its own customers** — a roster of visits sized to the shop (4 to 8 on a weekday by default; a site with more
  bays gets a busier day; about 60% on a Saturday);
- **its own routines** — opening, receiving and closing run once per site, as do the weekly stock order, cycle
  count and timesheet approval, and the monthly inventory review;

while the work that belongs to the tenant as a whole — receivables, payables, the bank, the books, access reviews —
runs once.

```text
07:44  open-shop-main        Open the shop for the day — Main Street
07:49  open-shop-north       Open the shop for the day — Northside
08:14  main-v01-intake       Main Street — service: new individual (Kaylie Swaniawski), new vehicle, walk-in, approves, cash
08:21  north-v01-intake      Northside — service: existing commercial, existing vehicle, appointment, approves, on-account
09:33  main-v03-sale         Main Street — counter-sale: existing commercial
09:58  north-v02-intake      Northside — service: new commercial (Romaguera Construction Co.), new vehicle, on-account
13:50  main-v06-call         Main Street — appointment-call: existing individual, existing vehicle
14:34  invoice-and-payment   (tenant-wide)
17:38  close-shop-main       Close out the day — Main Street
```

A visit is who comes in, what they drive, what they ask for, what they decide and how they pay. Every task is told
which location it is at, by id; the agent never chooses a site.

**The mix is allocated, not sampled, and it holds at every site.** With ten visits at a shop, a 30% new-customer
share and a 30% commercial share, that shop sees exactly three new customers and exactly three commercial accounts
that day, and which visits they are changes daily, so all four combinations turn up.

| Setting | Default | Meaning |
| --- | --- | --- |
| `QA_VISITS_PER_SITE_MIN` / `_MAX` | 4 / 8 | Visits per site on a full weekday: the smallest site gets about the minimum, the largest about the maximum. `QA_VISITS_PER_SITE_MAX=0` turns visits off. |
| `QA_VISITS_TENANT_MAX` | 60 | Ceiling on the whole tenant's visits in a day, to bound cost. The busiest sites are trimmed first; none is emptied. |
| `QA_NEW_CUSTOMER_RATIO` | 0.3 | Share of visits by a customer the shop has never seen. |
| `QA_COMMERCIAL_RATIO` | 0.3 | Share of visits by a commercial account. |
| `QA_NEW_VEHICLE_RATIO` | 0.2 | Share of returning customers who bring a vehicle not yet on file. |
| `QA_OPEN_TIME` / `QA_CLOSE_TIME` | 08:00 / 17:30 | Arrivals follow a morning rush, a lunch lull and a smaller afternoon wave. |
| `QA_SEED` | 0 | Mixed into the date and the site; a site's roster is a pure function of the three. |

**What is fixed and what is left to the agent.** The roster fixes the facts an agent left to itself would flatten.
A *new* customer comes with a generated identity (name, email, phone, or a business with its driver) and a vehicle
(year, make, model, VIN, plate) to create. A *returning* customer comes with only a place to start looking
("search names containing 'm', take the third individual"), so a real record already in the tenant is used and a
different one each day. Everything else — which services fit "brakes squeal when stopping", which bay is free,
what to do when the estimate is refused — the agent works out from what the backend tells it.

**A visit has stages, hours apart.** A service visit is three separate agent runs, as three different employees:

| Stage | Who | What happens |
| --- | --- | --- |
| intake | advisor | Find or create the customer and vehicle, write the estimate, get the customer's decision, promote to a workorder. |
| work | manager (and technician) | Approve, staff, find a free bay, start the job, clock labor, complete it. If more work is found on the lift, raise and approve a change request. |
| checkout | advisor | Invoice and finalize; take cash, or leave it open on a commercial account's terms. |

About 15% of customers decline the estimate and the visit ends at the counter; about 12% have work added mid-job;
about 30% of returning customers arrive on a booked appointment. Counter sales (about 20% of visits) and phone
bookings (about 15%) are single-stage.

A stage starts only after the one before it has run, and is skipped when its prerequisite never came to exist (no
workorder, no work). What one stage learns reaches the next through the visit's memory: ids are captured straight
from the responses that create them, and the agent adds the rest with a `remember` tool. It is saved after every
call, so a stage that dies halfway still leaves the next one what it had established.

The work stage must not take a bay from another job. When none is free the visit ends "waiting for a bay" and is
finished by the nightly close-out — see *Running alongside the populate runs* below.

## Staff routines and error drills

`scenarios/library.ts` holds 25 fixed scenarios for the work that does not walk in through the door. Each is a
goal written the way an employee would describe the task, the operations it normally takes, and the facts that
must appear in the call ledger. A scenario marked `perSite` runs once at every shop, each instance told where it
is; the rest run once for the tenant.

| Cadence | At every site | Once for the tenant |
| --- | --- | --- |
| Daily | open the shop · receive a delivery · close out the day | invoices and receivables · 404 drill · coverage sweep |
| Weekly | stock order · cycle count · timesheet approval | access review · customer follow-ups · warranty claims · authorization drill · payables run · bank deposit · catalog and pricing |
| Monthly | inventory review | period close · financial statements · bank reconciliation · supplier review · people admin · platform and integrations · management analytics · error-contract drill · agreements, fleet and vehicles |

**Error conditions** are scenarios of kind `error`: lookups that must answer 404, a technician reaching for
finance (403 — needs per-persona logins, and is skipped rather than failed without them), and the validation,
conflict and idempotency contracts (400/422/409). Only these may send a request that skips client-side
validation (`validate: false`), which is how a deliberately malformed body reaches the server. Visits produce
their own errors too, naturally: a full shop, a refused VIN, a register that is not open.

To add a scenario, add an entry. `scenarios.test.ts` fails if it names an operation the clients do not have.

### Running alongside the populate runs

The harness has taken over the shop floor. The `Alpha Daily Shop Floor` workflow used to put a started workorder
on every free bay each morning, which left no position for the agent's jobs; its scheduled run is now
`populate:alpha-upkeep` — the close-out and the appointment top-up, without the load.

Both halves that remain matter to the harness:

- **The close-out is its night shift.** Any job still holding a bay from before today — one the agent left
  "waiting", or started and did not finish — is completed, invoiced and paid there, so each morning starts with
  free positions. Without it, unfinished jobs would accumulate until no bay was free.
- **The appointment top-up keeps the calendar booked**, which is what "arriving on an appointment" visits find.

What the load used to provide, the harness now has to:

- **Volume.** The load put a job on every position at every site. The harness plans a day at every site too, but
  by default a smaller one — 4 to 8 visits per shop, of which about 60% are service jobs. Raise
  `QA_VISITS_PER_SITE_MIN` / `_MAX` (and `QA_VISITS_TENANT_MAX`) to fill the boards.
- **The payroll clock.** The load clocked technicians in and out. The work stage now clocks a technician in before
  starting their job, and closing the shop clocks the crew out.
- **Being there at all.** A day the harness does not run (laptop off, no model reachable) is a day with nothing on
  the floor. For such a day, dispatch `Alpha Daily Shop Floor` by hand with `populate:alpha-daily`, which is the
  old behaviour — or run the harness from the `Agent QA` workflow instead of a laptop.

### Verdicts come from the ledger, not from the model

Every call is written to a ledger as it returns. `scenarios/oracle.ts` judges the run from those records:

| Verdict | Meaning |
| --- | --- |
| `passed` | The agent finished and every expectation is visible in the ledger. |
| `failed` | A call answered **5xx**, or answered 2xx with a body the SDK could not decode (contract drift). The only verdict that means "there is a defect". The backend's documented "still replicating, retry" 503s after a record was just created are not counted; the agent is told to wait and retry. |
| `inconclusive` | The agent did not get there: out of steps, model error, or an expected call never happened. A harness or model matter until shown otherwise. |
| `infra` | Nothing answered: no network, or the stack is down. The slot is left due and retried when the backend is back. |
| `skipped` | The scenario needs per-persona logins that are not configured, or a visit stage's prerequisite never came to exist (the customer declined; the job was never finished). |

A 4xx is never a failure by itself: a 409 on a workorder that is already complete is the system working. What the
model reports as findings is included in the report, labelled unverified.

## Every SDK, every month

Coverage is counted from the ledger: an operation is *called* when a backend answered it, with any status.
`QA_COVERAGE_LEVEL` sets the unit the promise is measured in — `package` (default), `api` (every API class) or
`method` (all 1,381 operations).

Three things keep the promise, each a backstop for the one before:

1. **A day of visits plus the staff scenarios** already pin operations in all 23 packages the gateway routes
   (asserted by a test).
2. **The coverage sweep** runs daily with no fixed script: it is handed the operations the month has not reached
   yet — a quota sized to finish by month end, untouched packages first, spread across services — and the agent
   works out how to call each one.
3. **The backstop** needs no model. In the last `QA_BACKSTOP_DAYS` open days of the month, anything still uncalled
   gets one deterministic `GET`. So the guarantee holds through a month in which every model provider was down.

`method`-level coverage needs `QA_SWEEP_WRITES=true`, and will still exclude destructive operations (below);
`npm run qa -- coverage` shows exactly what is left.

Two packages are not routed by the gateway and are reported as unreachable rather than silently counted:
`@durion-sdk/internal` (pos-tax, an internal-only service) and `@durion-sdk/documents`. Give them a direct URL
with `QA_SERVICE_URL_INTERNAL` / `QA_SERVICE_URL_DOCUMENTS` to include them. `@durion-sdk/inquiry` has no
operations, and `@durion-sdk/transport` is exercised by every call.

## Safety

The harness writes to a shared tenant, so every operation has a risk class, assigned in `catalog/risk.ts`:

| Class | Examples | When it runs |
| --- | --- | --- |
| `read` | GETs; POSTs that only compute or search | Always |
| `write` | create a customer, approve an estimate, record a payment, give a bay back | When `QA_MODE=mutating` (default) |
| `destructive` | deletes, account lockouts, bulk ingest, the tenant registry, tenant signup and password-reset mail, campaign dispatch, closing an accounting period | Only when a scenario pins it **and** `QA_ALLOW_DESTRUCTIVE=true` |

Out of the box nothing destructive runs: the month-end scenario reads close readiness and is refused the close
itself until `QA_ALLOW_DESTRUCTIVE=true`. `QA_DENY` takes regexes over operation ids for anything else that should
never be called, and `QA_MODE=read-only` refuses every write.

Before any pass the harness runs the integration suite's own preflight — it refuses a backend that is mid
accelerated run, activates starter passwords, and proves every login is bound to the tenant under test — and it
holds the same environment lock as the accelerated year and the daily populate runs.

Records the agent writes carry the run id (`qa-<date>-<time>`) in their free-text fields.

## What a run leaves behind

```text
.agent-qa/
  state.json                     what has run today / this week / this month
  coverage-2026-11.json          the month's coverage, per operation, with status counts
  runs/2026-11-10/
    day-plan.json                today's sites and their visits, and what each visit has established so far
    report.md                    the day so far: each site's customers and their stages, verdicts, server errors, coverage
    calls.jsonl                  every SDK call: operation, persona, status, error code, correlation id, duration
    1205-open-shop.json          one scenario's result
    1205-open-shop.transcript.jsonl   every model turn and tool result
```

`.agent-qa/` is git-ignored. Every server error in the report carries its `X-Correlation-Id`, which is the handle
for finding the request in the backend's logs.

## Models and providers

`QA_MODELS` is `<provider>:<model>`, comma-separated, in fallback order. The model must support tool calling.

| Provider | Key | Notes |
| --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | The widest choice of tool-capable models behind one key; the practical default. |
| `ollama` | none locally; `OLLAMA_API_KEY` for cloud | Local models cost nothing per run and suit the read-heavy scenarios and the sweep; set `OLLAMA_BASE_URL=https://ollama.com/v1` for Ollama's hosted models. A good last link in the chain. |
| `opencode` | `OPENCODE_API_KEY` | OpenCode Zen's chat-completions endpoint. Zen serves its GPT and Claude models on other endpoints, so reach those through OpenRouter. |
| `gateway` | `AI_GATEWAY_API_KEY` | Vercel AI Gateway; ships with the AI SDK. |
| `custom` | `QA_CUSTOM_BASE_URL`, `QA_CUSTOM_API_KEY` | Any other OpenAI-compatible endpoint (LM Studio, vLLM, a corporate proxy). |

All but `gateway` go through one adapter, `@ai-sdk/openai-compatible`. Adding a first-party provider package
(`@ai-sdk/anthropic`, `@ai-sdk/google`) is a few lines in `agent/aiSdkModel.ts`.

Pi is an agent runtime rather than a model endpoint, so it is not a `QA_MODELS` provider; the model accounts it
logs in to (OpenRouter among them) are what this harness uses directly.

## Tests

```bash
npx jest packages/sdk-agent-qa      # 168 unit tests; no backend, no model
npm run qa:smoke                    # the AI SDK adapter end to end, with mocks (after npm run build)
```

The unit suites run against the real generated clients and a fake `fetch`: among other things they build a Zod
validator and JSON Schema for all 1,381 operations, instantiate every API class the catalog names, and prove the
month-end backstop covers every routed package with no model answering. `ai` v7 is ESM-only and Jest's CommonJS
runtime cannot load it, which is why the adapter has its own smoke script under plain Node (it needs Node 22.12
or later, for `require(esm)`).
