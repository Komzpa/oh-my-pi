# PR #92 / #108 yield compatibility

As of 2026-11-07T09:56:56.653361+00:00.

Objective: change only #92 to preserve worker-question parking, lead interruption and restart waits on main alone and with #108. No installation, updater, desktop, live sessions or configuration mutation. Raw brief: ../brief-yieldcompat.md in the lane directory.

## Source and change

- Original #92: `4d8a368c84f271a2cf4820ab89fd896731e1ed50`.
- Tested source #92: `df592ad94e8644aae5e3a92b0beb13284b2afc95` (subsequent evidence-only commits do not alter source).
- fork/main: `9370e7bfe26e948d72f53f918e681b402e600383`.
- #108: `bd127b4057808edd5cf5a4ecc71c05d043cd5e27`; unchanged.
- Worker asks and direct lead questions now use an assignment-owned session abort promise, with an idempotent request and a wait that clears only the settled promise. They do not terminate the run signal. Prompt rejection caused by parking remains resumable. Terminal-yield logic retains its own implementation on each configuration.
- New regression exercises a rejected stopped prompt, no reminder while parked, and successful completion after the lead answer. Existing question/default/cancellation/late-yield/IRC-answer regressions remain unchanged.

## Required proof

All trees were created with `git merge-tree --write-tree` and `git commit-tree`, then materialized as detached throwaway worktrees under this lane. All package type checks used:

```sh
bun run --filter './packages/*' --sequential --if-present check:types
```

| Configuration | Materialized commit | Type checks | Required tests |
| --- | --- | --- | --- |
| main + #92 | `989e1622aa992f8b3ccccbd1b1d67e0070e8d010` | PASS, exit 0 | 96 pass, 0 fail |
| main + #92 + #108 | `a641a939fe798fd3ca08dd5ee21053783c40b3dd` | PASS, exit 0 | 96 pass, 0 fail |
| main + all 77 manifest branches | `ad6ab2d5733bc06b0d68f5dca85b48df9f0947df` | PASS, exit 0 | Type-check proof requested |

Required test command (same on both configurations):

```sh
bun test --timeout 30000 packages/coding-agent/test/task/executor-worker-ask.test.ts packages/coding-agent/test/task/restore.test.ts packages/reemxy-extensions/extensions/worker_asks.test.ts packages/reemxy-extensions/extensions/todo_dispatch.wait.test.ts packages/reemxy-extensions/extensions/todo_dispatch.wake-action.test.ts
```

Full inventory merged in manifest order; all 77 head SHAs verified as ancestors of the full composite. Manifest SHA256: `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`. Frozen manifest, exact heads, intermediate merge commits, raw output and scripts are in the lane's `../evidence/yieldcompat-*` files. `yieldcompat-heads.json`, `yieldcompat-merges.json`, `yieldcompat-assemble.py` and `yieldcompat-verify.py` permit replay.

Generated catalog artifact overlap is treated exactly as `tasks-loop/tools/omp/stack_check.py` specifies: only conflicts exclusively in `packages/catalog/src/compat/rules.json` are permitted, then `bun run gen:compat` recompiles that artifact from the merged KDL sources in the throwaway full tree. No branch is edited for this. Raw merge diagnostics retained. The full proof worktree differs from its merge commit only by that generated artifact. Canonical stack preflight with `--no-fetch --candidate topic/rt-agent-runtime-core=df592ad94e8644aae5e3a92b0beb13284b2afc95` also passes: 77 PRs.

External dependencies were linked from this lane; workspace package imports point into each proof worktree. Tests use the pre-existing lane native addon `packages/natives/native/pi_natives.linux-x64-modern.node`, SHA256 `2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b`. It was not rebuilt or installed; native artifact build provenance was not independently established here. No native sources changed in this fix.

Changed source/test oxlint and oxfmt checks pass. `git diff --check` passes.

## Negative control

Original #92 + #108 materialized as `686c6ea396f7bf4a3e8c726f53701f973f6c0299`; coding-agent check:types exits 1:

```text
$ bun check --no-script -p tsconfig.json
src/task/executor.ts(1975,6): error TS2304: Cannot find name 'requestYieldTurnStop'.
src/task/executor.ts(1983,6): error TS2304: Cannot find name 'requestYieldTurnStop'.
src/task/executor.ts(2035,6): error TS2304: Cannot find name 'requestYieldTurnStop'.
src/task/executor.ts(2643,34): error TS2339: Property 'waitForYieldTurnStop' does not exist on type 'SubagentRunMonitor'.
Found 4 errors in 1 file, checked 4,921 files [612.32ms]
error: script "check:types" exited with code 1
```

## Broader test limitations

