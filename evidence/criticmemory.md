# Plan critic decision memory — PR #92

2026-11-07. Lane: `omp-workerask-20261107`, branch `lane/workerask`.

Objective: “plan critic must remember its rejected/escalated actions”. Reported live defects: repeated Levels escalation after quote-bound lead rejection, redispatch of an already-owned row, and seven identical binding entries in 2 ms. This lane repairs the source owner `packages/reemxy-extensions/extensions/plan_critic.ts` on fork PR #92. No install, updater, desktop, live session access, ~/.omp or ~/.config writes. The manifest was read only.

## Change and invariants

- Reviewer tasks carry actions and addressed reasons from at most three distinct recent bindings, at most 4096 UTF-8 bytes. Oversize actions are omitted whole with an omitted-action count; owner quotes are never clipped into a different meaning.
- The prompt treats owner verbatim quotes in rejection reasons as authority. Rejected or already-escalated actions require cited contradictory new evidence before being issued again.
- Before notifying the lead, an action matching a prior rejection by kind and exact row title is marked `previously rejected: …` when its captured trajectory is unchanged. Attempts, reestimates, complete audit/head, progress evidence, executor, status, dependencies, owner and blocker participate; wall-clock passage does not. Renaming the action id does not bypass the guard. Rejections propagated by this guard retain their original reason without growing prefixes.
- Decisions capture the row trajectory when recorded. Persistence compares the complete binding with the last successfully appended state. Unrelated successful tools append nothing; actual observed mutations still append one entry. Wake-count changes remain real state changes.
- Restore collapses journal snapshots by binding id before selecting recent history, so historical duplicate entries do not crowd out distinct decisions.

## Regression proof

Base: `30b589d736d303eb37071c01e853c64805871f65`.
Source candidate: `6ac8dee870dfc20201dcbd37911cf71e0842ccb7` (full hash in `../evidence/criticmemory-heads.json`; the evidence-only descendant carries the same source).

Base command, with new regression cases added before the implementation:

```sh
bun test packages/reemxy-extensions/extensions/plan_critic.test.ts
```

Result: **16 pass, 2 fail**. The unchanged rejected action with a new id woke the lead after restart (expected zero notices, received one). Seven unrelated successful results grew the binding journal from 2 to 9 entries (expected 2). Raw output: `../evidence/criticmemory-base.log`.

Candidate focused command:

```sh
bun test packages/reemxy-extensions/extensions/plan_critic.test.ts packages/reemxy-extensions/extensions/plan_critic.loading.test.ts packages/reemxy-extensions/extensions/plan-trajectory.test.ts
```

Result: **27 pass, 0 fail**. Controls separately change attempts, reestimates, audit verdict and head and verify that each permits a new wake. A different action kind remains pending. UTF-8 history budgeting and actual mutation persistence are covered. Raw output: `../evidence/criticmemory-head.log`.

## Standalone and full composite

Frozen read-only manifest: SHA256 `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`; 77 PRs. All branch heads fetched from `fork` and frozen before assembly. Main: `9370e7bfe26e948d72f53f918e681b402e600383`.

| Tree | Commit | All package type checks | Critic tests |
| --- | --- | --- | --- |
| main + #92 | `6edc4d68db0` | PASS, exit 0 | 41 pass, 0 fail, four files |
| main + all 77 PRs | `8407e0fea3f` | PASS, exit 0 | Type-check proof requested |

Type-check command on each materialized worktree:

```sh
bun run --filter './packages/*' --sequential --if-present check:types
```

Main+#92 tests add `delivery_critic.test.ts` to the focused list above. Both proof worktrees live under this lane's parent directory (`../criticmemory-main92`, `../criticmemory-full`). Assembly uses `git merge-tree --write-tree` and `git commit-tree` without changing any topic branch. Full assembly follows exact manifest order and verifies **77/77 heads as ancestors**. Only the generated catalog `rules.json` overlap is accepted, as in the canonical stack checker, then regenerated with `bun run gen:compat` inside the full throwaway tree. Canonical `tools/omp/stack_check.py --no-fetch --candidate topic/rt-agent-runtime-core=6ac8dee870d` also passes all 77 PRs.

Replay inputs, scripts, full SHAs, merge diagnostics, type outputs and return codes are in the lane's `../evidence/criticmemory-{manifest.json,heads.json,merges.json,assemble.py,verify.py,results.json}` and matching log files. External dependencies were shared with the lane; workspace package imports resolve into each proof worktree. Tests reuse the pre-existing native addon without rebuilding it; this patch changes no native sources and does not establish new native-build provenance.

`bun check`: TypeScript/lint/TS formatting passes. Overall exit 1 comes from inherited Rust comment formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; neither is changed by this patch. Changed TypeScript oxlint and `git diff --check` pass. Both extension files were already not oxfmt-clean at base, so no whole-file reformat was applied. Whitespace-aware and whitespace-ignoring source diff statistics match.

## Publication and limits

Exact authorized publication target: fork `topic/rt-agent-runtime-core`, old head `30b589d736d303eb37071c01e853c64805871f65`. Preserve it as an ancestor. Publish with the requested `OMP_UPSTREAM_PR_PUSH` and exact lease; verify `git ls-remote` and PR #92 `headRefOid` equal local HEAD. Final SHA/readback are in the publication log and final lane reply. Rollback target is the old head; rollback is not executed.

Risks: legacy binding entries have no trajectory snapshot, so they inform the reviewer but cannot prove deterministic equivalence until a new decision is recorded. The guard retains three recent distinct bindings; older decisions can age out. A contradictory owner statement without a changed row trajectory must first be reflected in the row evidence. This is source and controlled runtime proof, not an installed/live DC session proof. No PR description or review comments were posted.
