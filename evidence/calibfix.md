# Row-local forecast calibration — PR #92

Objective: fix the 18:11 DC forecast overshoot after splitting work into small steps. Darafei's correction: «я столько не просил всего чтобы хуяк и вместо семи вечера три часа ночи». Live note supplied by the lead: 03:03, calibration ×6.96 from 9 rows, 1.05 rows/hour from 25 closures. This lane uses portable shape replays, not the private live session. Owner is fork `topic/rt-agent-runtime-core`, PR #92. No installation, updater, real-home configuration, live-session or desktop mutation is authorized or performed.

Starting head/rollback: `eb54c7ed64b50d5355988224d30163bf3801c050`. Another lane advanced the topic to `8149532aecec1add07bd6f112e6b480d2ce98f91`; all three commits were retained whole. The two forecast commits rebased byte-identically (`git range-diff` reports `=`), followed by a fixture type correction. GitButler status and commit both refuse this linked worktree; the documented local Git exception was used. Publication is fast-forward only with the exact observed lease. Rollback requires an owner-approved follow-up/revert; never overwrite the concurrent writer.

## Decision and behavior

Judgment source: `python3 /home/kom/Dropbox/Reemxy/tasks-loop/tools/codex/lane_ask.py`, context `../brief-calibfix.md`. The question supplied the old global sum-ratio defect, proposed weighted median, fresh cap, fresh throughput cap and aged-plan maximum, plus the concurrent-writer rebase question. DECISION: “Accept the per-row, age- and size-comparable weighted-median ratio with the proposed row-local cap and escalation; cap fresh-plan throughput ETA at row-local PERT.” It also says to keep `max(row-local PERT, throughput)` for slipped plans and permits raw Git rebase only when the other lane moved the topic, preserving its whole branch.

Canonical owner `packages/tui/src/tools/todo-schedule.ts` now uses the median per-row actual/first-likely ratio over at most 32 distinct eligible closures within 72 hours. Missing, future, invalid and stale clocks are excluded before sample selection. Row-local weighting is `1 / (1 + abs(log(size ratio)) + abs(log(age ratio)))`, with +1-second smoothing. Session median remains diagnostic; it is no longer a universal duration multiplier. Each row uses its weighted history capped at ×2 until its own original pessimistic budget is exhausted or it has a failed/rejected attempt. Beyond that, age/original-pessimism, cumulative revisions and failed attempts permit escalation, retaining the existing age/revision and failed-duration remaining floors. These are explicit heuristics, not fitted probabilities.

With at least three closures over one hour, measured pace is retained. Slipped plans use the maximum of row-local PERT and measured throughput; fresh plans cap the count-derived throughput finish at row-local PERT. Thus splitting fresh work does not create extra count-derived delay. Unresolved work still has no complete forecast. Row factors expose applied calibration and slippage, and the Monte Carlo simulation uses the same row-local cap; its cache includes the effective row ratios.

## Replays and assertion review

- 18:11 shape: four rows with the supplied likely/pessimistic budgets, ages 0.1/0.5 hours, pipeline→fold dependency, five workers, nine 20–52-hour historical misses at ×6.96 and 25 closures at 1.05/hour. Candidate finish is **20:38:52 local** (16:38:52Z), within [19:15, 22:30]. Original implementation fails the upper bound, forecasting after 03:00. This is a shape replay; optimistic estimates and historical clocks are synthetic.
- Earlier DC shape: seven rows aged 12–17 hours, 6–16 revisions, eight closures defining 0.7/hour. Deadline remains **10 hours** ahead, at least `7/0.7`; local PERT is 4.16152 hours.
- Splitting one fresh deterministic one-hour row into two sequential half-hour steps preserves the deadline even with slow closure history; with no history both forms finish exactly one hour ahead. This test fails on the old count-based maximum.
- Comparable small on-time closures protect the pipeline finish from giant-history inflation; duplicate identities do not alter the forecast. Own-budget exhaustion permits escalation beyond ×2. Failed-attempt floors, future/stale exclusions, insufficient history and unresolved-work controls remain.
- Existing risk test now asserts the observable ×2 fresh-prior P50 instead of ×3. Archive-pace integration fixture now declares real slippage (12-hour age, six revisions), retaining the assertion that archived pace reaches the automatic goal without resurrecting archived display rows.

All added/changed assertions were inspected: they exercise deadline bounds, split invariance, row finish, simulation output, sample exclusion, local escalation, or archive-to-goal delivery. No source-text tests or placeholder checks were added.

Logs, replay runners and assembly/acceptance scripts are preserved in the lane's sibling `../evidence/calibfix*` paths. Baseline replay loads the unchanged `eb54c7ed` module as a temporary sibling with unchanged imports, runs the new tests and removes the files. `calibfix-base-replay.log` captures expected failures; `calibfix-replay.log` and the final suite log provide candidate results.

