# Already missed deadline recovery on load — PR #92

Objective: replay `../dc-journal-tail-1545.jsonl`, repair missed-deadline and idle-ready startup demands, retain the original 516 tests, prove main+#92 and the 77-PR manifest composite, and fast-forward only `fork/topic/rt-agent-runtime-core`. No install, updater, live-session, desktop, real-home configuration or other topic-branch mutation.

Starting/rollback head: `fcdb4f7aea709ba0d5fca46ee44cea5481fa3c13`. Source candidate: `c17bc21781fac2af966c7e84f30a45bcca14872a`. The evidence-only descendant has identical source. `but commit` refused this linked worktree (“non-main worktrees are not supported”), so the skill's worktree-local Git exception was used. Existing commits/authorship are preserved.

## Root cause and replay

The journal SHA256 is `eccde24cdd6fa7e33924f15aca8850cc01789e7ce938185a9818ad7f97ba44e1`. Line 2781 holds the active **automatic** deadline: `auto: true`, `goalId: auto-todo-plan`, `baselineDeadlineAt: 1794045428` = **13:57:08 +04**. It is not a newly observed slip step or user-constraint entry. The goal deadline extension recognizes this state and renders MISSED. The native host `readGoalDeadline` ignores it without an active native goal. The dispatcher selected that native reader, losing the anchor even though its local extension reader understood it. Its existing `pendingAutoForecastMissAt` path could report a miss, but supplied no deadline to `recoveryDemand`.

A second gap: session load reset the observer but did not call it. Initial idle age and deadline recovery depended on a subsequent turn or wake. Finally, CHURN/chain/question selection hid the strict recovery action in the single visible action slot, even when a strict pending recovery existed.

The fixture is reduced from the latest full TODO snapshot at line 6329 plus compact custom edits **and TODO tool-result edits** through line 7146, using the real `getLatestTodoPhasesFromEntries` reducer. It retains the actual automatic deadline/plan key, closed row identities, open row estimates, resources, executor/audit state and churn counters. Irrelevant receipt prose and closed-row schedule history are omitted. At startup the controlled job snapshot is empty and capacity is six; this exercises spare-capacity resume without inventing historical idle age. Extraction inputs/script/log are under `../evidence/misseddemand2-*`; the committed fixture and registered-hook harness make the regression portable without the private journal.

Fixes remain in the canonical dispatcher: route automatic anchors through their extension owner; preserve host authority for other deadline kinds; initialize recovery after startup reconciliation; render the existing primary demand together with pending strict recovery. Recovery remains durable in the existing journal with the existing per-slip-step satisfaction keys, structural satisfaction checks and ten-minute threshold. No new timers or demand store.

## Idle evidence correction

The copied tail does **not** support “idleSince always empty” or “one worker at 15:41”:

- Line 7150, 15:36:28: Cooling idle age starts; line 7206 retains that timestamp.
- Lines 7220–7221 dispatch CoolingTrunksJourney-17 and Pr114PipelineWatch-8. Line 7224, 15:38:25, clears idle age after staffing.
- Line 7283, 15:41:26: idle map empty. The nearest earlier-timestamp status note (line 7289, event timestamp 15:38:43) says three workers, zero ready unowned; all three open rows are working.
- Line 7302, 15:42:14: three workers and one ready unowned row. The exact row is Collateral/labels, needs worker, prior worker aborted; Cooling and pipeline remain working. This is distinct from the total job count, which also includes jobs not owning a ready row.
- Line 7310, 15:43:07: Collateral idle age starts. Line 7311 again requests staffing that row. Neither observed idle period reached ten continuous minutes in the supplied tail. No idle demand was due from these observations.

The startup tracking gap is still repaired. The regression tests cover startup age, persistence to 10:00 with no deadline, and clearing age on actual live staffing. Capacity six is a controlled fixture setting; the journal does not persist a complete authoritative job/capacity snapshot at every event, so this proof does not certify the babysitter's separate 15:41 claim.

## Verification

Final new replay cases on the **unmodified fcdb4f7aea7 dispatcher**: **1 pass, 3 fail**, exit 1. They expose absent load-time pending deadline/idle state and absent durable satisfaction. The native-reader versus extension-reader discrepancy and MISSED reminder are exercised with real functions, not deadline stubs. Same cases on candidate: **4 pass**, exit 0. Receipt: `../evidence/misseddemand2-{base,head}.log`.

```sh
bun test --timeout 120000 packages/reemxy-extensions/extensions/goal_deadlines.test.ts packages/reemxy-extensions/extensions/todo_dispatch*.test.ts packages/reemxy-extensions/extensions/plan_critic*.test.ts packages/reemxy-extensions/extensions/plan-trajectory.test.ts packages/reemxy-extensions/extensions/user-deadline-replay.test.ts packages/reemxy-extensions/extensions/dispatch_recovery.test.ts packages/reemxy-extensions/extensions/missed-demand-replay.test.ts
```

