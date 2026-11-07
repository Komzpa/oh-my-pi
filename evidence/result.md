# Lead/worker harness — three fixes

PR: https://github.com/Komzpa/oh-my-pi/pull/92 (`topic/rt-agent-runtime-core`).
Started at `4347f6d1573363a8c4415113f30600e5f0314343` on `lane/workerask`.
Verified source head: `627068399f732f53aeb28641d237298a21d3baeb`.

## Request and boundary

Implement, in order: worker questions interrupt and park; requirement changes stay within exact user quotes; redispatch carries the previous same-row receipt. Owner approval supplied with the request: «чини чини чини».

No installation, updater, live/provider session, desktop operation, or intentional `~/.omp` mutation was performed. Tests used disposable/mock sessions. Only the requested fork branch was published. GitButler refused this linked worktree; its documented local-Git commit exception was used. The existing #92 history and authorship are preserved.

The historical DC lead journal was inspected read-only from its bounded tail (last 32 MiB): `/home/kom/.omp/agent/sessions/-proj-sunbim-datacenter-decision-graph/2026-10-31T13-18-21-335Z_01a1921c-7697-72a8-b4a3-4efdbbf06221.jsonl`. At 2026-11-07 08:08Z, PushFitCamera-10 reported two unanswered questions despite the fix/oracle existing on `cae9987d0`; at 08:25Z, LabelsBrowserProof-10 reported the unresolved PRD conflict. These are historical evidence, not a claim that a live session has been repaired.

## 1. Worker questions

Before: pending asks could consume yield retries or hit the runtime deadline; a churning row could outrank a question. Direct lead writes and incoming IRC answers were not retained as one question lifecycle.

After: structured asks and successful direct worker writes to the lead become pending obligations. The lead receives worker, question and proposed default as steering input and the last contextual input, ahead of dispatcher/time notices. Successful answer/reject writes to that worker discharge the obligation; prose, failed writes, unrelated dispatch and progress messages do not. Wait/yield are blocked and an unanswered turn triggers another lead turn. The same worker assignment parks without yield retries or runtime-deadline cancellation; explicit caller cancellation still works. A late terminal yield cannot finalize an unanswered ask.

A brief opts into defaults with `[worker-ask-defaults]`. The driver publishes “I will do X unless told otherwise”, applies only a noncritical proposed default after `OMP_WORKER_ASK_DEFAULT_WAIT_MS` (default 600000 ms), and records `worker-ask-default-applied`. A recommendation alone grants no authority.

Commits: `bb23bbe46d0`, `4eebe14e5a4`, `627068399f7`.
Regression: the current runtime-deadline test fails against the starting executor/ask implementation because the returned assignment is aborted; it passes at head. Priority, real answer/reject, direct IRC, cancellation and authorized/default-negative cases also pass.

## 2. Requirement quote authority

Before: “solar should not block levels” could widen into “levels never refused”; a passing audit had no required quote/diff comparison, and a worker contract conflict could be redispatched without a recorded resolution.

After: requirement-editing rows carry linked ledger `rawText` verbatim, never the synthesized requirement. Missing quotes refuse dispatch. The requirement auditor compares every changed requirement hunk to quote IDs; omitted comparison is inconclusive and widening fails even when executable checks pass. Its row/head/delivery-bound diff receipt reaches the existing plan critic; stale receipts are excluded. A returned `BLOCKED_BY_CONFLICTING_PRODUCT_CONTRACT` refuses redispatch until the lead records a tool resolution bound to that row, conflict and quote snapshot, or obtains clarification through the existing owner `ask` path. New/changed quotes invalidate an old resolution. Physical infeasibility remains a conflict; solar artefacts do not authorize hiding it.

Commits: `e3c59156eb1`, `372bfa4e440`.
Regression: the current quote-audit test fails against the starting `row_audit.ts`, which accepts a pass without any quote comparison. Head rejects missing comparison, fails the widened clause, and accepts the solar-only change. Conflict/tool resolution and critic receipt tests pass.

## 3. Previous attempt receipt

Before: a redispatched brief could say the fix and oracle were missing after a previous worker had already delivered them.

After: the registered task-dispatch hook adds the latest finished same-row attempt's status, commits/paths/findings, rejection/audit failure and open blocker to its brief. A prior attempt without findings refuses dispatch, including when staffing gates are disabled. Frozen owner state and provider arguments are preserved. A different row's receipt cannot satisfy it.

Commit: `a665b1608eb`.
Regression: the registered dispatch test fails against the starting `todo_dispatch.ts`, which allows a retry without findings. Head refuses it, then attaches `cae9987d0`, the failed screenshot and camera question once the receipt exists. Latest-attempt selection and unrelated-row controls pass.

## Verification

Source checks on `627068399f732f53aeb28641d237298a21d3baeb`, 2026-11-07 UTC:

| Check | Result |
| --- | --- |
| Full `bun test --parallel packages/reemxy-extensions/extensions/*.test.ts` | 701 pass, 0 fail; 65 files; 10020 assertions |
| Coding-agent todo/task/subagent selection, exact ordered paths in `workerask/core-files.txt` | 1382 pass, 67 fail; 1449 tests, 136 files |
| Same suite against starting implementation | 1375 pass, 67 fail; 1442 tests, 135 files; exactly the same 67 failure names, no new failures |
| Focused final regressions | 21 pass, 0 fail; 5 files |
| Executor question + prompt-cache integration | 38 pass, 0 fail; 2 files |
| Three negative controls | One concrete regression per item fails with its relevant starting implementation restored; all files restored before head checks |
| `bun run check:ts`, `git diff --check` | Pass |
| `bun check` | Not green: inherited Rust comment formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; no Rust/Cargo delta in these fixes |
| Canonical `tools/omp/stack_check.py`, whole 77-entry live manifest, candidate override | Current upstream stops at pre-existing #16530 in `task/index.ts`, before #92 |
| Same canonical checker and manifest, pinned starting upstream `9370e7bfe26e948d72f53f918e681b402e600383` | All 77 entries merge cleanly; original #92 also passes on this base |

The pinned-base rehearsal imports the canonical checker and substitutes only its `rev-parse FETCH_HEAD` result; it does not change the live manifest or refs. Stack integration exposed #93/#108/#146 interactions; the question-parking placement now composes with all 77 entries. The live-manifest SHA-256 is recorded in `workerask/suite-comparison.json` with the exact baseline/head failure names, log hashes and summaries. The intentional `Cannot find module './gone'` worker-death fixture is followed by its passing startup-failure test; it is not one of the suite failures.

Reproduce the selected suite with `bun test $(cat evidence/workerask/core-files.txt)`. Negative-control logs, final regression output, both stack outputs and the forge source-head readback are committed under `evidence/workerask/`. No live model judgment or installed-runtime behavior is claimed.

## Publication readback

The source was pushed to `fork:topic/rt-agent-runtime-core` using exactly `--force-with-lease=refs/heads/topic/rt-agent-runtime-core:4347f6d1573363a8c4415113f30600e5f0314343`. Both `gh pr view 92 --repo Komzpa/oh-my-pi` and `git ls-remote fork refs/heads/topic/rt-agent-runtime-core` returned `627068399f732f53aeb28641d237298a21d3baeb`; PR #92 was OPEN. See `workerask/source-pr-readback.json`.

This evidence-only commit follows that verified source head and is published with a lease against it. Its final PR-head readback is reported in the delivery response, avoiding a self-referential commit hash in this file. The rollback source target remains the starting `4347f6d1573363a8c4415113f30600e5f0314343`; it has not been applied.
