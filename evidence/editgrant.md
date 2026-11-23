# Edit grant repair

Objective: admit explicit lead-assigned paths into row resources, inherit nested row scope without widening, auto-answer redundant scope requests and surface new requests; preserve conflicts. No install, config writes, live sessions or upstream/main publication.

Ownership discovery: fork main 9370e7bfe26e948d72f53f918e681b402e600383. #92 topic/rt-agent-runtime-core eb54c7ed64b50d5355988224d30163bf3801c050 owns dispatch_preflight.ts workerToolPreflight/liveWorkerRows and agent_router.ts spawn admission. #93 9426d17b50af1ad33162bdf97e00f7f93c349839 owns task execution but has no resource gate. #146 82c6592884c1fe24f38338cfc1ad840059148027 owns peer coordination. GitButler refuses this linked worktree: non-main worktrees are not supported; worktree-local git fallback applies.

## Decisions
- lane_ask placement: DECISION: proposed placement correct, #92 free; keep #93 unchanged unless missing core data.
- lane_ask protocol: DECISION: use resource_scope, grant redundant requests immediately, new paths queued for canonical-lead approval; inherit registry parentId scope.
- lane_ask base Rust failures: DECISION: record as base-only and finish standalone TS, composite typecheck and stack check before publication.

## Proof so far
- Regression test editgrant.test.ts: three behavioral cases; base eb54c7ed64b fails all three, candidate passes all three, including overlap, outside scope, symlink, revocation and pending-request negative controls. Logs ../editgrant-base-red.log and ../editgrant-regression.log.
- Router/preflight/todo batch: 520 pass / 0 fail across 48 files (../editgrant-suites.log).
- Full task/todo/peer batch: 987 pass / 37 fail on #92 alone. Comparing base and composite; not represented as green.
- bun check: TypeScript, lint, TS formatting pass. Rustfmt fails unchanged base comments at crates/pi-shell/src/bash/trace/viz/printer.rs:1216 and runtime_tests.rs:93. No Rust/native diff from base. Bun v1.4.4 `bun run --help` consulted: scripts run from package.json, --parallel runs multiple scripts; inspected root check -> check:ts + check:rs and actual rustfmt output rather than retrying the wrapper.
- Pre-supplied native addon pi_natives.linux-x64-modern.node sha256 2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b, supplied in original lane worktree at start; copied to disposable base. No native/Rust source delta between base and candidate.
- Frozen dependency install rejects pre-existing catalog/lock mismatch; bun install --no-save used in disposable worktrees; tracked lock/config unchanged.

## Final placement and fixture decision
- lane_ask: DECISION: assemble 77 pinned heads in manifest order on assigned fork/main 9370e7bfe26e948d72f53f918e681b402e600383; record upstream conflict as unrelated, leave other branches unchanged.
- lane_ask after full-suite diagnosis: DECISION: repair the two #92 crash-recovery fixtures, hand off exact #93 fixture changes, keep #93 untouched, publish bounded editgrant with full-suite results explicitly not green.
- #92 fixtures now provide getTodoSnapshot from their live phases. With TMPDIR=/tmp, crash-recovery, crash-recovery-revive, worktree and failed-child-artifact: 56 pass, 0 fail. The original environment TMPDIR was inside the checkout, so no-repository fixtures found the outer repository.

