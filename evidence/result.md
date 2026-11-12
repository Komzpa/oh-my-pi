# Plan critic live-start repair (2026-11-07)

Target remains fork PR #92, `topic/rt-agent-runtime-core`, starting head `77054de61f7`, local lane `lane/criticlive`. #93 is outside this lane. No installation or production session operation is authorized.

The live configuration names three individual files in the installed reemxy-extensions package, rather than its package root. Adding `plan_critic.ts` only to `omp.extensions` therefore never registers it. The fix registers the critic from the already-configured `todo_dispatch.ts` and removes the separate manifest registration so package-root loading still creates one critic.

A second reproduced skip is the `parentSession` check: the real SDK moves a contested copied session to a sibling continuation with both `parentSession` and `continuationOf`. It remains a main agent. The critic now uses `ctx.agent.kind`, retaining the header fallback for older contexts. A depth-zero subagent remains excluded.

Polling is once a minute; the review interval remains 45 minutes. An empty initial plan can become reviewable without waiting 45 minutes. Tick/start skip reasons each produce one debug and one warning per extension instance. History selection follows indexed parent entries and yields every 256 entries, without constructing/filtering a full transcript branch. The selected requirement ledger and audit receipts are reused by the digest instead of rereading the branch for each row.

Verification uses the exact base/head regression and full-suite receipts under `criticlive/`.


## Earlier completed work

The worker/question/requirement/receipt delivery report remains in the history at `77054de61f7:evidence/result.md`, with its proof under `evidence/workerask/`. It is not rerun or republished as this repair.

## Frozen journal and reproduction

`criticlive/fixture.json` records the exact private 2,564,978,964-byte snapshot and SHA-256. It was copied with `cp --reflink=auto`; production JSONL was read only. The later snapshot has six open rows. The journal bytes stay in the lane, outside git.

The installed-shape package is a lane-local copy under `node_modules/@oh-my-pi/reemxy-extensions`, with the same individual extension entry paths as the live configuration. `probe.ts` uses the real SDK `SessionManager.open` + `createAgentSession` + `initializeExtensions`; restore additionally enters the CLI's `restoreSession`. The reviewer tool is stubbed and lead model streaming throws if called. A normal-exit marker on the copy prevents replaying its interrupted turn; background child restoration is disabled. No actual re-exec, live provider judgment, installed-binary acceptance, installation or production session operation is claimed.

Base `77054de61f78ccb780462e1d26fb531a9a9a30b2` loads those entries with no loader errors but dispatches zero critics in 60.47 seconds. Patched normal resume reaches one reviewer in 0.72 seconds; final patched restore reaches one in 0.43 seconds after initialization starts. Both use the copied full journal. An earlier probe loading the package root passed on base, which is why a package-root-only test missed the production configuration defect.

Boundary deviation: the first two standalone probes used the default logger and wrote their own process logs under `~/.omp/logs` (PIDs 1883255 and 1921142); ordinary SDK ownership/cache bookkeeping was not fully isolated either. They never opened the production journal for writing or operated the live lead. Subsequent probes redirect logs, and the retained probe now refuses a config root outside the lane. The no-`~/.omp`-writes requirement was therefore not fully met by this run. No installed files or live configuration were edited.

## Source delivery

Implementation commit: `cc3fa980db114ae90967a6087e89f0ff7a022321`. GitButler refused this linked worktree, so its documented Git commit exception was used. Existing #92 history and authorship remain intact. Publication is only to `fork:topic/rt-agent-runtime-core`, with an exact lease against `77054de61f78ccb780462e1d26fb531a9a9a30b2`. That starting head is the rollback source target; no rollback or installation was performed.


## Verification

- Full extensions: `bun test --parallel packages/reemxy-extensions/extensions/*.test.ts`: 707 pass, zero fail, 66 files. The tests cover configured-path loading, normal resume, restore, one package-root critic, continued-main versus depth-zero child, bounded skip logging, the first-minute poll and the exact 45-minute repeat boundary.
- New behavioral regressions fail against the starting production implementation (legacy resume/restore dispatch, first-minute polling, and continued-main identity), then pass on the patch. `regression-base.txt` and `regression-head.txt` retain the first comparison; `extensions.txt` is the final full run including the logging test and tighter periodic boundary.
- Cooperative selection: the active ancestry is ordered, a detached later sample is excluded, `getBranch()` throws if used, and an event-loop heartbeat runs before collection completes. This is an executed behavior check, not a source-text assertion.
- Final `bun run check:ts` passes; final extension-only types also pass. `bun check` remains red only on inherited Rust comment formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`. Neither Rust file changes here. The command is the repository script in [package.json](../package.json), rather than a guessed compiler invocation; Bun 1.4.4 help was consulted after its repeated generic exit message.
- Canonical `tools/omp/stack_check.py` on fresh upstream fails at pre-existing #16530 in `packages/coding-agent/src/task/index.ts`, after seven clean PRs and before #92. Starting #92 and patched #92 produce the same blocker. A separate, explicitly pinned-base run of that same checker merges all 77 current manifest PRs cleanly on `9370e7bfe26e948d72f53f918e681b402e600383`, including #93. It is a rehearsal, not a current-upstream green result.

Full todo/session baseline and final counts, failure-name comparison, exact ordered paths and log hashes are retained in `criticlive/core-comparison.json` and the associated receipts. These broad suites are not claimed green.

Final broad run: **3133 pass, 18 skip, 31 fail, one between-tests error; 3182 tests / 319 files** (adds the cooperative-selection test). Base: **3129 pass, 18 skip, 34 fail, three between-tests errors; 3181 tests / 318 files**. One named final-only failure was a 6.05-second prompt-cache setup-hook timeout, followed by a late `authStorage.keys` setup error. Its exact case passes in isolation on both base and head (`cache-base.txt`, `cache-head.txt`). Four base-only failure names are timing-sensitive memory/queued-delivery cases and are not claimed fixed. All other final failure names occur on base. The recorded broad failures remain open outside this critic repair.

## Publication readback

The source and evidence carrier `c60f1468ed7361c638d3964efac4a9a3758d8452` was pushed successfully with the exact starting-head lease above. Both `git ls-remote fork refs/heads/topic/rt-agent-runtime-core` and `gh pr view 92 --repo Komzpa/oh-my-pi` returned that full hash; PR #92 remained OPEN. Receipts are `criticlive/source-branch-readback.txt` and `source-pr-readback.json`. Only #92 was pushed. This final receipt-only commit follows that verified carrier; its own full published head is read back and reported in the delivery response, avoiding a self-referential hash in this file.
