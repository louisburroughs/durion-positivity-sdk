# PR Review Processing — louisburroughs/durion-positivity-sdk#64

Run log for the `pr-review` runbook (`durion/.claude/skills/pr-review`), adapted:
the runbook's named agents (`PR Review Planner`, `PR Reviewer`, `PR Fix Coder`,
`PR Test Fixer`, `PR Code Reviewer`) are defined in `durion/.claude/agents` and are
not registered in this session, so the review step was served by the Copilot review
already on the PR and the remediation was performed directly. The runbook's
substance — evidence pack, findings split, remediation loop, per-comment replies,
final summary — is kept.

`CATALOG_ROOT` navigation does not apply: this PR is in the SDK repo and touches no
backend module, ADR or domain.

---

## Plan

1. Gather the evidence pack: PR metadata, comments, review comments with thread ids,
   linked issues, CI status.
2. Verify every finding before acting — reject with evidence rather than
   performatively agree.
3. Split into production-code fixes and test fixes; fix, each with a regression test.
4. Re-verify: unit run, typecheck, lint, and the three Jest configs' collection sets.
5. Reply to every review thread by id with what was done.
6. Watch CI to green, then decide on merge.

## Evidence

| Source | Finding |
| --- | --- |
| PR metadata | #64, `feat/accelerated-year-run` → `main`, 45 files, +11859/−174, `mergeStateStatus: CLEAN`, no human reviews |
| Reviews | 1 — `copilot-pull-request-reviewer[bot]`, state `COMMENTED`, "🟡 Changes recommended" |
| Review comments | 7 inline, ids 4041716228 / 307 / 360 / 424 / 482 / 551 / 603 |
| Issue comments | 1 — the backend blocker link (`durion-positivity-backend#2065`) |
| Linked issues | none; the PR is the deliverable for the accelerated-suite spec in-repo |
| CI at review time | `Build and Smoke Test` SUCCESS, `Lint, build and test` SUCCESS, `Publish to ECR` SKIPPED |
| Tests at review time | 857 unit passing, tsc clean, eslint clean |

## Findings by severity

### Accepted — correctness (fixed in `d680cb1`)

| # | id | File | Finding | Severity |
| --- | --- | --- | --- | --- |
| 1 | 4041716551 | `harness/resourceLedger.ts` | Overlap audit compared each interval only with its predecessor, missing holds nested inside an earlier longer one. Under-reports the compliance violation it exists to catch. | High |
| 2 | 4041716482 | `harness/acceleratedDayRunner.ts` | Intake gated on the bay window even for a mobile claim, so no *new* mobile job started out of hours — contradicting the documented "mobile units take work at any time". | High |
| 3 | 4041716360 | `harness/acceleratedRun.ts` | Resume never rehydrated the journal's open claims; the bay and mechanic stayed occupied for the rest of the run with no job to finish or release them. | High |
| 4 | 4041716228 | `harness/acceleratedLock.ts` | Stale-lock takeover overwrote unconditionally, so two runs reading the same dead holder could both hold the lock. | Medium |
| 5 | 4041716603 | `suites-accelerated/z-year-volume.accel.itest.ts` | Payroll compliance audit sampled ≤40 worked dates, so a violation on an unsampled date passed silently. | Medium |

### Accepted — robustness

| # | id | File | Finding |
| --- | --- | --- | --- |
| 6 | 4041716424 | `package.json` | Parity script relied on yargs consuming a following positional as a second `--testPathIgnorePatterns` value. The described failure **did not reproduce** (8 parity files collected, `z-year-volume` excluded), but the form is fragile and its silent failure mode is the parity gate running the 6-hour year test. Changed to two explicit `=` flags. |

### Rejected — with evidence

| # | id | File | Claim | Why rejected |
| --- | --- | --- | --- | --- |
| 7 | 4041716307 | `harness/acceleratedRun.ts` | "`appointmentsConverted` is not declared on `totals`, so the package fails TypeScript compilation" | It is declared on `YearRunResult.totals`. `tsc --noEmit` reports `No errors found`, and the `Lint, build and test` check was green on every push. No change made. |

## Code fixes completed

- `resourceLedger.ts` — running-furthest-end sweep in `overlaps()`.
- `acceleratedDayRunner.ts` — `claimableKind()` and a shared `workUntil()` used by
  both the open-day and closed-day paths; a closed day discovers, reconciles and
  starts mobile work, opens no shift and runs no maintenance.
