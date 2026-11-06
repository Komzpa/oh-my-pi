# Seance journal fork and observers — 2026-11-08

Owner: **Komzpa/oh-my-pi #92**, `topic/rt-agent-runtime-core`, from the read-only `~/.config/tasks-loop/omp-live-stack.json`. Local carrier: `lane/seancefork`, based on `66c38306f7d7a69729152ca9b1a2c1c9c9e820f9`. No push, install, updater, main-branch change, live-process interaction, desktop access, or live journal/config mutation. `internal-urls/context.ts` is untouched (#93 ownership). Raw objective and constraints: `../brief.md`.

## Cause and boundaries of proof

1. `task/seance.ts` prepares `session.fork.sourceFile`. Executor calls `SessionManager.forkFrom(..., {seance:true})`. Before this patch it loads **all** parent entries, merely neutralizes `session_init`, and serializes the entire inherited journal into the child. Compactions only affect model context; they do not reduce this byte copy.
2. `TaskTool` is constructed during tool discovery even for a restricted seance. Its constructor subscribes to the shared subagent lifecycle/progress bus. Follow-up events append `task_worker_activity`; ordinary lifecycle/progress events replay the inherited parent todo and persist `user_todo_edit`. Thus unrelated worker events enter the child's journal through its own observer. This is not a live journal-to-journal replication subscription.
3. `reemxy-extensions/todo_dispatch.ts:workerCompactionAt` has a synchronous disk fallback: `readSync` over the whole child, UTF-8 decoding, substring filtering and `JSON.parse`. Its cursor survives normal append polls, but is discarded on session load/switch/branch/tree reset, errors, or removal from the active-worker set. Each cold observation can block again. The old loop on the frozen child reproduces a 7.76 s block.
4. `registry/persisted-agents.ts:readPersistedAgentHistory` caches only size/mtime. Any append invalidates that cache and streams/parses the whole journal again. It yields, so this path reproduces **GB-scale recurring rchar**, rather than the 7 s synchronous interval. Actual registry calls below reproduce 3.716 GB after each tiny append.
5. Cold revival calls `peekSessionInit` (whole-file streaming read), then `SessionManager.open` to restore history. Warm revival also opens the persisted journal. These are reconstruction reads, not maintenance reads on every ordinary turn. New compact seances make both inputs small. Existing legacy journals still require an initial reconstruction scan; this patch does not silently rewrite them.

Supplied live evidence: installed `ed18cb83`, fd 103 traversing RecoverLabelFeedback repeatedly, and maintenance timestamps, as recorded in `../brief.md` and `../fdpoll.txt`. These establish the observed target and timing. Offline tests identify capable causal paths; no live JS stack was captured in this lane, so the exact contribution of each reader to every supplied freeze is not claimed.

## Change

- A seance persists `buildSessionContext(history).messages` as a fresh linear message snapshot. Retired raw messages, parent custom runtime entries, inherited startup contracts, workspace roots and artifacts are not copied. The existing `seanceSource` header preserves artifact lookup. The source remains untouched. Full forks retain their old behavior.
- Seance TaskTool instances do not subscribe to lifecycle todo observers. Ordinary workers retain the existing observer behavior (negative control in the todo persistence tests).
- A shared read-only `JournalCursor` retains the complete-record byte offset. It uses positional asynchronous reads, yields every MiB, preserves incomplete UTF-8 records until newline, serializes concurrent polls, and resets on missing/replaced/truncated/same-size rewritten files. Errors reset the observer instead of retaining a partly applied accounting cache.
- Both compaction fallback and persisted history use this cursor. Persisted accounting retains only parent links and small assistant/model summaries, then recomputes leaf-scoped metrics; ordinary appends read only new bytes. Concurrent persisted refreshes serialize. First observation still scans the prefix once, asynchronously. A single unusually large JSON record remains an indivisible parse; the measured input includes records up to 32,985,640 bytes.

## Offline measurements

Frozen input: reflink copy `../repro/child.jsonl` of RecoverLabelFeedback, **3,715,853,501 bytes**, 156,814 physical lines at copy time. It is itself a seance child containing the full multi-GB parent's history, and is used unchanged as the parent in the real fork probe. New child outputs are separate files. The extra live lines since the supplied 156,788-line snapshot explain the line-count difference.

Unit: milliseconds of a nominal **10 ms main-thread heartbeat interval**, including the nominal interval. Maximum includes any delayed pulse delivered immediately after the measured operation. Startup module loading is excluded. rchar is `/proc/self/io` bytes, including page-cache reads, not physical disk traffic. Measurements are local 2026-11-08 around 02:02–02:06 Asia/Tbilisi; wall times were affected by concurrent offline probes and compilation. No provider was contacted by these probes; HOME/XDG/agent paths were redirected under `../repro/home`.

