# Process lifecycle

Parts A and C implement session parenting, shutdown, startup orphan reaping,
and hidden owned-CPU notices. Launcher migration (part B) is separate.

`sessionSliceName(sessionId)` from `@oh-my-pi/pi-natives` is the canonical name:
`omp-tool-<h12>.slice`, where `h12` is the first 12 lowercase hex characters
of SHA-256 of the full session id. UUIDv7 timestamp prefixes are not session
identities: sessions minted milliseconds apart must have distinct parents.
Local bash passes the full transcript id as `OMP_SESSION_ID`, separately from
its shell/job session key. Native per-call slices are
`omp-tool-<h12>-call-<pid>-<id>.slice`; systemd's
hyphen-delimited hierarchy places them beneath the session parent. The
per-call `TasksMax=500` readback and cleanup remain intact.

| Process class | What starts it | Slice after part A | Owner | End of life | Reaping site |
| --- | --- | --- | --- | --- | --- |
| Local bash external commands and descendants | Bash tool / session bash runner, native shell wrapper | Per-call child below the transcript session slice | Native per-call owner; transcript id identifies the parent | Per-call cancellation, timeout or owner drop; successful background work retains the call owner | `ToolProcessLimit::drop`, existing shell process-scope pruning |
| Local PTY command | Bash PTY path, native PTY wrapper | Per-call child below the transcript session slice | Native PTY owner | PTY cancellation/teardown and native owner drop | Native PTY teardown and `ToolProcessLimit::drop` |
| Tool `systemd-run` service/scope | PATH shim calling the real manager binary | Transcript session slice unless manager options include explicit `--slice` | Transcript id supplied by the local tool environment | Service exit, explicit stop, or session dispose/process exit | `SessionSliceLifecycle.stop`; startup marker reaper |
| Deliberate kept unit | Explicit `systemd-run --slice=omp-keep.slice` | `omp-keep.slice` | `OMP_SESSION_ID` in the member environment | Explicit unit stop or natural exit, never a session-parent stop | Listed in the hidden CPU notice and exit log; keep slice never stopped |
| Browser broker and automation Chrome | Existing project daemon broker | Existing project launch boundary, not migrated in part A | Existing project broker | Existing broker/daemon teardown | Existing broker cleanup; per-session launch ownership belongs to part B |
| Daemon tool process | Existing daemon broker launch | Existing launch boundary, not migrated in part A | Existing broker/daemon owner | Existing stop and broker teardown | Existing broker cleanup; PID/start-time pruning belongs to part B |
| JavaScript/Python eval kernel | Existing eval context/kernel launcher | Native per-call boundary; session-id propagation not migrated in part A | Existing eval resource-scope owner | Kernel/context shutdown and native owner drop | Existing kernel/context disposal and `ToolProcessLimit::drop` |
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

