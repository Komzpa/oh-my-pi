# Full-history stringify freeze — 2026-11-08

## Result and ownership

Local `lane/stringifyfreeze`, extending #92 (`topic/rt-agent-runtime-core`) from `73d7978ab69b0286aa9e7c961ecb773573566460`. The live-stack manifest maps that branch to #92. No push, installation, live process interaction, or live configuration writes were performed. The implementation and this evidence belong in one local commit for the queued #92 writer.

Raw objective and authority: `../brief.md` outside this checkout. Required acceptance: several offline turns, task spawn, maintenance and plan critic, a reproduced multi-second interval with at least 1 GB rchar, then a maximum in-turn block below 1 s. Preserve history contents, caller ownership, experimental gating, selectors, and grep behavior.

## Recovered cause

The frozen journal records the lead calling `read history://current/full:1-80` at `2026-11-07T20:55:16.201Z`, then reporting OOM for ranged read and literal grep at `20:55:35.458Z`. This brackets the supplied `00:55:27.581+04:00` 11242 ms UI stall. The new full-history route originated in #92's `54cae2c7176` lineage.

Two costs precede selector application:

1. `ReadTool.#handleInternalUrl` → router/`HistoryProtocolHandler.#resolveCurrentFull` → `sessionResolveContext.getSessionBranch` → eager `SessionManager.getBranch()`: hydrate the complete indexed ancestry.
2. `formatCurrentBranchFullHistory` → `renderRawEntry` → `JSON.stringify(entry, null, 2)`, followed by joining the complete multi-GB markdown string. Grep reaches the same renderer through URL filesystem virtual resolution.

Instrumentation recovered those exact stringify stacks, including individual 14,565,803-character results. See `before-spawn-stack.json`, the local CPU profiles, and `heartbeat.ts`. The initial causal run reached **18614 ms / 2982359143 rchar bytes**, reproducing OOM. Its `before/` directory also contains earlier attempts; the final quantitative comparison below uses fresh, separate output directories only.

The supplied perf/trap evidence and recovered tool call establish this read/grep cause. They do not establish that every earlier freeze timestamp has the same cause. Worker/critic launches are included as controls, not inferred causes from temporal proximity.

## Change

Full-history read and URL filesystem search share an asynchronous, private-file materialization. It obtains the lazy branch view, renders/writes one entry at a time, yields between batches, and caches the existing ancestry. On append it rewrites the previous final block and new entries; a rewind/fork rebuilds the cache. It snapshots the view length because appends may occur during asynchronous writes. Concurrent materializations serialize per caller. Existing formatter bytes are retained, with no truncation or omitted raw entries.

The first materialization still reads the whole branch, but without eager hydration or a whole-history JS string. Subsequent requests reuse the prefix. Temporary files use the central `TempDir` owner and are removed on normal process exit.

## Offline reproduction and measurement

`repro-complete.py` restores `/home/kom/proj/ai_pr/omp-turnfreeze-20261107/fresh.jsonl` before every run and rewrites both session header cwd records to the disposable lane directory. HOME and XDG paths are under the lane; source is the archived installed composite in `../offline-source`. `unshare -Urn` isolates networking, and provider/memory calls terminate at loopback stubs. Neither the DC checkout nor the live journal is opened for mutation.

Commands, using the baseline archived source and then that source plus this patch:

```sh
unshare -Urn python3 evidence/repro-complete.py before-spawn
unshare -Urn python3 evidence/repro-complete.py after-spawn
python3 evidence/metrics.py evidence/before-spawn
python3 evidence/metrics.py evidence/after-spawn
```

Each run has eight completed root turns: a real `task` spawn, two `history://current/full:1-80` reads, and a full-history grep, interspersed with text replies. `VerifyLevelledPowerOffline` and `CriticPlan` successfully launch; their `agent_end` maintenance routes execute. Auxiliary sandbox artifacts are preserved between runs; the frozen parent journal and stub program are restored identically. Earlier denied spawn attempts are retained separately and excluded from this comparison.

