# History-calibrated automatic TODO deadline — PR #92

Objective: forecast automatic deadlines from the lead's measured history rather than repeated short remaining estimates; retain the first anchor through plan churn, report appended scope, and surface estimate-honesty defects. Owner: `topic/rt-agent-runtime-core`, fork PR #92. Starting/rollback head: `b9448c1fa29260129246326ff80eed890e8ed47e`. All original commits/authorship retained. `but status` and `but commit` refused this linked worktree (“non-main worktrees are not supported”), so the worktree-local Git exception was used.

## Behavior

The existing canonical `forecastTodoPlan` now takes the sum of actual first-estimate-to-completion elapsed seconds divided by the sum of first likely estimates, bounded to 1–20. Eligible samples are the most recent 32 completed rows within 72 hours, excluding future/missing completion clocks and missing/invalid first estimates. The factor applies to open estimates, including legacy rows without a first-estimate record. After two revisions, a row's remaining floor is elapsed requirement age / cumulative reestimates; failed or rejected attempts also impose their maximum measured duration as a remaining floor. These are conservative heuristics, not fitted statistical percentiles.

Throughput uses distinct completed row identities within 24 hours, including simultaneous batch closures. At least three closures and one hour of observation are required. The first closure establishes the observation clock; the rate is `(closures - 1) / hours from first closure to now`, including any subsequent stall. The deadline forecast is the maximum of calibrated analytical PERT and `now + openRows / measuredRowsPerHour`. Required unresolved work keeps the full deadline forecast unknown. Analytical P95 fields retain their meaning; `autoDeadlineForecast` exposes the selected finish, winning bound, both finishes, measured rate/window/sample count, open count and each row's age/revisions/failed-attempt floor and honesty defects.

The dispatcher now supplies archived completions to the forecast through the existing `withTodoArchive` owner, retaining live-over-archive identity precedence and hiding archive rows from the live forecast display. Without this change, archiving could erase the session's completion calibration. The automatic deadline caller consumes the conservative finish. Its time-note formatter and plan-doctor snapshot include the winning bound, calibration factor and samples, rows/hour, closure count, and named estimate-honesty defects. Pessimism below row age or no greater than a failed/rejected attempt is defective even when the revised ETA is in the future. Exhaustion warnings now survive that revised ETA too.

Active anchors already had a no-rolling-target guard at the starting head. This patch adds durable anchor membership and cumulative appended-scope identities; it also recovers inactive checkpoints with a retained baseline while an original row remains open, decoding legacy plan keys when needed. Scope additions and estimate/dependency/phase-key changes preserve `goalStartedAt`, baseline and stage deadlines. The time note reports scope growth against that anchor. It does not reconstruct an already deleted historical baseline from outside the supplied state or undo old live re-anchors.

## Replay and negative controls

Portable synthetic DC-shaped replay: seven rows aged 12–17 hours, 6–16 reestimates, likely 30–50 minutes and pessimistic 60 minutes; eight closure observations spanning ten hours give seven intervals, **0.7 rows/hour**. The fixture retains requirement age but uses a current worker start and missing legacy first estimates, exercising the vulnerable short-remaining path without inventing unavailable original estimates. It is a shape replay, not the full private DC session. `../dc-est.stats.json` has aggregate counts and no eligible estimate/actual pairs, so it cannot itself supply row clocks.

On the starting implementation, the same fixture forecasts **2.242478 hours** ahead. On candidate, calibrated PERT is **4.161520 hours** and the throughput bound wins at **10 hours**, exactly `7 / 0.7`. The baseline test explicitly asserts the delivered deadline/analytical fallback must be at least ten hours and fails on 2.24 hours; the candidate passes. Baseline source is loaded as a temporary sibling module with unchanged dependencies and removed in a `finally` block. Replay runner: `../evidence/calibforecast-baseline.py`; outputs: `calibforecast-replay-{base,head}.log` in that directory.

Controls cover too few closures, unresolved rows, first-budget sum calibration, stale/future completion exclusion, failed-attempt duration, simultaneous closures and duplicate identities, archived closures without visible resurrection, real-goal authority, unchanged/missed anchor, legacy inactive checkpoints and appended scope. Existing clock/calibration fixtures were adjusted to use observed rather than future completions. The prior idle-recovery replay now explicitly focuses a goal without a deadline so automatic deadline creation does not change its independent idle-demand contract. New and changed tests were read against these observable contracts; no tests grep implementation source.

## Verification

Verified source candidate `0de5e6a0ee5f60428b9d6cccfc42ba14f31d1e30`; the publication descendant adds this evidence only:

```sh
bun test --timeout 120000 packages/tui/test/todo*.test.ts packages/coding-agent/test/todo*.test.ts packages/reemxy-extensions/extensions/goal_deadlines.test.ts packages/reemxy-extensions/extensions/todo_dispatch*.test.ts packages/reemxy-extensions/extensions/todo_calibration.test.ts packages/reemxy-extensions/extensions/missed-demand-replay.test.ts
```

**586 pass, 0 fail**, 9,675 assertions, 52 files. Log: `../evidence/calibforecast-suite-delivery.log`. Dedicated replay: **13 pass, 0 fail** across two files. `git diff --check` passes.

`bun check` passes TypeScript lint, formatting and all package type checks. Overall exit **1** solely on pre-existing Rust formatting in `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`, unchanged from the starting head. Log: `../evidence/calibforecast-delivery-check.log`. No Rust source was changed or rebuilt by this lane. The installed rustfmt 1.11.0-nightly (ea137335b7, 2026-10-05) documents that `--check` exits 1 and prints a diff when formatting is required; source: captured `rustfmt --help` in [calibforecast-rustfmt-tool-help.log](../../evidence/calibforecast-rustfmt-tool-help.log). No further retry or unrelated Rust reformat was attempted.

Read-only live manifest SHA256: `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`, **77 PRs**, exact manifest order. Fork main `9370e7bfe26e948d72f53f918e681b402e600383`. All inputs fetched only through fork, frozen before assembly; 77/77 pinned heads are ancestors of the full composite. Only the known generated catalog `rules.json` overlap is allowed and regenerated from KDL in the disposable composite.

| Composite | Commit | All package types | Focused runtime |
| --- | --- | --- | --- |
| main + #92 | `d190fb7ea6ae8120588f3a5673affa06a156cafd` | PASS | 113 pass, 0 fail |
| main + all 77 PRs | `c81eb95d788b3cefcb001242a41cc595b9580390` | PASS | compiled SDK below |

Type command: `bun run --filter './packages/*' --sequential --if-present check:types`. Scripts/manifest/heads/merge ledger/results and logs are under `../evidence/calibforecast-{final,accepted,delivery}-*`. Disposable worktrees share external dependencies and the pre-existing native addon; workspace package imports resolve within each worktree. Canonical `stack_check.py --no-fetch --candidate topic/rt-agent-runtime-core=0de5e6a0ee5` passes all 77 PRs with FETCH_HEAD explicitly fetched from fork main. No upstream network operation or upstream branch mutation, updater, installation, real-home configuration write, live session or desktop action was performed.

Publication target is only `fork/topic/rt-agent-runtime-core`, a fast-forward descendant, with the exact lease against the starting head and `OMP_UPSTREAM_PR_PUSH=topic/rt-agent-runtime-core`. Remote-ref and PR #92 head readback go to `../evidence/calibforecast-publication.log`. No PR body/comment or main ref is edited.

## Compiled SDK acceptance

**PASS**, exit 0, canonical proof `ok: true`, on full composite `c81eb95d788b3cefcb001242a41cc595b9580390`. Binary SHA256: `6c117406bfa0f8e394fa7f73871dbe6cbf6324413dded2c332130a5156c8a5a1`. Built with that composite's `compileCodingAgent` helper and real build plugins, using the pre-existing native addon. The runner loads only canonical `tools/omp/source_update_acceptance.ts`, in a lane-owned disposable HOME/XDG tree with a dummy nonfunctional API key, `--no-session`, `--no-tools`, `--no-lsp`, `--no-pty`, `--no-extensions`, `--no-skills`, and `--no-rules`. It shuts down at session start without submitting a provider prompt. SDK deadline/PERT/resource/unknown-work, completion, restart-drain, extension lifecycle, native glob and streamed cancellation checks pass. No updater or installation runs.

Build entry: `../calibforecast-delivery-full/.calib-compile.ts`; runner/proof/output/hash: `../evidence/calibforecast-delivery-{acceptance.py,compiled-proof.json,compiled-output.log,compiled-sha256.txt}`. This validates the compiled SDK contract; the source runtime tests above validate the extension's new deadline selection and scope behavior.

## Risks

Row throughput assumes broadly comparable row sizes; decomposing or batching heterogeneous work changes its usefulness. Wall-clock age includes waiting and time away. Sparse or older-than-window history cannot provide a throughput bound; those cases use calibrated PERT and expose missing rate evidence. Age/revision floors and 1–20 calibration bounds are explicit heuristics. Existing active automatic anchors stay fixed rather than moving to the newly measured forecast. This is replay/source/composite proof, not a live DC session observation.