- `acceleratedRun.ts` — stranded claims from an interrupted run are released on the
  backend, named in the log, and recorded as failures.
- `acceleratedLock.ts` — compare-before-unlink plus create-or-fail replacement in
  `takeOverStale()`; residual microsecond window documented as tolerated.
- `package.json` — parity script ignore patterns in the `=` form.

## Test fixes completed

New regression tests, 7 net:

- `resourceLedger.test.ts` — nested hold inside a longer one (the reviewer's exact
  example); a still-open hold against an earlier long one.
- `acceleratedLock.test.ts` — refuses when it loses the race to take over a stale
  lock, and the winner's lock survives.
- `acceleratedDayRunner.test.ts` — new mobile work after bay close; new mobile work
  on a closed day; no bay work on a closed day; nothing at all when
  `ITEST_ACCEL_MOBILE_AFTER_HOURS=false`; and the pre-existing grace test narrowed
  to bays so it asserts the bay rule rather than the absence of all work.

Two existing tests were updated because the *behaviour* deliberately changed
(a closed day now works mobile units). The rules they guard are still asserted: no
new bay work after close, no payroll shift on a closed day, no maintenance on a
closed day.

## Documentation corrected

- `README.md` — what a closed day does, and why no shift is opened on one.
- `BACKEND_INTERACTION_TEST_SPEC_ACCELERATED.md` — mobile intake out of hours,
  maintenance is worked-open-day only, and the payroll criterion says explicitly
  that it is checked over every worked date rather than a sample.

## PR comment thread coverage

| Thread id | Disposition | Reply id |
| --- | --- | --- |
| 4041716228 | Fixed | 4042015425 |
| 4041716307 | Rejected with evidence | 4042015571 |
| 4041716360 | Fixed | 4042015684 |
| 4041716424 | Changed (described failure not reproducible) | 4042015777 |
| 4041716482 | Fixed | 4042015858 |
| 4041716551 | Fixed | 4042015950 |
| 4041716603 | Fixed | 4042016048 |

All seven answered directly. Thread resolution is not available to this tooling for
bot-authored review threads, so the replies stand as the explicit status.

## Cycle 2 — adversarial pass over `d680cb1`

An independent reviewer was run over the remediation commit itself (the runbook's
`CODE_REVIEW_AGENT` step, served by an available agent). Verdict: **FAIL** — 2
BLOCKER, 6 MAJOR/MINOR. Three fixes confirmed correct as claimed (`resourceLedger`,
`z-year-volume`, `package.json`). Fixed in `86367bc`.

| # | Severity | Where | Finding |
| --- | --- | --- | --- |
| 1 | 🔴 BLOCKER | `acceleratedDayRunner.ts` | Mobile intake after bay close let the in-hours loop run to midnight, so `clockOut` stamped a payroll entry hours past close — the exact violation the now-exhaustive Z13 raises. Fixes 2 and 5 of cycle 1 were in direct conflict. |
| 2 | 🔴 BLOCKER | `acceleratedDayRunner.ts` / `acceleratedRun.ts` | The loop exited at midnight and `waitForNextDay` adds a day, so one virtual day was skipped per day worked; a 365-day run would span two calendar years and converge halfway. Verified against `nextUtcMidnight` directly. |
| 3 | 🟡 MAJOR | `acceleratedDayRunner.ts` | `now` stale after the `workUntil` extraction — shift-out and maintenance got the shop-*opening* instant. |
| 4 | 🟡 MAJOR | `acceleratedLock.ts` | `rmSync` had run when a non-EEXIST write failure propagated, leaving no lock file at all: mutual exclusion silently off. |
| 5 | 🟡 MAJOR | `acceleratedRun.ts` | Reclaimed workorders went into `failures`, so every resumed run was guaranteed to fail Z2 — the scenario the journal exists for. |
| 6 | 🟡 MAJOR | `acceleratedRun.ts` | "released ..." logged unconditionally, directly after the warnings saying it could not be released. |
| 7 | 🟡 MAJOR | `acceleratedRun.ts` | `recordOpenClaims([])` cleared stranded claims even when every release failed, destroying the record of which bay was stuck. |
| 8 | 🟡 MINOR | `acceleratedDayRunner.ts` | A closed day with an unreadable board reported success with no work and no failure. |