A broader optional sweep across all executor tests, four restore/crash tests and all extension todo tests is not green. These failures are not hidden by the required 96-test receipt. Raw complete output is retained in `yieldcompat-proof-main92-v4-tests.log` and `yieldcompat-proof-main92-108-v4-tests.log`. Original #92 baseline output is in `yieldcompat-baseline.log` and `yieldcompat-baseline-resume.log`; it reproduces the unchanged yield-loop, wall-clock, result-acceptance, crash-recovery and soft-budget failures. Ownership: existing #92 (topic/rt-agent-runtime-core) for resume, lifecycle, soft-budget and pass-through fixtures; #108 (fix/yield-terminal-once) also owns the changed yield-loop tests in the union. `yieldcompat-negative-extra.log` reproduces the union yield-loop and pass-through failures using the original #92 plus unchanged #108. Neither branch was expanded to repair these unrelated fixtures. Not every broad failure has an individual baseline classification.

Exact failure names and observed errors from the broader runs follow:

### proof-main92-v4

```text
ENOENT: no such file or directory, mkdtemp '/home/kom/proj/ai_pr/omp-workerask-20261107/proof-main92-v4/.tmp/waitgate-3jrVAQ'
(fail) DC lead waits on both overdue executors, refuses missing or stalled workers, and cannot stop [0.47ms]
error: expect(received).toBeNull()
Received: {
(fail) runSubprocess wall clock (task.maxRuntimeMs) > a cancelled late initializer cannot replace a newer same-id worker [0.59ms]
error: expect(received).toEqual(expected)
(fail) runSubprocess incremental yield loops > retries a dropped assignment before sending any yield reminder [1.40ms]
(fail) runSubprocess incremental yield loops > fails after four dropped assignments without sending a yield reminder [0.59ms]
(fail) runSubprocess incremental yield loops > delivers an assignment on the fourth attempt [0.61ms]
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) runSubprocess incremental yield loops > retries a dropped yield reminder without consuming another reminder [0.56ms]
error: expect(received).toHaveLength(expected)
(fail) runSubprocess incremental yield loops > fails when every attempt to send a yield reminder is dropped [0.49ms]
(fail) runSubprocess incremental yield loops > keeps a section from another turn incremental while a dropped final reminder retries [0.47ms]
Expected: true
Received: false
(fail) runSubprocess incremental yield loops > keeps a run of incremental-yield-only turns inside the soft budget [0.46ms]
(fail) runSubprocess incremental yield loops > ends the run when the forced final yield comes back incremental [0.44ms]
(fail) runSubprocess incremental yield loops > does not finalize a section submitted after the forced yield parked [0.43ms]
(fail) runSubprocess incremental yield loops > fails when every async-pending notice dispatch is dropped [0.45ms]
(fail) runSubprocess result acceptance > terminalizes the ref and stamps the run lifecycle when the yield is accepted [0.75ms]
(fail) runSubprocess result acceptance > settles the owning task job when Agent Hub tombstones a running subagent [30002.16ms]
  ^ this test timed out after 30000ms.
TypeError: session.getTodoSnapshot is not a function. (In 'session.getTodoSnapshot()', 'session.getTodoSnapshot' is undefined)
(fail) kill/replay through ordinary resume > goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones [5.04ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > forwards an exact credential resolver without replacing it [0.30ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > forwards undefined when the parent has not pre-discovered state [0.24ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > removes MCP and fresh discovery sources for a restricted child [0.31ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > persists write when the original subagent contract grants it [0.21ms]
(fail) ordinary resume continues the crashed row from its transcript and retained isolated workspace under a new id [789.43ms]
Expected: 1
Received: undefined
(fail) runSubprocess soft request budget > a budget stop drives one forced final yield and finishes as a normal completion [1.43ms]
(fail) runSubprocess soft request budget > a budget hard-abort keeps the kept-alive agent adopted and messageable via irc [1.21ms]
(fail) runSubprocess soft request budget > fails an irc wake when the parked transcript has no message history [0.73ms]
(fail) runSubprocess soft request budget > a shutdown racing a budget hard-abort follows the shutdown release path [2.48ms]
(fail) runSubprocess soft request budget > manager shutdown restores a running kept-alive agent as parked without a tombstone [30000.38ms]
(fail) runSubprocess soft request budget > a nested spawn reaches the root RPC surface through the inherited observability bus [30008.65ms]
(fail) runSubprocess soft request budget > an aliased observability bus does not duplicate lifecycle frames [1.64ms]
(fail) runSubprocess soft request budget > a caller-signal abort keeps the kept-alive agent resumable via irc [1.06ms]
```

### proof-main92-108-v4