Measurements are milliseconds of a nominal **10 ms main-thread heartbeat interval**, including the timer's nominal 10 ms. Per-turn maxima include any heartbeat interval overlapping a root turn, including a pulse delivered just after turn end. Startup is excluded. p50 is the median of the eight per-turn maxima, not provider or tool latency. rchar is `/proc/self/io` bytes read during the interval, including page-cache reads, not physical disk throughput. Source: `before-metrics.json`, `after-metrics.json`, `runtime-proof.json`; as of the 01:18–01:21 Tbilisi runs on 2026-11-08.

| Metric | Before | After |
|---|---:|---:|
| Completed root turns | 8 | 8 |
| p50 of per-turn maximum interval | 350.962 ms | 254.194 ms |
| Maximum, also including between-turn intervals | 9819.659 ms | **430.968 ms** |
| rchar during maximum interval | 2984034901 bytes | 2089813 bytes |
| First range read | OOM, 8598 ms | success, 14125 ms asynchronous wall time |
| Second range read | OOM, 9442 ms | success, **38 ms** wall time |
| Grep | OOM, 9889 ms | success, 1480 ms asynchronous wall time |

The three failing baseline operations each read about 2.98 GB during their stall. After the patch all three return content; both reads contain the full-history header and grep returns matching lines. The first materialization produces about 3.1 GB of markdown on disk. Raw profiles and event logs remain in local `before-spawn/` and `after-spawn/`; small extracted stacks/routes and metrics are committed here. `source-proof.json` records source hashes; composite-only differences in context comments, instruction read tracking, and tool registration were preserved when applying the patch.

## Root maintenance control

The eight-turn replay continually dispatches work and does not naturally settle its root. Following `decision-coverage.txt`, a separate `repro-settle.py` probe uses the same frozen journal, disables the three configured dispatch extensions, reports 1000 input tokens, and returns text without tools. It reaches root `agent_end` after three turns with stop reason `stop`, then logs `entered` and `bottom-checkCompaction` at `01:22:55.028` and `.030+04:00`. The root notification follows at `.037`. Maximum turn interval is **54.157 ms**. This is a separate successful-settle control, not a second before/after comparison or a reproduction of every maintenance branch. See `settle-routes.json` and `settle-metrics.json`.

```sh
unshare -Urn python3 evidence/repro-settle.py settle
python3 evidence/metrics.py evidence/settle
```

## Verification and decisions

- Focused history, grep, and URL filesystem suite: **90 pass, 0 fail**, 265 assertions (`focused-final.log`). Tests retain caller/feature boundaries, prove exact file bytes through append/rewind, avoid rehydrating cached prefixes, preserve a snapshot during a live append, and reject eager `getBranch()` in real read/grep paths.
- `bun check`: exit 0 (`bun-check-final.log`). Formatting was corrected using the local `bun run --help` and `oxfmt --help` interfaces; no unrelated formatting changes remain. `git diff --check` passes. The committed check log only normalizes trailing whitespace; the original remains in `bun-check-final.raw.log` locally.
- After a probe reader encountered a string-valued RPC `message`, Python's local `python3 -m pydoc json.loads` documentation was consulted: JSON deserializes to a Python object, not necessarily a dict. The metrics reader checks its type before field access.
- `decision-source.txt`: archive and replay installed source in isolation.
- `decision-fix.txt`: shared incremental materialization; selector-only repair would leave grep broken; keep #92 local.
- `decision-scope.txt`: keep this fix to the reproduced in-turn path and disclose cold-start/first-read limits.
- `decision-coverage.txt`: add the separate root-settle control, which has now completed.

## Remaining limits

Cold session startup still has a roughly 5 s synchronous journal-load interval before `session_start`; this patch does not claim a sub-second startup. First materialization remains proportional to journal size in wall time and disk use; one unusually large single entry can still take time to parse/stringify. The probes emit a native-library version warning (18.17.0 artifact with an 18.18.0 source tree); both sides use the same artifact. The causal JS path and focused behavior tests pass, but a matching-native packaged build and live DC verification remain unperformed. Deployment is explicitly outside this lane's authority.

GitButler's diff and commit entry points reject this linked worktree as unsupported; the skill's worktree-local Git commit exception applies. Existing history and authorship are preserved. No source carrier was published.
