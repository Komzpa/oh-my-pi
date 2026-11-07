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
