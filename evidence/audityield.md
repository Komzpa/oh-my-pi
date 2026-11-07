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

`bun check`: TS lint/format corrected in owned files. Full check is blocked by pre-existing Rust formatting in `sdk/rust/omp-rpc/src/wire.rs` and `crates/pi-shell/tests/minimizer.rs` (no Rust files changed by this lane). `bun run --help` documents script execution; root package.json defines this check as parallel TS/Rust. Standalone TS and composite results recorded below when terminal.