## #93 fixture handoff (not implemented here)
Executor startingRef/registerIfAvailable now reserves a generation before SDK construction. Tests must NOT register a live session before runSubprocess. Move registerRunning into the mocked createAgentSession(options) callback, adopt options.expectedAgentRef with registry.registerIfAvailable, attach the fake session to that returned generation and clear starting. Capture the reserved ref's createdAt in the callback for the existing acceptance timestamp assertion. Preserve collision and cancelled-late-initializer negative controls.
- executor-yield-loop.test.ts: mockCreateAgentSession and registerRunning; remove the ten eager registerRunning calls, adopt in SDK callback.
- executor-soft-budget.test.ts: same helper plus custom SDK mock callbacks; retain sessionFile and observability bus setup.
- executor-result-acceptance.test.ts: registerRunning helper and eager calls; capture the actual reserved ref from SDK options; preserve generation and lifecycle assertions.
- executor-pass-through.test.ts, subagent-lsp.test.ts, autoload-skills.test.ts: fresh registry per test and SDK fake adoption; no retained session may hold the next test's id.
- executor-wall-clock.test.ts: expectedAgentRef is now the reserved starting ref, not null; assert its id, starting state, and the existing late-generation protection.
- Composite adds executor-worker-ask.test.ts and executor-launch-startup.test.ts lifecycle fixtures needing the same reservation-aware fake SDK behavior. Full composite task run remains non-green; no production executor change proposed.

## Composite proof
- ../editgrant-composite.json records all 77 exact heads in manifest order, base and tip; each pinned head ancestry verified. Initial composite 70f258528b5a4ba965c8e9d3ffae24cac1f9e544 includes candidate 5764a371e84. Generated rules.json conflicts only are handled by canonical gen:compat; no hand resolutions.
- bun run check:ts on this composite: 19/19 passed, including lint, TS format, all workspace typechecks. Final source delta will be rechecked below.
- Canonical stack_check on fresh upstream 602aaee4cd3101c14e6c821a41a200f311896146 rejects unrelated executor.ts at #16651 (row 4), before #92. No upstream or live-stack edits made.

## Final test commands and limits
- `TMPDIR=/tmp bun test packages/coding-agent/test/task/structured-subagent.test.ts packages/coding-agent/test/task/peer-message-after-report.test.ts packages/coding-agent/test/task/crash-recovery.test.ts packages/coding-agent/test/task/crash-recovery-revive.test.ts packages/reemxy-extensions/extensions/editgrant.test.ts packages/reemxy-extensions/extensions/dispatch_preflight.test.ts packages/reemxy-extensions/extensions/agent_router.test.ts`: 140 pass / 0 fail, 510 assertions. Includes core dispatch context reaching the preflight event.
- Broad #92 base/candidate batch before fixture repair: both 987 pass / 37 fail, exactly the same 37 unique failure names; ../editgrant-base-task-peer.log, ../editgrant-task-peer.log.
- Broad 77-PR composite task/todo/peer batch: 1090 pass / 173 fail / 2 skip / 3 errors across 105 files (../editgrant-composite-task-peer.log). These are not green. This broad run was on initial candidate composite before the two #92 fixture repairs. Lane decision above explicitly preserves #93 and hands off its fixture work.
- Native artifact came pre-supplied; no rebuild or install performed. Scope behavior validated in-process; no live session or desktop proof is claimed.

## Delivery verification
- Final production/source commit: 53dc68b2098 (descends from original #92 head eb54c7ed64b50d5355988224d30163bf3801c050; no rewritten commits). Follow-up changes only strengthen regression setup and record proof.
- Final regression fixture uses a distinct lead cwd, so base's first assigned-worktree edit and first nested-child write both receive actual `block: true`; base 0 pass / 3 fail; candidate 3 pass / 0 fail, 21 assertions.
- Final extension batch: 485 pass / 0 fail, 8596 assertions across 36 files. Final focused core/preflight/router batch: 140 pass / 0 fail. Standalone `bun run check:ts` exit 0.
- Final 77-head union 60af395931a2b50330ee9dfaccc24d63542819e6 includes source commit 53dc68b2098. Final union `bun run check:ts`: 19/19 passed. Metadata-only/test-fixture follow-up has unchanged production code; exact-head check below.
- Push target: fork Komzpa/oh-my-pi refs/heads/topic/rt-agent-runtime-core (#92), expected old eb54c7ed64b50d5355988224d30163bf3801c050. Rollback is a separately authorized exact-lease push of that old SHA; no main or upstream target.
