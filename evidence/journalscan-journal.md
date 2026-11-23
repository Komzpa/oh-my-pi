# Journal scan lane: #92 extensions

Owner: fork `topic/rt-agent-runtime-core` PR #92; local `lane/journalscan`, base `1b322d0cc4a9ce43aef909675f25696aa2f7aec6`. No push, no install, no live session reads.

## Findings

* `extensions/todo_calibration.ts:43` previously reread and split the whole router `spawns.jsonl` whenever mtime/size changed. `todo schedule` result calls it (`todo_dispatch.ts:6318` after this change). `git log -S 'readDurationHistory'` traces original historical introduction to `65a3361caed`; current independent topic history aggregates it in `5a28074efa1`.
* `todo_dispatch.ts:726` durationFloors reread the same whole router journal every minute on estimate checks; `git log -S durationFloorsCache` finds `7863d9dcdea` in this topic. Both sites predate installed #92 `ec0383df` and `772058df`; calibration source is byte-identical at ec0383df and current lane base. Neither reads the root 2.7GB session.
* Worker compaction detection (`todo_dispatch.ts:4824` after change) already uses live SessionManager selection or incremental byte cursors with 64KiB buffers; activity stats only stat journals, trace inspection reads bounded 256KiB tails. Chief runbook read happens only on compaction and targets skill Markdown.
* Non-#92 candidates were handed to lead: requirement-artifact.ts reads full audit worker files, session-manager rewriteEntries has a full-read fallback only for non-FileSessionStorage, session-storage deletion full-read is cold, RPC subagent transcript has explicit fromByte cursor. Root reader attribution remains lead-owned.

## Change

One router-history owner now consumes appended complete records, retaining offset and compact samples/spawn map. Unchanged file reads zero bytes; replacement, same-size edits and truncation invalidate via inode/dev/size/mtime/ctime. Incomplete record replay starts at its original byte boundary. Duration floors derive from that history, eliminating their independent read.

Cold cache initialization still scans the router journal once synchronously. This patch does not claim to fix the observed root-session loop block. Warm append path is measured below.

## Decision

Invoked `python3 /home/kom/Dropbox/Reemxy/tasks-loop/tools/codex/lane_ask.py` with facts and `--context /home/kom/proj/ai_pr/omp-journalscan-20261107/brief.md`. Decision: YES—implement incremental bounded router-history cache on #92 and derive duration floors from single owner; keep root-session cause unproven and investigate other branches. Here bounded means 64KiB input buffers, not a limit on cold initialization time.

## Executed proof

Bun 1.4.4, synthetic router journal >=1GiB, ASCII 65535-byte JSON padding records. Repro: `bun evidence/journalscan-router-bench.ts`. Warms history once, appends one 124-byte valid outcome, measures next read and queued zero-delay timer. Files grew by 124 between runs; this tiny delta is included in the byte measurements.

| path | fixture bytes | read bytes/tick | synchronous ms | queued timer delay ms |
|---|---:|---:|---:|---:|
| base 1b322d0 | 1,073,791,347 | 1,073,791,347 | 570.549169 | 577.207767 |
| candidate | 1,073,791,223 | 124 | 0.065759 | 1.472849 |

`todo_calibration.io.test.ts` fails 2/2 on base (whole-file read on append; premature incomplete-record admission), passes 2/2 on candidate. Combined calibration tests pass 7/7. Raw receipts and benchmark script are siblings of this evidence file. Focused broader suite and package type check recorded below after completion.

Broader command: `bun test packages/reemxy-extensions/extensions/todo_calibration.io.test.ts packages/reemxy-extensions/extensions/todo_calibration.test.ts packages/reemxy-extensions/extensions/todo_dispatch*.test.ts` passed 452/452 (8444 assertions), after creating required `.tmp` directory. That execution reused read-only build-stage node_modules, including composite-family host modules and native addon SHA256 `2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b`. It is a composite-family extension test, not standalone native-source proof. Native sources differ in 59/1862 compared paths; no native changes made here. A standalone rerun without that artifact cannot load the addon. Lead owns final exact composite verification.

With private workspace dependency links (`bun install --ignore-scripts`, reverted unrelated bun.lock update), standalone `bun run --cwd packages/reemxy-extensions check:types` passes (2807 files). Full `bun check` passes all TypeScript lint/format/types, fails only preexisting Rust comment formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`. Neither file changed in this lane; their source is not modified. Raw check log attached.