**520 pass, 0 fail**, 8,769 assertions, 40 files: original 516 plus four replay tests. `../evidence/misseddemand2-suite.log`. Existing slip-step tests retain rearm after satisfaction, earlier-step suppression, failed-tool and unrelated-action controls. New tests prove load before turns/timers, combined CHURN/recovery steering, reload identity, idle staffing/10-minute transition, and same-step satisfaction across reload. Test bodies were inspected against these behavior contracts.

`bun check` on candidate: TypeScript lint, formatting and all package type checks pass. Overall exit **1** because Rust format checks fail at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`. Both files are byte-identical to fcdb4f7aea7 (Git blobs `d8bfc98b61b671fe63ce59c7f5c4312a2d0c6f5c` and `999de4878491747387b7b8363eab36e016dee17c`). No Rust changes are in this patch. Full log: `../evidence/misseddemand2-check.log`. New test oxlint and formatting pass; `git diff --check` passes. Ordinary and whitespace-ignored change stats agree; no whole-file dispatcher reformat.

## Composite proof

Read-only manifest and frozen copy SHA256: `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`; **77 PRs**, exact manifest order. Fork main: `9370e7bfe26e948d72f53f918e681b402e600383`. All remote inputs fetched through fork only, pinned before assembly, with 77/77 input heads verified as ancestors. No topic branches rewritten. Only the known generated catalog rules.json overlap required regeneration from its KDL sources in the throwaway full tree.

| Tree | Commit | All package type checks | Focused tests |
| --- | --- | --- | --- |
| main + #92 | `4d7201a36d72fb02031f5e929f5199edf30df2f6` | PASS | 113 pass, 0 fail |
| main + 77 PRs | `2d32fc4045b41f71fdd52efc8420741d83ee33bd` | PASS | compiled SDK smoke below |

Command: `bun run --filter './packages/*' --sequential --if-present check:types`. Logs, pinned heads, merge ledger, manifest copy and replayable assembly/verification scripts: `../evidence/misseddemand2-{assemble,verify,heads,merges,manifest,results}.*` and per-tree logs. External dependencies and the pre-existing native addon are shared; workspace imports resolve within each proof tree. Native sources are unchanged by this patch; no native build/install is claimed.

## Compiled SDK and publication

Compiled SDK acceptance **PASS**, exit 0 and canonical proof `ok: true`. Binary SHA256: `12d60180c0864220a752f4448836a3a2aaaffe0885cd8857d76b294a4f670a96`. Built from the full composite using its `compileCodingAgent` helper and real build plugins. The runner loads only the canonical `tools/omp/source_update_acceptance.ts`, with a lane-owned disposable HOME/XDG tree, dummy nonfunctional key, `--no-session`, `--no-tools`, `--no-lsp`, `--no-pty`, `--no-extensions`, `--no-skills`, `--no-rules`. It shuts down at session start without a provider prompt. SDK deadline/PERT/resource/unknown-work, completion, restart-drain, extension lifecycle, native glob and streamed cancellation checks pass. No updater or installer runs. Proof/runner/build/output/hash logs: `../evidence/misseddemand2-{compiled-proof.json,acceptance.py,acceptance.log,compile.log,compiled-output.log,compiled-sha256.txt}`; compile entry: `../misseddemand2-full/.missed-compile.ts`.

The canonical `stack_check.py --no-fetch --candidate topic/rt-agent-runtime-core=c17bc21781fac2af966c7e84f30a45bcca14872a` also passes: **77 PRs merge cleanly** onto `9370e7bfe2`. FETCH_HEAD was verified to equal the pinned fork main first; no upstream network operation was used. Log: `../evidence/misseddemand2-stack-check.log`.

Publication target: **only** `fork/topic/rt-agent-runtime-core`, fast-forward descendant of the starting head. Exact lease is `--force-with-lease=topic/rt-agent-runtime-core:fcdb4f7aea709ba0d5fca46ee44cea5481fa3c13`, with `OMP_UPSTREAM_PR_PUSH=topic/rt-agent-runtime-core`. The evidence-only descendant carries unchanged source; full published SHA, remote-ref and PR #92 head readback are recorded in `../evidence/misseddemand2-publication.log`. No PR description, comment, main ref or other topic is edited.

## Risks

This proves frozen-session behavior, source tests and assembled types; it does not prove a restarted live DC lead. No install was authorized or performed. Idle time begins at first observation, not an inferred time before restart. Existing coarse measured-pace forecasting and recovery satisfaction semantics are unchanged. The whole `bun check` remains red on the two pre-existing Rust formatting failures named above.
