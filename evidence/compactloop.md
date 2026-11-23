# Compaction livelock lane — 2026-11-07

Owner/base: PR #92 `topic/rt-agent-runtime-core`, cb7d7f2f15698f50f34b79a9ead38e39cf9bd8d7. Delivery: local `lane/compactloop-local`; NO push, install or live-process interaction. User explicitly requires local delivery because another lane writes #92. `but status` and `but commit` reject this linked worktree (`non-main worktrees are not supported`); worktree-local Git commit uses the skill's explicit exception.

## Inputs and decisions

The requested journalscan `evidence/journalscan.md` and turnfreeze `evidence/` did not exist. Read the actual prior `omp-journalscan-20261107/journalscan-root.md` and `journalscan-journal-copy.md`. Those explicitly leave root-reader attribution open. Read sibling turnfreeze brief and its composite source without editing that tree. Installed build 5cb50336 is absent from this object database, so no exact-installed-source claim.

`lane_ask.py` with the lane brief returned: “Yes—extend PR #92 on the local lane/compactloop-local branch.” Second decision: “Yes—commit the local #92 patch, without pushing or installing”; leave independently confirmed eager wording/Rust formatting failures untouched; offline result proves the resident breaker, not live-stack freeze elimination.

`~/.config/tasks-loop/omp-live-stack.json` maps #92 to `topic/rt-agent-runtime-core`. `git log --all -S 'Mid-run compaction ran between provider calls'` finds bbe3d98375e (introduction) and 7eeaba0471e (maintenance extraction). Current maintenance/dead-end changes are carried by #92. Existing per-active-array/cut-point protection blocks continuations, but a new cut point or user prompt admits another compaction over the same oversized resident context.

## Fix

SessionMaintenance retains a session-wide breaker keyed by provider/model/window. Ineffective committed compaction, no-preparation rescue, or exhausted no-reduction methods arms it. Fixed system/tool context at or above the trigger bypasses remote compaction entirely. Both blocking and speculative automatic compaction respect it. Growth is measured consistently using local resident tokens: retry after max(4096 tokens, 5% model window); material shrink or model/window change clears it. Explicit model selection checks the rebuilt resident context immediately and warns when it exceeds the new window. Manual compact remains a separate path.

One custom `compaction-backoff` message is persisted and appended to the live agent state, recognized by existing harness conversion, and emitted as one visible warning. It names model, window, local resident tokens, system/tool tokens and the larger-window/shrink-resident remedy. Existing compaction divider warning carries that same text.

Two all-history searches in `#commitCompactionEntry` and snapcompact frame-rescue rebuild now use `sessionManager.getEntry(id)` instead of `getEntries().find(...)`.

## Reader evidence

In the sibling indexed-loader snapshot, getEntries -> index.entries(true) -> get(each id) -> readPositionedSessionEntry -> JSON.parse. Thus searching one fresh compaction entry decodes all historical bodies. `goal_deadlines.session_compact` already uses metadata selections in this #92 base and is not changed here.

Executed `evidence/compactloop-indexed-read.ts` on the lane-owned journal copy, network isolated (`unshare -Urn`), isolated HOME/XDG, using sibling composite only as a read-only mechanism probe:

| lookup of the same freshly appended id | process rchar delta | elapsed ms |
| --- | ---: | ---: |
| getEntries().find | 2,444,221,031 bytes | 6217.138 |
| getEntry(id) | 131 bytes | 0.180 |

131 bytes is /proc/self/io measurement overhead; 118531 entries in the probe. This is process read-byte accounting around the lookup, not disk-device I/O. The cold resume happened before measurement. Composite manager SHA256 d3e17b691d3067b3f0e2d7ccc384263f03a86ca85cb07d2f2669010d04af70df; loader fe58fc91fcac2825a86ed0f5bc01ebad9ce21234b991cf4bb58e4d351c1274bb. This snapshot already removes the hot compaction getEntries calls; this lane carries equivalent changes on standalone #92. It is not a fresh composite build or exact installed-build profile.

## Tests and isolated journal resume

New regression command: `bun test packages/coding-agent/test/agent-session-auto-compaction-progress-guard.test.ts -t 'backs off across|warns immediately'`. Base cb7d7f2 production files + new tests: 0 pass, 2 fail (4 starts instead of 1; missing switch-time notice). Candidate: both pass. Test also spies getEntries and verifies no all-history lookup during compaction. Four new turns cause one compaction/notice; larger-window switch permits maintenance again; oversized system prompt + 1024 window causes zero compactions and one immediate notice. Existing normal recovery/continuation cases remain covered.

Updated previous cut-point retry tests to require meaningful growth rather than retrying unchanged resident content at each boundary. Growth test preserves the asynchronous persistence barrier contract. Speculation test preserves the no-expanding-summary contract and verifies backoff plus growth rearming.

Focused command: `bun test packages/coding-agent/test/agent-session-auto-compaction-progress-guard.test.ts packages/coding-agent/test/agent-session-mid-turn-compaction-dead-end.test.ts packages/coding-agent/test/compaction-speculation.test.ts`. Raw output: compactloop-focused.log. Package typecheck: `bun run --cwd packages/coding-agent check:types`, 4933 files. Full bun check passed TS lint/format/workspace types; fails unchanged Rust formatting at crates/pi-shell/src/bash/trace/viz/printer.rs:1216 and runtime_tests.rs:93. Broader eager test fails test/agent-session-eager-compaction.test.ts:355 (“Consider calling”); same 8 pass/1 fail reproduced with original production sources. No unrelated source changes.

Full journal copy came from the existing frozen `omp-dcproof-20261107` copy, 2,707,315,251 bytes before header rewrite. Copied with 1MiB streaming buffers and changed only header cwd to `/home/kom/proj/ai_pr/omp-compactloop-20261107/offline/cwd`. No full read of live journal. `unshare -n` is denied; `unshare -Urn` succeeds. Command: `unshare -Urn env HOME=/home/kom/proj/ai_pr/omp-compactloop-20261107/offline/home XDG_CONFIG_HOME=/home/kom/proj/ai_pr/omp-compactloop-20261107/offline/xdg bun evidence/compactloop-offline.ts`.

Real SessionManager.open + AgentSession + in-process mock provider, 3 actual prompt turns: cold open 8224.5ms; turns 183.196 / 58.124 / 52.687ms. Resident 72583 local tokens, system 8001, window1024: 0 compactions, exactly 1 Harness notice, 3 stub-provider calls. No tools/extensions or live process were used. Cold open is still O(journal) in standalone #92; this patch removes repeated compaction hydration, not cold startup.

## Limits

No installation/push, and no measurement on live DC. The offline resident-overflow reproduction and indexed lookup probe establish the two mechanisms independently; they do not reproduce every live remote-compaction/critic/worker interaction or establish a 5–200s live-freeze SLA. Breaker state is in memory and resets on process restart. Logs remain lane-local, scripts and this report preserve replay details.
