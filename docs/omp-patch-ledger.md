# Omp patch ledger

| Lane | Defect | Owner | Evidence |
| --- | --- | --- | --- |
| FixRestartChain, 2026-10-05 | “Stop omp restart leaving old process alive”: each graceful restart retained a full-heap parent awaiting its child's exit. | PR #93, topic/rt-restart-queue, baseline 12b20ffcb6e655d9922fc900f36b8954edf58c6f | External receipts under `/home/kom/proj/ai_pr/omp-restart-chain-evidence/`: `pre-fix.log` exits 1 with old PID 2124829 parenting successor 2125090; `focused.log` exits 0 (36 pass), including startup crash exit 1 and restart waiter failure; `types.log` and `build-final.log` exit 0; `smoke.log` exits 0, both restarts retain PID 2129949 and PPID 2129948. Logs are not shipped in the PR. |

Design: use Bun 1.4.2's `process.execve`, not a supervisor. Replacement preserves
PID, TTY and the parent shell's exit-status contract while dropping the heap.
The exact checkpoint remains resumable if replacement startup fails. The old
IPC admission protocol is accepted only when an already-running pre-fix build
hands off during a rolling install. Existing pre-fix ancestors cannot update
their resident code and do not release on the next restart; a normal exit back
to the shell and `omp --resume <session-file>` reclaims that chain without signals.

Native proof artifact was built from this isolated worktree's unchanged native
sources at baseline 12b20ffcb6, with CARGO_BUILD_JOBS=32 and the explicit
nightly-2026-08-12 compiler. No live process was restarted or signaled. The smoke
ancestry includes the launching live terminal's pre-existing ancestors outside
the disposable script PTY; none was added within that PTY across either restart.
