# Process lifecycle

This table records the implemented boundary after part A of the session-slice
cutover. It does not claim the launcher migration (part B) or the session
shutdown/startup reaper and process notices (part C) are implemented.

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
| Tool `systemd-run` service/scope | PATH shim calling the real manager binary | Transcript session slice unless manager options include explicit `--slice` | Transcript id supplied by the local tool environment | Service exit or explicit manager stop; automatic parent stop is part C | systemd; session reaper not yet part of this commit |
| Deliberate kept unit | Explicit `systemd-run --slice=omp-keep.slice` | `omp-keep.slice` | Explicit caller declaration | Explicit unit stop or natural exit, never a session-parent stop | systemd; process-view listing belongs to part C |
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
