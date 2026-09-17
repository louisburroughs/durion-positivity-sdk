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

## Final verification

| Check | Result |
| --- | --- |
| `npx jest` (repo) | **864 passing**, 0 failing (857 before the fixes) |
| `tsc --noEmit` (package) | No errors |
| `eslint . --ext .ts,.tsx` | No issues |
| Collection isolation | unit 0 `*.itest.ts`, integration 8 non-accelerated, accelerated 9, parity 8 |

## Unresolved blockers and owner

| Blocker | Owner | Note |
| --- | --- | --- |
| No accelerated backend deployed, so the suite has not been run end to end | reporter | Local Compose path is documented and verified; the completion criteria needing a real run are left unticked rather than assumed |
| Alpha accelerated deploy path | backend — `durion-positivity-backend#2065` | Does not block this PR |
| Cross-machine run exclusion | operations | Lock file covers one machine; the advisory URI is logged, not enforced |

## Processing log file path

`PR-Review-Processing.md` (repo root, untracked — a review transcript is not part of
the change under review).
