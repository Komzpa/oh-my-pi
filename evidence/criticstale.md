# Plan critic stale actions, PR92

Owner (2026-11-07 21:35): «он как будто не видит критика вообще».
Raw objective: freshness before emitting/re-waking each pending action; current status/owner, ownerRunStates, completed/released custody, abandoned/reassigned rows. Changed rows invalidate verdicts. One delivery; unanswered after two lead turns first FIX NOW using existing derivation. Drop self-addressed escalations. Base-red/head-green live shapes, extension suites, 77-PR composite types. Exact lease push PR92. No install/updater, ~/.omp or ~/.config writes, live sessions, desktop, upstream/main mutation or commands in DC project.

## Source and decisions
Clean initial head and fork PR92 head: eedffce05d6554ab3235afa7ba47e5ed3f44b8cb. Includes omp-fixlist. Owner is packages/reemxy-extensions/extensions/plan_critic.ts on topic/rt-agent-runtime-core, not a new dependent PR. but status refuses non-main worktrees. lane_ask DECISION in criticstale-decision.txt approves local Git fallback and existing 77-PR composite recipe on read-only fork/main. No agents/reviewers/model probes launched by this lane; lane_ask is the explicitly required judgment route.

## Change and acceptance
Each pending action is checked against the live row and the existing currentDecision.ownerRunStates. Closed/deleted/abandoned rows, completed released workers, fulfilled staffing/dependencies, changed row/prerequisite/run snapshots auto-close with persisted reasons. Legacy missing snapshots fail closed. Current plan/run snapshots are cloned before asynchronous review; refresh runs before initial notification, every wake, poll, tool admission and FIX NOW projection. A changed binding no longer blocks regeneration; normal 60-second retry backoff remains.

Unchanged fresh actions deliver once, retain age over resume, and after two completed lead turns receive severity -1 in the existing chiefFixNow derivation, above late-plan/staffing/push defects. Turn age caps at two to avoid journal append spam. No second fixlist. Escalate actions close with a reason and never become self-addressed owner demands. The static reviewer brief carries ownerRunStates and prohibits “Ask the lead”.

New tests assert externally observable wait admission, persisted auto-close reasons, one notification, first FIX NOW item versus a late-plan negative control, suppression during in-flight row change, and regenerated verdict identity/current owner. Same six new cases against exact base implementation: 0 pass / 6 expected failures (criticstale-base.txt). Candidate focused results: 28 pass / 0 fail (criticstale-focused.txt). This is offline fixture proof, not measured live model response latency.

Initial parallel suite had one unreported-detail failure in old DC wait test; isolated file passes 12/12 (criticstale-redrows.txt). Final suite receipt follows below. Initial typecheck found a readonly-array push in the new fixture; fixed to array replacement. Subsequent bun check: TypeScript/lint/format pass; Rust format fails only base comment wrapping in crates/pi-shell/src/bash/trace/viz/printer.rs:1216 and runtime_tests.rs:93. These are unchanged. Bun 1.4.4 --help consulted for check/run semantics (criticstale-bun-help.txt); no blind full-check retries. Frozen dependency installation failed on existing lock/catalog mismatch; bun install --no-save succeeded, lockfile unchanged. Native artifact fetched by existing dependency install; no native acceptance/build/install claim.

## Publication target and rollback
Only fork refs/heads/topic/rt-agent-runtime-core, Komzpa/oh-my-pi#92. Rollback is old head eedffce05d6554ab3235afa7ba47e5ed3f44b8cb; exact lease refuses overwriting another writer. Readback must compare full branch SHA and PR headRefOid. No PR text/comment edits.
