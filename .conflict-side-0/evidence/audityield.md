# Row auditor yield repair

Objective: reject missing assigned-row verdicts at yield with the exact schema; accept a later valid result in the same attempt, without accepting stale head/delivery/attempt or replacing an acted-on verdict. No install, configuration or live-session changes.

Owner: read-only `~/.config/tasks-loop/omp-live-stack.json`, #92 `topic/rt-agent-runtime-core`.
Base: `4bbf061cb8f7ad2f93ac18ba47b86bab6d9ebe8a`, fork/main merge base `9370e7bfe26e948d72f53f918e681b402e600383`.
Rollback: push the previously read remote head only with a new exact lease; never main/upstream.

Placement via `tools/codex/lane_ask.py`: initial STOP incorrectly interpreted the manifest's read-only restriction as applying to source. Corrected decision: "YES — resume #92 on its owner branch; this worktree is allowed for source edits and dependency installation." Implementation decision: "Yes—place the shared schema builder and the inseparable coding-agent yield/runner changes on the #92 branch." Composite typecheck explicitly authorized by the user.

Fixtures are the two complete yield arguments extracted from the supplied `../AuditCoolingHeatMainsBlueOrangeP-2.jsonl`, at 2026-11-07 14:34:29.980Z and 14:36:14.897Z, committed as `extensions/fixtures/row-audit-cooling-yields.json`. Extraction follows Python `json.loads` documentation (`python3 -m pydoc json.loads`); content strings are skipped, only assistant toolCall blocks selected.

Root causes:
- Native row-audit launch did not declare outputSchema.
- The harness consumed one returned output, with no progress-result callback for correction.
- The valid real payload includes `requirementDiffs: []`; this incorrectly triggered mandatory requirement-edit evidence even for a product row.

Change: per-assigned-row schema, strict in-tool rejection (no permissive retry-budget override), validated latest progress yield callback, serialized schedule updates guarded by delivery/head/start/attempt and pending/omitted state. Empty requirement diffs do not claim a requirement edit; real requirement-edit rows still require quotes and diff evidence.

Regression command: `bun test packages/reemxy-extensions/extensions/row_audit.test.ts packages/coding-agent/test/extensions-runner.test.ts -t Cooling`.
Base source with candidate tests/fixture: exit 1, 0 pass / 2 fail (malformed yield accepted; correction callback absent). Restored candidate source: complete two-file suites exit 0, 133 pass / 0 fail, 612 assertions.
Negative controls: empty/duplicate assigned rows rejected; repeat malformed submissions never override strict schema; acted-on verdict and newer attempt preserved. Existing moved-head, new-delivery, evidence and requirement-edit tests retained.

`bun check`: TS lint/format corrected in owned files. Full check is blocked by pre-existing Rust formatting in `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `crates/pi-shell/src/bash/trace/viz/runtime_tests.rs:93` (no Rust files changed by this lane). `bun run --help` documents script execution; root package.json defines this check as parallel TS/Rust. Standalone TS and composite results recorded below when terminal.


Final code candidate: `52c1088b927` (the second commit aliases the test-only YieldTool import to avoid a duplicate name from another manifest PR). `bun run check:ts` exits 0 on the standalone owner topic, including lint/format and every package typecheck. The exact-pair regression exits 0, 2 pass / 0 fail / 20 assertions.

Focused suites command: `bun test packages/reemxy-extensions/extensions/row_audit.test.ts packages/reemxy-extensions/extensions/todo*.test.ts packages/coding-agent/test/tools/yield*.test.ts packages/coding-agent/test/tools/todo.test.ts packages/coding-agent/test/extensions-runner.test.ts`. Exit 0: 775 pass / 0 fail, 9,719 assertions, 44 files, 51.41 s. This is a count of tests in the listed suites, not an estimate of broader coverage.

Composite: canonical stack_check.py on fresh upstream stops before #92 at row 4, #16651 `upstream/queue-message-behind-child-brief`, `packages/coding-agent/src/task/executor.ts`. lane_ask decision: "YES—assemble and typecheck the 77-PR composite on the fork/main-compatible base; report the fresh-upstream conflict separately." No other topic was edited.

On fork/main `9370e7bfe26e948d72f53f918e681b402e600383`, canonical stack_check.py `--no-fetch --candidate topic/rt-agent-runtime-core=<candidate>` merges all 77 PRs in manifest order. Every resolved full SHA is an ancestor of union `b2f3a318794ae33566bbda95d9138a9b568894af`. Pinned heads and source candidate are in `audityield-composite.json`. In `../audityield-composite`, dependency install used `bun install --ignore-scripts`; `bun run check:ts` exits 0, **19/19 checks passed, 0 failed**. This includes assembled package typechecks and lint/format. The temporary lockfile resolution drift was restored; no manifest/config writes.

Manifest SHA256: `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`.

Publication: fetched #92, rebased onto its current head (already up to date); range-diff preserved all 305 existing topic commits, plus this lane's additive commits. Remote rollback/lease head `4bbf061cb8f7ad2f93ac18ba47b86bab6d9ebe8a`. Push route is exactly `OMP_UPSTREAM_PR_PUSH=topic/rt-agent-runtime-core git push --force-with-lease="topic/rt-agent-runtime-core:<old>" fork "<SHA>:refs/heads/topic/rt-agent-runtime-core"`, with ancestry verified before push. Ready PR remains https://github.com/Komzpa/oh-my-pi/pull/92. Readback is performed after push and reported in the final response. No PR text/comment, install, updater, live session, desktop, ~/.omp or ~/.config mutation.