```text
ENOENT: no such file or directory, mkdtemp '/home/kom/proj/ai_pr/omp-workerask-20261107/proof-main92-108-v4/.tmp/waitgate-VpO0nW'
(fail) DC lead waits on both overdue executors, refuses missing or stalled workers, and cannot stop [0.40ms]
TypeError: session.getTodoSnapshot is not a function. (In 'session.getTodoSnapshot()', 'session.getTodoSnapshot' is undefined)
(fail) ordinary resume continues the crashed row from its transcript and retained isolated workspace under a new id [342.04ms]
error: expect(received).toBe(expected)
Expected: 0
Received: 1
(fail) runSubprocess incremental yield loops > accepted terminal A keeps the first result after 18 refused yields [6.72ms]
(fail) runSubprocess incremental yield loops > accepted terminal B refuses incremental and terminal follow-ups without appending [0.89ms]
error: expect(received).toEqual(expected)
(fail) runSubprocess incremental yield loops > retries a dropped assignment before sending any yield reminder [0.61ms]
(fail) runSubprocess incremental yield loops > fails after four dropped assignments without sending a yield reminder [0.43ms]
(fail) runSubprocess incremental yield loops > delivers an assignment on the fourth attempt [0.43ms]
(fail) runSubprocess incremental yield loops > retries a dropped yield reminder without consuming another reminder [0.41ms]
error: expect(received).toHaveLength(expected)
(fail) runSubprocess incremental yield loops > fails when every attempt to send a yield reminder is dropped [0.41ms]
(fail) runSubprocess incremental yield loops > keeps a section from another turn incremental while a dropped final reminder retries [0.43ms]
Expected: true
Received: false
(fail) runSubprocess incremental yield loops > keeps a run of incremental-yield-only turns inside the soft budget [0.40ms]
(fail) runSubprocess incremental yield loops > ends the run when the forced final yield comes back incremental [0.43ms]
(fail) runSubprocess incremental yield loops > latches a real forced-final incremental yield before accepting another call [0.52ms]
(fail) runSubprocess incremental yield loops > completes the forced terminal yield even with owner work pending [0.45ms]
(fail) runSubprocess incremental yield loops > never dispatches an async-pending notice after terminal acceptance [0.48ms]
(fail) kill/replay through ordinary resume > goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones [3.84ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > forwards an exact credential resolver without replacing it [0.26ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > forwards undefined when the parent has not pre-discovered state [0.23ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > removes MCP and fresh discovery sources for a restricted child [0.34ms]
(fail) runSubprocess parent-discovery pass-through (issue #2190) > persists write when the original subagent contract grants it [0.46ms]
error: expect(received).toBeNull()
Received: {
(fail) runSubprocess wall clock (task.maxRuntimeMs) > a cancelled late initializer cannot replace a newer same-id worker [0.53ms]
Expected: 1
Received: undefined
(fail) runSubprocess soft request budget > a budget stop drives one forced final yield and finishes as a normal completion [0.98ms]
(fail) runSubprocess soft request budget > a budget hard-abort keeps the kept-alive agent adopted and messageable via irc [1.03ms]
(fail) runSubprocess soft request budget > fails an irc wake when the parked transcript has no message history [0.66ms]
(fail) runSubprocess soft request budget > a shutdown racing a budget hard-abort follows the shutdown release path [0.85ms]
(fail) runSubprocess soft request budget > manager shutdown restores a running kept-alive agent as parked without a tombstone [30002.25ms]
  ^ this test timed out after 30000ms.
(fail) runSubprocess soft request budget > a nested spawn reaches the root RPC surface through the inherited observability bus [30000.26ms]
(fail) runSubprocess soft request budget > an aliased observability bus does not duplicate lifecycle frames [1.58ms]
(fail) runSubprocess soft request budget > a caller-signal abort keeps the kept-alive agent resumable via irc [0.94ms]
(fail) runSubprocess result acceptance > terminalizes the ref and stamps the run lifecycle when the yield is accepted [0.79ms]
(fail) runSubprocess result acceptance > settles the owning task job when Agent Hub tombstones a running subagent [30000.86ms]
```

The todo red-rows ENOENT is a throwaway setup prerequisite (`.tmp` absent), subsequently created for focused tests. Broader failures are outside this semantic compatibility change. This is source/test proof, with no installed or live-session behavior claim.

## Publication and rollback

Publish only fork `topic/rt-agent-runtime-core`, preserving original head as an ancestor. Expected remote old head: `4d8a368c84f271a2cf4820ab89fd896731e1ed50`. Use the user-specified lease and read back with `git ls-remote fork refs/heads/topic/rt-agent-runtime-core`. Rollback target is that original head; no rollback is executed by this lane. No PR comments or description changes.

## Completed broad sweep and publication readback

- main + #92 optional broad run: 649 pass, 28 fail (677 tests, 60 files).
- main + #92 + #108 optional broad run: 657 pass, 31 fail (688 tests, 60 files).
- These are additional failures, not successful proof of an all-green executor suite. Required worker-ask/restore/todo tests: 96/96 pass in each configuration.
- First publication was a fast-forward to `e8b284a57602832181f9ed97bff5c411c09213de`; `git ls-remote fork refs/heads/topic/rt-agent-runtime-core` matched it. This final evidence completion is a documentation-only descendant; the final remote head is read back in the lane publication log and final response.
