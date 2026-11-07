# Idle lead IRC and action-demand lane, 2026-11-07

Objective: blocking worker questions wake the idle lead promptly without storms; unsatisfied action demands wake at most once per key per interval; workers must not abandon a question before the lead receives it. No install, updater, live sessions, desktop, main/upstream pushes, or config writes.

Input: ../dc-journal-1817-1831.jsonl, supplied DC session 01a1921c extract. Read-only manifest ~/.config/tasks-loop/omp-live-stack.json (77 PRs at initial read).

## Journal correction and source trace

The claim that the lead had no turn from 14:19:13 to 14:30:27 is incomplete: lines 115, 152, 159 contain assistant completions with content=[], stopReason=stop at 14:24:39.600, 14:29:09.778, 14:30:19.818 UTC. Their request timestamps are 14:19:13.402, 14:24:39.976, 14:29:10.234. The provider histories also contain empty final text. No source-only evidence establishes why these calls took minutes. Do not claim that a finished idle loop ignored those questions.

Lines 175–177 contain the three questions, marked by IrcBridge as sent while waiting/working: host.isStreaming was true. AgentSession includes both actual agent streaming and prompt setup/recovery brackets in this flag. Streaming delivery queues IRC interrupts; idle delivery already invokes #wakeForIrc. Queued records remain visible via hasQueuedIrcFrom until drained. Existing prompt-race and stranded-aside guards must be preserved.

Line 96: wait was skipped due to pending system advisory, not executed. agent-loop executeToolCalls detects system steering and skips interruptible tools; hasMoreToolCalls stays true, steering is dequeued after turn_end and sent into the next model call. This path does not itself end the agent. Existing agent-loop system-advisory regression passes (1 pass, 10 assertions). The next request timestamp is 14:19:13.402, 191ms after the skip. The evidence contradicts the inference that no advisory continuation was attempted.

PR92 todo_dispatch planTick persists recovery/action-demand receipts, but requests a turn only when ctx.isIdle(). A persisted receipt alone is no wake. PR23 tools/wait has an unconditional ladder timeout even while the lead has not consumed the queued question. PR92 executor already defers runtime timeout for pending worker asks: the worker-authored abort cannot be attributed to the hard runtime cap from this extract.

## Placement decisions

lane_ask.py was invoked with ../brief.md on every judgment: initial DECISION assigned peer core/wait to PR23; after discovering PR92-only dispatcher, DECISION: keep PR23 core/wait and PR92 extension as separate disjoint owner commits. Final scope DECISION: bounded scope acceptable after tracing advisory skip; preserve idle IRC behavior, fix queued-question timeout and keyed action demand wake; do not infer a busy bypass or provider abort fix. Decision log: ~/.local/share/tasks-loop/state/logs/codex-lanes/omp-ircwake-20261107.decisions.jsonl.

## PR23 change and regression

Base dd748df69e5d1e6ad964897f76f0671c73d0f058. Wait timer renews while an answerable recipient has the caller question queued. Consumed delivery restores bounded timeout. Reply, abort, missing recipient, user wait and cycles keep their existing exits. No global isStreaming change.

New ten-minute regression fails on base: wait.test.ts settled=true, expected false. Candidate: 44 wait tests pass, 117 assertions. Four new tests cover delayed delivery, consumption, cancellation, departure. Command: bun test --preload ./packages/coding-agent/src/task/index.ts packages/coding-agent/test/tools/wait.test.ts. Preload avoids the existing task/index AsyncJobError import cycle.

bun check: exit 0; Rust skipped automatically because this topic changes no Rust-affecting files. Broad IRC/peer/task/aside/wait run: 968 pass, 4 fail, 4210 assertions (failed-child-artifact x3 and worktree generic git-not-found). Baseline/isolation investigation follows; this is not a green suite receipt.

Native artifact was supplied in the lane workspace before edits, SHA256 2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b. Its build provenance is not supplied; no native source/binary was edited or installed by this lane. Test coverage is source/runtime proof, not a native rebuild or installed-product proof.
