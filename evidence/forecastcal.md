# Shared forecast calibration, PR #92

Follow-up to `cb7709d05a7dd0da37638c699e2ce430fd8c7d1e`. Source candidate `8a289a7d596`; fork/main `9370e7bfe26e948d72f53f918e681b402e600383`. Fetch + rebase was a no-op. Publication target is only `fork/topic/rt-agent-runtime-core`; old head/exact lease is `cb7709d05a7dd0da37638c699e2ce430fd8c7d1e`. The candidate is a fast-forward descendant. Rollback target is the old head, only with a fresh exact lease; no main or upstream mutation.

## Runtime path and collector

Forecast code owns `getAgentDir()/forecast-calibration/encodeURIComponent(TODO_PREDICTION_VERSION).jsonl`. On this host the existing path helper resolves it to `/home/kom/.omp/agent/forecast-calibration/residual-beta-pert-v1%2Fsession-hour-all-prior-q80-v1.jsonl`. We did not write there.

TODO terminal settlement/censoring appends a schema-v1 observation using one O_APPEND write. Immutable predictions retain current scheduler version, membership, raw P50, capacity, provenance and observation clocks. Two actual processes wrote 200 complete lines concurrently without loss or interleaving. Reads are asynchronous, single-flight, bounded to 16 MiB + one byte, and warm at tool construction / refresh at TODO mutation. Render uses the cache. An oversized store fails closed with a warning rather than silently introducing a rolling population. Records larger than 64 KiB are refused. Version mismatches and censored/future labels cannot enter calibration; strict `observedAt < origin` applies.

The offline collector streams frozen journal prefixes with the existing TODO reconstruction and the shipped `forecastTodoPlan`, taking the first hourly origin with an available raw forecast. It retains compact state and frozen targets, never a whole journal. Missing capacity is 32, explicitly marked assumed. Exact phase/text/duplicate ordinal defines identity; replacement, init, abandonment and unresolved membership censor targets. Completed members remain observed after later archival. Fixtures are excluded via the research manifest or explicit harness marker combined with temporary/harness cwd; temporary names alone are retained. No research model predictions or row multipliers are imported.

## Reproduction and seed after installation

Read-only source collection executed against real journals under `~/.omp/agent/sessions`, with the research manifest's frozen boundaries:

```sh
bun scripts/seed-todo-calibration.ts --manifest /home/kom/proj/ai_pr/forecast-research-20261107/work/scan-manifest.json --output /tmp/omp-pr92-replay-v3-seed.jsonl --report /tmp/omp-pr92-replay-v3-report.json
bun evidence/forecast-replay.ts /tmp/omp-pr92-replay-v3-seed.jsonl
```

**Babysitter command after installing this source revision**, from this checkout (not executed here):

```sh
bun /home/kom/proj/ai_pr/omp-workerask-20261107/oh-my-pi/scripts/seed-todo-calibration.ts --root "$HOME/.omp/agent/sessions" --report /tmp/omp-forecast-seed-report.json
```

Omitting `--output` deliberately selects exactly the runtime helper's versioned store path. Run with the same profile/environment as the installed runtime. New sessions warm that store; an existing new-version session refreshes at its next TODO mutation. Re-running appends duplicate observations, which calibration deduplicates by session-hour; it does not truncate the store. Details and fixture reproduction are in `packages/coding-agent/test/fixtures/todo-plan-replay/README.md`.

## Measured replay

Frozen research snapshot: 2026-11-07 14:53:56 UTC. Final replay: 22,827 inventoried files, 152 exclusions, 28,505,328,127 bytes / 4,177,624 lines streamed; zero malformed candidate records / nonmonotone TODO events. Current scheduler produced **1,021 origins in 107 sessions**, with **455 closed and 566 censored**. A fresh runtime-store instance re-read **455 settled origins in 70 sessions**. These differ from the research Python baseline because only the shipped scheduler's available raw forecasts are eligible.

The chronological later 20% slice starts at `2026-10-23T22:04:32.710Z`: **62/78** settled/scored origins covered across **21 sessions**, **79.49% origin-weighted / 83.07% equal-session coverage**. Earlier outcomes in the later slice enter calibration only after observation. This is exploratory recorded TODO-closure coverage, not accepted delivery or an untouched prospective validation. All-prior displayed coverage (263/434) differs materially; no 80% delivery probability is claimed. Both DC sets remain censored; no unobserved 20:00 finish is used as a label.

## Exact DC notes

### 11:12

Before (empty branch-local history):

> Current set: point 2026-11-07 13:37:02 Asia/Tbilisi; empirical upper unavailable (insufficient calibration; 0 origins, 0 sessions). Driver: 11 MW Adaptive: Level 2/3 buttons still draw Level 1 floor → Levels that cannot fit show as conflict/risk, not silent revert → Collateral for "Maksim: Building layout broken, model incomplete": After applying two levels, the camera loses the building overview: the enlarged model extends beyond the viewport and dense communication pipes obscure the racks. Before, the building footprint and surrounding equipment were visible together. → Collateral for "Maksim: Building layout broken, model incomplete": After applying two levels, the camera loses the building overview: the building extends beyond the narrow viewport, leaving only part of the floor visible and communication pipes covering much of the rack area. Before, the whole building footprint was visible. (owner FitCameraAfterLevels); empirical allowance unknown. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 0m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

After (real replay seed, as-of filtered):