Also corrected: `d680cb1`'s message claimed "a run that loses either check refuses"
of the stale-lock takeover. The compare-before-unlink narrows that window but does
not close it, as the code comment already said. Acknowledged in `86367bc`'s message
and in a PR comment rather than by rewriting history.

## Cycles 3-7 — the close→midnight path, and a structural fix

Each cycle ran an adversarial pass over the previous cycle's commit. Every one returned
**FAIL**, and in cycles 2-4 each blocker had been introduced by the preceding fix — all in
`acceleratedDayRunner.ts`'s time bounds. That pattern was put to the user, who chose to
restructure rather than patch a fifth instance.

| Cycle | Commit | Findings | Verdict | What changed |
| --- | --- | --- | --- | --- |
| 3 | `0c1c056` | 1🔴 3🟡 4 MINOR | FAIL | Loop bounded at close, not close+grace (`withinGrace` is strict; `clockOut` takes no instant — the cycle-2 clamp was cosmetic). `dayEnd` recomputed after the wait. New `window-missed` skip reason. |
| 4 | `fe4ca9f` | 1🔴 3🟡 4 MINOR | FAIL | **Sequential clock-out fan-out exceeded the grace on its own** at documented scales (10 people × 15 virtual min at 4,380 = 146 min vs 90). Both fan-outs parallel. Bounds re-derived after the shift phases. Test assertions moved off the clamped value. |
| — | user decision | — | — | Grace model: finish **on the clock**, then clock out. Next step: **restructure** bounds into one value. |
| 5 | `7047aef` | 2🔴 4 MINOR | FAIL | **`daySchedule.ts` extracted** — every bound from one clock reading, re-derived after anything costing virtual time. Pass confirmed the mixed-reading defect class **gone** (areas 1,2,4,6 OK). Findings were in the new grace stretch: bound checked only between ticks. |
| 6 | `c232fea` | 1🔴 1🟡 7 MINOR | FAIL | Tick-cost prediction; but estimate was run-lifetime and starved later days (reproduced by probe: days 2-4 zero completions, work off the clock). Per-day reset; `kindLimit` gates advancement. **Verified by probe**: 42 steps, 0 off the clock. |
| 7 | `632e167` | 3🔴 4 MINOR | FAIL | `allowFirst` was a no-op; tick measurement re-read the clock (contradicting its own comment); **clock-out failures swallowed** (a regression — the audit skips entries with no `endAtUtc`, so a 500 produced a clean day). Feasibility now requires a step to fit the grace. |

Cycle 7's pass was the one the user set as the merge condition ("merge it if that pass
comes back clean"). It was not clean. **The PR is not merged.**

### Test discipline, recorded because it recurred

Five times a test of mine passed while the defect it existed to catch was live. The
mechanism was the same each time: asserting on a value the code had already sanitised
(a clamped instant, a free clock read, a scenario that never reached the code under
test). From cycle 6 on, each fix was verified by **probe** or by **stashing the fix and
running the new test against the pre-fix source**. Cycle 7's grace test passed pre-fix on
its first attempt for exactly this reason and was rewritten until it discriminated.

## Final verification

| Check | Result |
| --- | --- |
| `npx jest` (repo) | **908 passing**, 0 failing (857 before cycle 1) |
| `tsc --noEmit` (package) | No errors |
| `eslint . --ext .ts,.tsx` | No issues |
| Collection isolation | unit 0 `*.itest.ts`, integration 8 non-accelerated, accelerated 9, parity 8 |
| Regression tests added | 51 across seven cycles (19 on `daySchedule` alone) |
| Remediation cycles | 7; every reported finding fixed; **no pass returned PASS** |
| CI | green on every push, 9 consecutive |

## Unresolved blockers and owner

| Blocker | Owner | Note |
| --- | --- | --- |
| **No verification pass has returned PASS** | user | Seven cycles; findings narrowed from a recurring structural class (2-4) to one new feature settling (5-7). Cycle 7's fixes are test-verified in both directions, but not independently re-reviewed. The merge condition was a clean pass and was not met. |
| No accelerated backend deployed, so the suite has not been run end to end | reporter | Local Compose path is documented and verified; the completion criteria needing a real run are left unticked rather than assumed |
| Alpha accelerated deploy path | backend — `durion-positivity-backend#2065` | Does not block this PR |
| Cross-machine run exclusion | operations | Lock file covers one machine; the advisory URI is logged, not enforced |

## Processing log file path

`PR-Review-Processing.md` (repo root, untracked — a review transcript is not part of
the change under review).
