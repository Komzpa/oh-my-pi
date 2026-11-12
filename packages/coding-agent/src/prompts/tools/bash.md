Persistent bash 5.3.
cwd will reset after each turn, don't rely on cd; `pty` = interactive.
{{#if hasLaunch}}
Service calls accept materialized `async: false` and `timeout: 0` placeholders silently. An explicit `async: true` or nonzero `timeout` with `name` is ignored with a notice; use `ready.timeout` for readiness.
{{/if}}
Internal URIs work as paths for builtins/coreutils, redirects, globs.
In-process builtins, ahead of PATH: {{join builtins ", "}}.
{{#if asyncEnabled}}
`async` defers finite results but keeps the deadline (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.
{{/if}}
When launched asynchronously, the current worker or session still owns the running command.
Don't trunc output by habit, result will be summarized and saved as an artifact.
{{#if hasLaunch}}
Long-lived services, including review pages and servers collecting user answers:
- launch with a unique `name` so the broker owns the process across session restarts.
- Do not launch these with `async`, `nohup`, or `&`: shell-owned jobs can be killed when OMP exits.
- Keep the service name and URL for resuming work; stop it explicitly only when no longer needed.
- `ready` requires `name`; no async/timeout; pty defaults true.
- ready needs log regex or port (both if given); host defaults 127.0.0.1, ready.timeout 30s.
{{/if}}
{{#if autoBackgroundEnabled}}
Non-`pty` calls still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`, if sooner) usually move to background job `bg_N` and keep running to `timeout`.
No backgrounding when the client terminal runs the command or the job cap is reached.
The result arrives automatically as a follow-up message. NEVER poll.
{{/if}}
Local `systemd-run` defaults to the session slice; explicit `--slice` is preserved. Only `--slice=omp-keep.slice` designates deliberate long-lived work.