## Verification

Source candidate: `ad0430190f1a072ab39a1ecfa33abd0d7ac9f8ec`; the delivery commit adds evidence only.

```sh
bun test --timeout 120000 packages/tui/test/todo*.test.ts packages/coding-agent/test/todo*.test.ts packages/reemxy-extensions/extensions/goal_deadlines.test.ts packages/reemxy-extensions/extensions/todo_dispatch*.test.ts packages/reemxy-extensions/extensions/todo_calibration.test.ts packages/reemxy-extensions/extensions/missed-demand-replay.test.ts
```

**590 pass, 0 fail**, 9,690 assertions, 52 files (`../evidence/calibfix-delivery-suite.log`). Dedicated replay/risk suite: **16 pass, 0 fail**, 55 assertions (`calibfix-replay.log`). Baseline: 4 pass, 5 expected failures, including the evening upper bound and split deadline invariance (`calibfix-base-replay.log`).

`bun check` passes TypeScript lint, formatting and every package type check. Overall exit 1 is restricted to unchanged base Rust formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; these two files are byte-identical to the starting head. Log: `calibfix-delivery-check.log`. No unrelated Rust changes were made. Changed-file base formatting passed before oxfmt; `git diff --check` passes and normal/whitespace-ignored stats were compared for churn.

The manifest contains **77 PRs**, SHA256 `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`. All 77 frozen fork heads are ancestors of the full composite. Only generated `rules.json` overlap was allowed and regenerated from KDL. Fork main was `9370e7bfe26e948d72f53f918e681b402e600383`.

| Composition | Commit | Verification |
| --- | --- | --- |
| main + #92 | `9598b2d33e515d42c69048f92961629a3edb0e1d` | package types and focused runtime |
| main + all 77 PRs | `620d424ad43cf5aad4236afae81562f91f44950f` | package types |

Command: `bun run --filter './packages/*' --sequential --if-present check:types`. Assembly ledger, frozen heads, manifest and results are in `calibfix-delivery-{merges,heads,manifest,results}.json`; scripts and logs share that prefix. Dependencies and the pre-existing native addon are reused from the supplied checkout; no native sources changed in this lane. Canonical `stack_check.py --no-fetch --candidate topic/rt-agent-runtime-core=a4686896089323f05f597c1f8597b9c865fe7eeb` passed all 77, with FETCH_HEAD fetched explicitly from fork main.

## Scope limit accepted by the lane owner

A final `lane_ask.py` scope check supplied the explicit limitation that mixed slipped+fresh plans still use the raw open-row throughput count and that the schema carries no split-parent identity. DECISION (`../evidence/calibfix-scope-decision.log`): “Deliver the bounded fresh-plan fix and document the mixed-plan and split-ancestry limitations.” It states that adding work tracking exceeds scope. The split-invariance proof therefore covers fresh plans, including the reported DC shape. Arbitrary splitting in mixed/slipped plans remains sensitive to row granularity. This limit is not presented as solved.

## Compiled SDK acceptance

**PASS**, process exit 0 and canonical proof `ok: true` on full composite `620d424ad43cf5aad4236afae81562f91f44950f`, binary SHA256 `753a086c872976350c0f480a1557e6a9fc4461c35d9274430a3130e9910eccce`. The composite's `compileCodingAgent` helper uses the real build plugins and pre-existing native addon. An initial invocation from the lane root failed to resolve virtual-module imports; running the same build from the composite cwd succeeded. No source workaround or installed binary replacement was used.

The canonical `tools/omp/source_update_acceptance.ts` runner ran in a lane-owned disposable HOME/XDG tree with a nonfunctional dummy API key and `--no-session --no-tools --no-lsp --no-pty --no-extensions --no-skills --no-rules`. It exits on session start before a provider prompt. Goal/deadline/PERT/resource/unknown-work, completion, restart-drain, extension lifecycle, native glob and cancellation checks passed. No real-home write, provider request, installation or updater was involved. Build entry: `../calibfix-delivery-full/.calibfix-compile.ts`; proof, runner, output, hash and logs: `../evidence/calibfix-delivery-{compiled-proof.json,acceptance.py,compiled-output.log,compiled-sha256.txt,compile.log,acceptance.log}`.

Publication target: only `Komzpa/oh-my-pi:topic/rt-agent-runtime-core`, PR #92, exact lease against `8149532aecec1add07bd6f112e6b480d2ce98f91`, fast-forward ancestry required. Publication/readback receipt: `../evidence/calibfix-publication.log` and `calibfix-pr-after.json`. No PR body, comment, upstream or main mutation is performed.