> Current set: point 2026-11-07 13:37:02 Asia/Tbilisi; empirical upper 2026-11-07 15:24:51 Asia/Tbilisi (experimental; observed coverage 263/434, 70 sessions). Driver: Collateral for "Maksim: Building layout broken, model incomplete" (owner FitCameraAfterLevels); empirical allowance 1.80h. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 0m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

Synthetic fixture-only integration control: Current set: point 2026-11-07 13:37:02 Asia/Tbilisi; empirical upper 2026-11-07 15:37:02 Asia/Tbilisi (experimental; observed coverage 25/25, 5 sessions). Driver: Collateral for "Maksim: Building layout broken, model incomplete" (owner FitCameraAfterLevels); empirical allowance 2.00h. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 0m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

### 18:11

Before (empty branch-local history):

> Current set: point 2026-11-07 19:06:43 Asia/Tbilisi; empirical upper unavailable (insufficient calibration; 0 origins, 0 sessions). Driver: Cooling: PR 114 pipeline on bfbabf30d read back → PR 115 folded into PR 114, 114 mergeable onto main (owner FoldPr115IntoPr114); empirical allowance unknown. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 255m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

After (real replay seed, as-of filtered):

> Current set: point 2026-11-07 19:06:43 Asia/Tbilisi; empirical upper 2026-11-07 20:54:32 Asia/Tbilisi (experimental; observed coverage 263/434, 70 sessions). Driver: PR 115 folded into PR 114, 114 mergeable onto main (owner FoldPr115IntoPr114); empirical allowance 1.80h. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 255m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

Synthetic fixture-only integration control: Current set: point 2026-11-07 19:06:43 Asia/Tbilisi; empirical upper 2026-11-07 21:06:43 Asia/Tbilisi (experimental; observed coverage 25/25, 5 sessions). Driver: PR 115 folded into PR 114, 114 mergeable onto main (owner FoldPr115IntoPr114); empirical allowance 2.00h. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 255m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

Fixture coverage 25/25 is synthetic and is not empirical validation. Raw P50/P80 are unchanged in both states. Driver now contains only the final critical row, at most 80 title characters plus owner; the structured collateral subject drops its explanation, and no arrow chain remains.

## Verification and limits

- TODO/dispatch suites: **692 pass, 0 fail, 10,020 assertions, 60 files**. Final focused rerun after cache-warm integration adaptation: **115 pass, 0 fail, 376 assertions, 5 files**. Includes shared-store strict-as-of/future invariance, ignored versions/censoring, process append atomicity, streamed seed fixtures, reset/replacement/compact continuity and both exact DC states with a sufficient scratch seed. Negative controls disabling the shared snapshot, reset censoring, narrowing of fixture exclusion, and short Driver behavior each fail the relevant test; restored implementations pass.
- `bun run check:ts` passes (lint, formatting, all package type checks). Full `bun check` stops only on base Rustfmt comment wrapping at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; neither file changed from the predecessor. The check command and `bun run --help` were inspected (Bun 1.4.4; https://bun.com/docs/cli/run); no repeated retry or unrelated Rust edits.
- Frozen **77/77** predecessor PR heads, with only PR #92 replaced by `8a289a7d596`, are ancestors of composite `5fb5e0ef1d16f7a6eeb9dda6841b647c7ed06831`. All package type checks pass there. Workspace dependency links resolve into that throwaway checkout. Frozen dependency install refused catalog/lock drift; existing dependency files were hard-linked without changing tracked source/lockfiles. The composite is clean. The inherited generated-rules merge exception remains confined to rules.json as in the predecessor assembly.
- Fresh fork-head union reaches PR #168 (`topic/usage-shared-backoff`) then conflicts in peer-owned `turn-recovery.ts` / `agent-session-retry-fallback.test.ts`. Canonical `stack_check.py` against fresh upstream stops earlier at #16651 in `task/executor.ts`. Neither surface belongs to forecastcal. Frozen composite success is not a claim that the moving live stack is installable. No peer branches were repaired.
- No install/updater, private config/store writes, live sessions or desktop operations. Large private seed data remains scratch-only. Machine logs, manifests, exact merged heads, range-diff and replay reports are retained in sibling `../evidence/forecastcal-*` files.

## Required decisions

The mandated `lane_ask.py` was run with `brief-forecastcal.md` and source evidence. Exact first-line decisions, with receipt names:

- `forecastcal-git-decision.txt`: DECISION: Yes—rebase and push the preserved PR branch with the requested exact lease, and run the explicitly required throwaway 77-PR composite type-check without installing anything system-wide.
- `forecastcal-replay-decision.txt`: Command:
- `forecastcal-check-decision.txt`: DECISION: Yes—document the two base-only Rustfmt failures and continue toward the branch push after the required TODO/dispatch suites and composite type-check pass.
- `forecastcal-title-decision.txt`: DECISION: Yes—keep `Collateral for "Maksim: Building layout broken, model incomplete"` as the structured title and strip the prose after the quoted subject.
- `forecastcal-composite-decision.txt`: DECISION: Yes—integrate the narrow adaptation on PR92.
- `forecastcal-composite-pins-decision.txt`: DECISION: Yes—reproduce the predecessor’s frozen 77 heads with only PR92 replaced by the current candidate, and document the current-live union conflict as peer-owned.

- `forecastcal-bounds-decision.txt`: DECISION: Yes, bounded fail-closed behavior satisfies the goal without adding retention or compaction policy in this lane.

These are scope/method decisions; push authority is the raw user instruction. Publication readback is recorded separately after pushing.
