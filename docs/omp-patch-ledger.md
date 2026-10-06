# Omp patch ledger

| Lane | Defect | Owner | Evidence |
| --- | --- | --- | --- |
| FixRestartChain, 2026-10-05 | “Stop omp restart leaving old process alive”: each graceful restart retained a full-heap parent awaiting its child's exit. | PR #93, topic/rt-restart-queue, baseline 12b20ffcb6e655d9922fc900f36b8954edf58c6f | External receipts under `/home/kom/proj/ai_pr/omp-restart-chain-evidence/`: `pre-fix.log` exits 1 with old PID 2124829 parenting successor 2125090; `focused.log` exits 0 (36 pass), including startup crash exit 1 and restart waiter failure; `types.log` and `build-final.log` exit 0; `smoke.log` exits 0, both restarts retain PID 2129949 and PPID 2129948. Logs are not shipped in the PR. |
| RestartChainSingleProcess, 2026-10-06 | Babysitter row “Restart leaves one omp process per tty”: read-only ancestry and durable restart transitions identify old self-restart parents, not updater command injection. | PR #93, `topic/rt-restart-queue`; starting head `1973a025df9168b8b430f51055e77cdfa21cf95b`, existing causal fix `44ecdb85c5da5ed61ea8cf37071d79dabd13fe8e` | Refreshed external receipts under `/home/kom/proj/ai_pr/omp-restart-chain-20261007-receipts/`: `live-proc.json`, `live-restart-events.json`, `live-exe-sha256.txt`, `focused-final.json`, `compiled-pty.json`, `pty-summary.json`, `negative-reverted.json`, `merge-tree-table.json`, `bun-check-final.json`. Compiled before/after: `script(1282104)---zsh(1282107)---omp(1282108)---omp(1283019)` versus `script(1283337)---zsh(1283340)---omp(1283341)`; both fresh controls and fixed restart return to their invoking shell with status 0. This follow-up strengthens the existing PTY test with a shell marker and no-restart negative control; it does not duplicate the already-pinned production fix. |

Design: use Bun 1.4.2's `process.execve`, not a supervisor. Replacement preserves
PID, TTY and the parent shell's exit-status contract while dropping the heap.
The exact checkpoint remains resumable if replacement startup fails. The old
IPC admission protocol is accepted only when an already-running pre-fix build
hands off during a rolling install. Existing pre-fix ancestors cannot update
their resident code and do not release on the next restart; a normal exit back
to the shell and `omp --resume <session-file>` reclaims that chain without signals.

The observed child starts map to explicit restart-control transitions on 2026-10-05
(UTC): PID 752366 at 13:45:28, wave 11; PID 1259196 at 14:54:15, wave 12;
PIDs 1991299 and 2000412 at 16:16:31 and 16:18:06, wave 13; PID 2610523
at 17:35:27, the owner-approved Hermes task-client configuration reload.
Every child inherits the restart-session and Node IPC markers; the initial
`omp --resume` processes are children of their shells and have no such markers.
The updater requests restart over the control API; it never injects a shell
`omp --resume` command into the TUI. The old owner path spawned the successor,
sent its handoff, and awaited `child.exited`, retaining the parent runtime.
Already-running ancestors execute those old bytes even after an atomic install.
Their reclamation remains a normal user-controlled exit/resume, never a signal,
forced restart, terminal attachment, or a guard against legitimate user commands.

The refreshed source tests reuse the recorded native proof artifact at
`/home/kom/proj/ai_pr/omp-restart-chain-evidence/pi_natives.linux-x64-modern.node`
(SHA-256 `4b2c74c85c94bf022809dd874669c57e1290192fd10d66fa9c205b25b1c29571`).
`git diff --name-only 12b20ffcb6 HEAD -- crates packages/natives` was empty;
the artifact's native-source identity therefore also matches this topic head.

The isolated old compiled binary reproduced retained parents but also returned
to its shell when its newest session exited normally. An older TUI reappearing
on `/exit` was not reproduced; the verified defect is the retained processes,
heaps and threads. The fixed binary preserved the same PID and one process
within the throwaway PTY and returned to the shell. No live chain was changed.


Native proof artifact was built from this isolated worktree's unchanged native
sources at baseline 12b20ffcb6, with CARGO_BUILD_JOBS=32 and the explicit
nightly-2026-08-12 compiler. No live process was restarted or signaled. The smoke
ancestry includes the launching live terminal's pre-existing ancestors outside
the disposable script PTY; none was added within that PTY across either restart.
