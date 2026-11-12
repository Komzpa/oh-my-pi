# Scope grant — lane/scopegrant

Objective/authority: ../brief.md (raw user brief). Starting HEAD and rollback:
66c38306f7d. Local commit only; babysitter integrates into PR #92. No push,
installation, private config writes, live-process changes, desktop use, Sunbim
writes or main-branch mutations.

## Root cause, with journal readback

The quoted attempt is retained history, not proof of a current missing grant.
AdaptiveBatchLand-8-2.jsonl:13 assigns Worktree /home/kom/proj/sunbim/wt/AdaptiveBatch
explicitly. At :59–61 its real edit of facilityLabelLayout.ts is refused by
workerToolPreflight in dispatch_preflight.ts: that gate reads current canonical
lead TODO resources, not the assignment/cwd. With declared row resources, the
cwd fallback does not apply. scope.root is assignment data, not a supported task
wire-schema field. See scopegrant-assignment.txt and scopegrant-refusal.txt.

The worker actually sent write {path:"agent://Main",content:"BLOCKER: … Please
grant this worktree in row resources for AdaptiveBatchLand-8-2."} at :62, received
"Delivered to Main" at :64, waited twice and aborted at :98–100. It did not call a
scope-grant tool. The corresponding Main journal :120510 records irc:incoming at
2026-11-07T01:16:20.213Z, runtime 18.17.0. The request WAS shown to Main.

Main DOES have the remedy: todo {op:"schedule",updates:[{task:"Facility labels
after rotation: leaders cross the building",resources:["/home/kom/proj/sunbim/wt/AdaptiveBatch"],owner:"AdaptiveBatchLand-8-2"}]}.
Main actually called it at :120514, 01:27:16.215Z; :120515 says the row changed.
Thus "never comes" is not literally true of the full journal: the manual grant
arrived about 11 minutes after the request. The later 21:58 demand repeated the
failed attempt. See scopegrant-chief-receipt.txt and scopegrant-grant-result.txt.
No live-session behavior was changed or inferred from this historic receipt.

This checkout already contains the editgrant task-text auto-persistence and
resource_scope request path. Its remaining reproducible hole: explicit item
resources take precedence over ALL assignment paths, including an explicitly
assigned worktree; expansion is refused before the assignment can be persisted.
The same new tests against the starting router yield 2 pass / 4 fail.

## Change and contracts

Chief-assigned Worktree, cwd and scope.root declarations in the per-item task
now supplement explicit file resources before admission and persist to the
canonical row. Ordinary explicit-file narrowing is retained; shared batch context
grants nothing. Nested workers cannot widen their ancestor's scope. Canonical
containment, symlink checks and overlapping-writer checks remain. Both admission
and write refusals name the holder and executable schedule/resource_scope remedy.

resource_scope forwards one short Harness (not Darafei) notice through lead
session.steer with agent attribution (user-role transport), containing the exact
todo schedule JSON. Concurrent duplicate requests are deduplicated before the
await; failed delivery permits retry. Pending result says to yield with a clear
Scope pending error. The router permits that terminal status only after sending
a scope request, avoiding the completion-evidence gate's otherwise circular
refusal. The lead applies the schedule to the running worker; no redispatch is
required. The focused test replays the emitted JSON and proves the next write is
allowed; unassigned targets still fail. Telepathy scenario is included in
extensions/eval/lead-instructions.ts using the production notice renderer.

## Executed verification and limits

- scopegrant-before.log: starting router with new tests, 2 pass / 4 fail.
- scopegrant-regressions-final.log: 71 pass / 0 fail, 325 assertions, five focused
  files; includes writer conflicts, nested containment/revocation, symlink escape,
  task admission and yield-budget coverage.
- scopegrant-check-final.log: full bun check exit 0, TypeScript and Rust.
- git diff --check passes.

Decisions are retained verbatim in scopegrant-decision.txt and
scopegrant-testing-decision.txt. The first DECISION forbids building and the
requested metered run under the brief's no-install restriction. The second allows
copying existing dependencies for tests only and approves the bounded code change.
Followed both: copied node_modules into this lane, no package install or lock edit.
No auth/config copy or provider call was made. No dollar spend claimed.

Fixture prepared exactly from the requested source with cp -a --reflink=auto:
../scopegrant-fixture, independent .git directory. Fresh worktree:
../scopegrant-worker, branch lane/scopegrant-fixture, HEAD
7f604c6369b454ddb66c3a8b61c2ab5c2047a94f. No fixture edit/commit or built-OMP model
acceptance is claimed. The requested `omp -p --model codex-lb/gpt-6-luna --max-cost 1`
with private --session-dir remains unverified because of the first lane DECISION.
This is an explicit remaining acceptance gap for the babysitter.

GitButler commit reported "non-main worktrees are not supported"; local Git
commit uses the linked-worktree exception in the but skill. No publication.