| Probe | Before max interval | After max interval | Before reads | After reads |
|---|---:|---:|---:|---:|
| Actual `forkFrom(seance)` | 7894.65 ms | **501.15 ms** | 3,715,997,193 B | 3,715,958,589 B (one source scan) |
| Cold compaction observer | 7763.13 ms | **46.62 ms** | 3,715,953,146 B | 3,716,002,018 B (one initial scan) |
| Next compaction observation, append | 10.06 ms | **10.06 ms** | 278 B | **276 B** |
| Actual registry refresh, first | 900.74 ms | **182.01 ms** | 3,717,276,255 B | 3,717,318,298 B |
| Actual registry refresh, append 1 | 608.01 ms | **10.98 ms** | 3,715,962,998 B | **250 B** |
| Actual registry refresh, append 2 | 703.45 ms | **26.84 ms** | 3,715,965,874 B | **250 B** |

Fork output shrinks **3,715,853,990 → 1,447,067 bytes**. Both build 175 context messages. The focused compaction regression additionally compares exact canonical messages before/after fork and reopen. A final replay through the committed Python driver also passes: first interval 40.74 ms, then 256 B per append (`seancefork-registry-driver-after.json`). Registry direct cost is identical on both sides: 0 → 0.125 → 0.25. Raw small measurements: `seancefork-{fork,observer,registry}-{before,after}.json`.

Reproduction scripts: `seancefork-repro.py`, observer script, and fork/registry `.ts.in` templates. The driver materializes pinned baseline sibling modules only for the run, then removes them. Run sequentially, outside another check/test invocation:

```sh
python3 evidence/seancefork-repro.py fork before ../repro/child.jsonl ../repro/repeat-fork-before
python3 evidence/seancefork-repro.py fork after ../repro/child.jsonl ../repro/repeat-fork-after
python3 evidence/seancefork-repro.py observer before ../repro/child.jsonl ../repro/repeat-observer-before
python3 evidence/seancefork-repro.py observer after ../repro/child.jsonl ../repro/repeat-observer-after
python3 evidence/seancefork-repro.py registry before ../repro/child.jsonl ../repro/repeat-registry-before
python3 evidence/seancefork-repro.py registry after ../repro/child.jsonl ../repro/repeat-registry-after
```

The compaction baseline is an extracted copy of the exact fallback loop, rather than a complete DC runtime replay. Fork and registry probes call actual implementation entry points. `lane_ask.py` accepted this offline proof together with focused lifecycle tests: `seancefork-decisions.txt`, `seancefork-decision-proof.txt`. Full offline agent_end runtime replay, packaged-build verification, and live DC/provider replay are not performed; no live fix claim is made.

## Verification

- Core focused suite: 116 pass, 0 fail, 708 assertions across cursor, forks, todo observer, persisted attribution, seance source, SDK startup and cold revival tests (`seancefork-focused.log`).
- Todo wait suite: 82 pass, 0 fail, 415 assertions (`seancefork-wait.log`). The earlier parallel run hit one 5 s timeout; the isolated full-file rerun passed in 2.85 s.
- Todo gate integration suite: 68 pass, 0 fail, 1285 assertions (`seancefork-gates.log`), including live/disk compaction notices. `bun check`: exit 0 including TypeScript, formatting/lint and Rust checks (`seancefork-bun-check.log`).
- Dependency setup: frozen install refused because the checkout catalog and lockfile differ. `bun install --no-save` supplied local dependencies without modifying tracked dependency files. No dependency change belongs to this patch.

## Cleanup proposal only — no operations performed

After upgrade, first verify the new installed source and a real seance spawn: small child journal, no unrelated worker activity, responsive maintenance, stable append-read volume. Do not compact or delete a journal while its writer is live.

For RecoverLabelFeedback and PrDescriptionAuthority: keep byte-exact originals and their source/artifact relationships in a private archive with size/hash manifest; once parked, build replacement compact journals **on copies** using the canonical context builder, retaining each child's own restricted session_init and post-fork messages/receipts. Compare restored context, latest leaf, tool restrictions, cost attribution and artifact resolution before any approved migration. Existing files mix parent ancestry and child events; truncating at the last compaction or stripping by timestamp alone can lose evidence and restart contracts. A future migration needs an explicit target/rollback and separate authorization; this lane supplies no automatic rewrite.

For the reported 33 GB directory: inventory exact files and identify active writers, source pointers, nested worker journals, restart queue snapshots, blobs and unique artifacts. Deduplicate only proven identical copied ancestry in an archive; preserve divergent child tails and all referenced artifacts/blobs. Use supported session GC/archival only after reader compatibility and retention are verified. Do not remove the whole directory or protected session archives. No current 33 GB size was remeasured and no reclaim amount is promised.

GitButler `diff` and `commit` both refuse this linked worktree (`non-main worktrees are not supported`). The GitButler skill allows a worktree-local Git commit in this case; no push or remote mutation follows.

The committed check log normalizes trailing whitespace only; the raw log remains at `../repro/bun-check-final3.log`.
