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
| Browser broker and automation Chrome | Per-session/project daemon broker through `ToolResourceScope` | Session parent, with a native per-call child | Transcript session id; no cross-session Chromium/profile sharing | Broker shutdown or session-parent stop | Existing broker cleanup and native scope owner drop |
| Named bash service | Per-session/project broker; pipe children inherit its scope, PTY uses the existing native launcher | Session parent | Transcript session id | Existing stop/broker shutdown or session-parent stop | Broker cleanup; persisted PID and `/proc/<pid>/stat` field 22 must match on read |
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

Every 15 seconds the lifecycle reads the session cgroup's `cpu.stat usage_usec`.
Two consecutive windows at at least half a CPU core trigger one hidden
`session-owned-cpu` next-turn message while idle or waiting on a tool. This
avoids short startup bursts while catching forgotten busy loops in about 30
seconds. The top CPU cgroup/unit, PID and cumulative CPU seconds are included.
The dedupe picture is top unit/PIDs, ordinary versus >=4-core load, and this
session's kept members; growing CPU seconds alone do not resend the notice.
No model turn or visible user notification is started by this sampler.

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

