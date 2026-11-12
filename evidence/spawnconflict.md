# Task spawn admission, PR #92

Objective: refuse deterministic spawn gates before reporting success; mixed batches keep independent siblings; preserve late runtime conflict detection. Base and rollback: a116732e9249dba175e3d9facdb5c9a3172fc33e. Authorized publication: fork topic/rt-agent-runtime-core only, exact lease. No installation/updater, private config, live sessions, desktop, DC checkout, upstream or main writes.

## Before / after

Read-only grep of the named DC journal confirmed 2026-11-07 18:17 PrCaptures-3 and ReviewRuntime-5 executor start/failed records. Supplied live symptom: `Spawned 2 background agents using task, install-owner` followed by `Task execution failed: Assigned resources conflict with row "Verify levelled power inventory and incomplete inputs"; keep one writer per resource.` after 36 ms. No journal edits.

Reproduction uses real TaskTool, AsyncJobManager, router admission, resource resolution and harness converter with only the subprocess mocked. Before (same new tests, exact base task/index.ts): mixed call claims Spawned; synchronous call reports Task execution failed after entering executor. Five regression cases fail, zero pass (../base-regression.log).

After, conflicting member first line:
`REFUSED: no worker was spawned for PrCaptures: resources ["<fixture>/shared.ts"] held by row "Holder" (owner Holder-1)`
Then separate successful sibling: `Spawned agent Independent (job Independent).` Refused member has no async job, subprocess invocation, progress entry or row-owner assignment. Advisory counts include only admitted workers. Admission checks also cover streamed speculative and synchronous dispatch. Runtime hook still repeats the check and records only real starts, catching claims acquired while queued. Common fixturegates formatter was extracted from ExtensionRunner, retaining its original generic wording. Per-item refusals use existing harnessNotice text provenance; harness user conversion leaves sibling results intact.

Released/narrowed resources are read from current canonical schedule.resources with schedule.progress.evidence. Prose never overrides an overlapping structured claim. No new release parser or second refusal formatter.

## Decisions and proof

lane_ask decisions retained in ../decision.txt and ../scope-decision.txt, with ../brief.md: approve admission phase on existing hook plus retained runtime check; require synchronous coverage; structured release/narrowing; linked-worktree Git fallback after but refusal. but status reports `non-main worktrees are not supported`.

Focused contracts include mixed conflict, no-conflict/released/narrowed resources, all-refused, late claim failure, speculative refusal, other deterministic gate, synchronous sibling success and user harness conversion. Regression command: `PI_CODING_AGENT_DIR=/tmp/spawnconflict-agent bun test packages/reemxy-extensions/extensions/task_spawn_admission.test.ts packages/coding-agent/test/task/task-preflight.test.ts packages/coding-agent/test/task/task-blocking-split.test.ts packages/coding-agent/test/task/task-file.test.ts packages/coding-agent/test/harness-notices.test.ts packages/coding-agent/test/extension-task-hook-error.test.ts`: 49 pass, 0 fail, 250 assertions (../regressions3.log). Host consumers: extensions-runner, task-respawn-owner, spawn-run: 120 pass, 0 fail, 334 assertions (../host-final.log).

Native tests use the supplied untracked addon, SHA256 2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b, same artifact named by criticstale evidence. No native build/provenance or installed acceptance claimed. Dependency installation ignored scripts and preserved lockfile.

Full package suite first failed because package cwd lacked .tmp (ENOENT in old red-rows.test.ts:162). Created ignored fixture directory, without source changes. Exact base production files with old 74 suites from root: 770 pass, 0 fail (../extensions-base.log). Final package suite and composite results follow in delivery addendum.

## Delivery addendum

Pushed production SHA: `ce53644fc6cac9429be873fe9ad399eb2a7c5ff4`. Exact lease used old `a116732e9249dba175e3d9facdb5c9a3172fc33e`; both `git ls-remote fork refs/heads/topic/rt-agent-runtime-core` and `gh pr view 92 -R Komzpa/oh-my-pi --json headRefOid` returned that production SHA. All old commits preserved by ancestry. Same-topic evidence-only follow-up retains these production bytes; final publication readback is retained in `../publication-final.log`.

- Final focused regressions: **49 pass, 0 fail, 251 assertions**, `../regressions-final.log`. Rework routing plus admission: **11 pass, 0 fail**, `../rework-final.log`.
- Full extensions: `PI_CODING_AGENT_DIR=/tmp/spawnconflict-agent bun run --cwd packages/reemxy-extensions test`: **778 pass, 0 fail, 10,537 assertions, 75 files**, `../extensions-delivery.log`.
- Host runner/respawn/spawn-run consumers: **120 pass, 0 fail, 334 assertions**, `../host-delivery.log`.
- Final source `bun run check:ts` **exit 0**, including lint, format and all package types: `../types-delivery2.log`. Full `bun check` previously exited 1 solely on unchanged Rust comment formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`, `../check-final.log`; their diff from base is empty. After recurring generic script-exit output, consulted **Bun 1.4.4 `bun run --help`**, saved `../bun-run-help.txt`, and root package.json: check runs check:ts/check:rs in parallel; the failure is check:rs, not a Bun compiler error. No full-check green claim.
- Updated composite has **79 PRs**, not the older recipe's 77. `lane_ask` approved using the complete current manifest (`../composite-decision.txt`). Manifest SHA256 `44d385e18a827cc9927405cdaacfe3abef8329db598cabdcaf0fc6854a752331`, fork/main base `9370e7bfe26e948d72f53f918e681b402e600383`, union `0800f6e5084baee624fdb622ba163dc0bc02cb96`; **79/79 frozen heads verified ancestors**. Ledgers and reproducible assembly: `../composite-evidence/spawnconflict-{manifest,heads,merges}.json`, `../assemble.py`. Generated rules.json regenerated from merged KDL. `bun run --filter './packages/*' --sequential --if-present check:types` **exit 0**, `../composite-final-types.log`. Canonical `stack_check.py --repo . --candidate topic/rt-agent-runtime-core=ce53644fc6c --no-fetch`: **79 clean**, `../stack-final.log`. Available fork/main rehearsal; no fresh-upstream claim.
- First composite exposed adjacent edits from another topic in speculative policy and synchronous tool notices. Adjusted our call sites to merge independently; no other topic changed. A broad signature edit temporarily removed the rework policy argument; final typecheck caught it, parameter restored, and rework regression passed. No unresolved source/type/test failure remains.
- `lane_ask` delivery decision (`../delivery-decision.txt`) explicitly approves exact-lease publication with the documented unchanged Rust gap. No installation or live acceptance attempted.
