# Process lifecycle

Parts A and C implement session parenting, shutdown, startup orphan reaping,
and hidden owned-CPU notices. This table records the session-slice launch
boundary through part B. Launcher migration (part B) is separate from those.

`sessionSliceName(sessionId)` from `@oh-my-pi/pi-natives` is the canonical name:
`omp-tool-<h12>.slice`, where `h12` is the first 12 lowercase hex characters
of SHA-256 of the full session id. UUIDv7 timestamp prefixes are not session
identities: sessions minted milliseconds apart must have distinct parents.
Local bash passes the full transcript id as `OMP_SESSION_ID`, separately from
its shell/job session key. Native per-call slices are
`omp-tool-<h12>-call-<pid>-<id>.slice`; systemd's
hyphen-delimited hierarchy places them beneath the session parent. The
per-call `TasksMax=500` readback and cleanup remain intact.

| Process class | What starts it | Slice through part B | Owner | End of life | Reaping site |
| --- | --- | --- | --- | --- | --- |
| Local bash external commands and descendants | Bash tool / session bash runner, native shell wrapper | Per-call child below the transcript session slice | Native per-call owner; transcript id identifies the parent | Per-call cancellation, timeout or owner drop; successful background work retains the call owner | `ToolProcessLimit::drop`, existing shell process-scope pruning |
| Local PTY command | Bash PTY path, native PTY wrapper | Per-call child below the transcript session slice | Native PTY owner | PTY cancellation/teardown and native owner drop | Native PTY teardown and `ToolProcessLimit::drop` |
| Tool `systemd-run` service/scope | PATH shim calling the real manager binary | Transcript session slice unless manager options include explicit `--slice` | Transcript id supplied by the local tool environment | Service exit, explicit stop, or session dispose/process exit | `SessionSliceLifecycle.stop`; startup marker reaper |
| Deliberate kept unit | Explicit `systemd-run --slice=omp-keep.slice` | `omp-keep.slice` | `OMP_SESSION_ID` in the member environment | Explicit unit stop or natural exit, never a session-parent stop | Listed in the hidden CPU notice and exit log; keep slice never stopped |
| Browser broker and automation Chrome | Per-session/project daemon broker through `ToolResourceScope` | Session parent, with a native per-call child | Transcript session id; no cross-session Chromium/profile sharing | Committed session switch/new, subagent lane completion/failure/task abort, session dispose, or broker shutdown | Session client release quiesces accepted launches and stops the owned daemons, then closes the connection; idle grace reaps the broker |
| Named bash service | Per-session/project broker; pipe children inherit its scope, PTY uses the existing native launcher | Session parent | Transcript session id | Explicit stop, committed session switch/new, subagent lane completion/failure/task abort, session dispose, or broker shutdown | Session client release; persisted PID and `/proc/<pid>/stat` field 22 must match on read |
| JavaScript/Python eval kernel | Existing native `ToolResourceScope`, with `toolSessionEnvironment` | Session parent, with a native per-call child | Transcript id (not eval's namespaced reuse key) | Kernel/context shutdown or session-parent stop | Existing kernel/context disposal and native scope owner drop |
| Unowned host/native operations | Existing host helpers | Existing `omp-tool-call-<pid>-<id>.slice` | Native per-call owner | Native owner drop | `ToolProcessLimit::drop` |

The PATH shim distinguishes manager options from the command's operands,
preserves both `--slice=value` and `--slice value`, and forwards argv unchanged.
`--slice=omp-keep.slice` is the sole deliberate keep marker. Explicit other
slices remain untouched; this is lifecycle/resource ownership, not an
adversarial same-user sandbox. No existing unit or desktop browser is migrated
or stopped by part A.

## Session shutdown and CPU ownership

`AgentSession.dispose()` awaits the stop of every transcript slice it acquired.
The process postmortem path awaits the same idempotent stop; raw process exit
has a bounded synchronous stop backstop. Ownership markers under
`run/session-slices` reuse the task-isolation PID/start-time check and add the
kernel boot id. Startup only reaps a canonical session slice with a complete
marker proving its recorded process instance is gone. Missing, malformed, or
unreadable ownership and live owners are left alone. Exclusive marker creation
prevents another live process from stealing the same canonical slice.

### Session-broker completion contract

An outgoing transcript ends when `newSession()` commits a different session id,
`switchSession()` commits a different session id, or `dispose()` completes. A
subagent lane also releases its transcript's daemon resources when its initial,
explicit follow-up, or autonomous IRC-wake run completes, fails, or is aborted.
This applies even when `keepAlive` retains the reusable `AgentSession` and its
transcript for interrogation or revival; idle-TTL parking is not the release
boundary. Ordinary root turn cancellation (`AgentSession.abort()`), a cancelled
or rolled-back switch, and a same-session reload are not transcript ends and
retain the active transcript's clients.

Before a successful end operation or successful published task result settles, every
cached project client owned by the exact outgoing id has stopped all its
broker's daemons, closed its socket, and been removed from the process cache.
Persistent, detached, and restarting daemons in that dedicated runtime are
included. A new-session failure after identity commit still releases the old
transcript. Release failure after a committed switch is surfaced without
rolling back to the already-released outgoing transcript.

The authenticated broker `release` operation establishes a synchronous launch
admission barrier before completion-subscription bookkeeping can await. It
drains all previously accepted start/restart/mode initialization, including
starts whose caller aborted locally before the daemon record was inserted and
native/detached launches still acquiring their PID. It then stops every record
through the existing stop facilities. Automatic restart timers cannot launch
during release. Old connections cannot start another generation; a fresh
connection after release may acquire resources for a resumed subagent.
Client connect spawns at most one broker, then polls the endpoint within its
10 s budget; if the endpoint is still missing past a 1 s grace with no live
broker pid in the scope, it spawns one bounded replacement instead of failing
blind with ENOENT (grievance #976). A live pid keeps waiting for its owner to
bind, since duplicate spawns cannot take a held lease.
Closing a client invalidates asynchronous startup preparation before it may
spawn. Release awaits any already-admitted connection or replacement, but does
not start a broker merely to tear down a client that never acquired a socket.
Previously connected scopes still recover on disconnect so their admitted
daemons, including detached processes, are drained.

Concurrent releases of one cached client await the same stop/close work. A
lookup registers its session generation before canonicalizing the project:
release invalidates in-flight lookups even if they resume after cache eviction.
Generation state exists only while lookups or releases remain in flight, not
as an accumulating session tombstone. A genuinely new lookup after release is
allowed. Before the broker release, the subagent's post-prompt and active-turn
drain has the existing hard 5-second post-prompt drain limit, independent of the
executor's soft disposal deadline. A timeout still proceeds to broker release;
the unfinished drain stays owned by deferred cleanup rather than blocking the
task result. Broker release itself remains awaited outside the soft deadline.
Session disposal and lifecycle-manager release share the soft deadline and
retain ownership of unfinished teardown through the existing deferred path.

Stops run concurrently across independent daemons/project clients and await
their bounded graceful/force-stop settlement (5 seconds graceful plus the
existing native termination and broker settlement bounds). A failed RPC,
creation, termination, or unsettled process rejects release rather than being
reported as successful cleanup. Every client still closes and is evicted in
`finally`; an error therefore means the no-live-daemon condition was not proven,
not that closed sockets/cache misses imply successful teardown. Session dispose
and subagent lifecycle finalization finish their remaining cleanup even when
release rejects. The initial task run publishes that failure as its final error
receipt without skipping result acceptance, post-shutdown job reaping, or late
cleanup tracking; the failed run is not reported as successful. Slice stops run
after broker release settles, including failure, never before its RPCs finish.

The measurable successful completion state is: no owned daemon process is
running, the original client rejects requests as closed, and a non-creating
cache lookup for the outgoing id is false. After the last connection and
registered presence leave its runtime, the broker exits after its configured
idle grace; release does not send broker-wide shutdown. Empty/unscoped main
clients, machine-global brokers, active parent/sibling sessions, and borrowed
desktop processes keep their connections and processes. Only the exact ended
transcript's broker scopes are released. Non-broker slice-owned tools retain
the existing dispose/process-exit behavior above.

### CPU ownership notices

Every 15 seconds the lifecycle reads the session cgroup's `cpu.stat usage_usec`.
Two consecutive windows at at least half a CPU core trigger one hidden
`session-owned-cpu` next-turn message while idle or waiting on a tool, plus
exactly one user-visible status line (`sustained CPU in session slice: <unit> <pct>% — agent notified`)
through the session notice facility. This
avoids short startup bursts while catching forgotten busy loops in about 30
seconds. The top CPU cgroup/unit, PID and cumulative CPU seconds are included.
The dedupe picture is top unit/PIDs, ordinary versus >=4-core load, and this
session's kept members; growing CPU seconds alone do not resend the notice.
No model turn is started by this sampler.

Services launched through the shim receive `OMP_SESSION_ID` explicitly because
the user manager does not inherit the tool environment. Scopes inherit it
normally. Keep membership is attributed only by that exact full session id in
`/proc/<pid>/environ`; other sessions' kept processes are not listed.

## Launcher inventory

Baseline cgroups below are code-derived inheritance unless marked live-proof;
we do not launch or migrate existing desktop/shared infrastructure to inspect it.

| Launcher owner | Baseline placement | Part B placement / decision |
| --- | --- | --- |
| `packages/coding-agent/src/launch/client.ts:327` broker | Caller cgroup (live-proof) | Existing native scope below `sessionSliceName(sessionId)`; separate runtime per full transcript id |
| `packages/coding-agent/src/tools/browser/shared-daemon.ts:102` automation Chromium | Project broker cgroup (live-proof) | Inherits per-session broker scope; profile and target registry are session-specific |
| `packages/coding-agent/src/tools/browser/registry.ts:303` spawned application browser | Caller cgroup | Existing native scope with transcript environment; borrowed CDP/desktop processes remain untouched |
| `packages/coding-agent/src/launch/broker.ts:891` pipe daemon / named service | Broker cgroup (live-proof) | Inherits per-session broker scope |
| `packages/coding-agent/src/launch/broker.ts:819` PTY daemon | Native unowned per-call slice | Existing PTY scope with transcript environment inherited from broker |
| `packages/coding-agent/src/launch/broker.ts:914` detached daemon | Broker cgroup | Per-session broker scope; existing daemon mode semantics unchanged |
| `packages/coding-agent/src/eval/py/kernel.ts:333` Python kernel | Native unowned per-call slice (live-proof) | Existing native scope with transcript environment |
| `packages/coding-agent/src/eval/js/context-manager.ts:1029` Bun eval subprocess | Native unowned per-call slice (live-proof) | Existing native scope with transcript environment; Linux still refuses thread fallback |

## Known gaps (lead-approved exclusions)

- LSP servers are not yet session-owned; their API has no session parameter.
  Canonical launchers: `packages/coding-agent/src/lsp/client.ts:1082`,
  `packages/coding-agent/src/lsp/mux/daemon.ts:233`, and
  `packages/coding-agent/src/lsp/mux/server.ts:103`; private children inherit
  their caller's cgroup, shared children inherit the project mux cgroup.
- Machine-global browser relay: `packages/coding-agent/src/tools/browser/relay/daemon.ts:63,82`.
  It shares a fixed TCP port and desktop extension across sessions. Its global
  broker/relay inherit the caller's cgroup; migration requires native keep
  support in `ToolResourceScope`, not a second launcher or per-session port race.
- Project blob-broker: `packages/coding-agent/src/blob-broker/daemon.ts:144,170,301`.
  Shared across sessions; broker/worker children inherit their launcher cgroup.
  Explicit keep placement needs native keep support in `ToolResourceScope`.
- Prediction/inference infrastructure: `packages/coding-agent/src/predict/client.ts:145,333`
  and `packages/coding-agent/src/subprocess/worker-client.ts:246,275` are the
  canonical owners. Global prediction uses the global broker; inference workers
  use the shared worker launcher. Their launcher cgroups are not session-owned;
  shared workers require explicit native keep support before migrating.

No shared infrastructure is silently labelled kept. Part B introduces no
parallel systemd launcher and does not move or stop any existing unit. A
persisted daemon with a missing/reused PID or mismatched birth tick is pruned
by `readStoredDaemonRecord`; exited history without a PID is retained.

