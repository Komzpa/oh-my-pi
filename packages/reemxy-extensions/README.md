# Reemxy extensions

## Presence settings

`goal_deadlines` derives the user’s timezone from persisted goal state (`state.timezone`), then falls back to the process `Intl` timezone.

Optional `reemxyPresence` is the package’s single settings key. Put it in OMP user or project settings; project fields override user fields:

```yaml
reemxyPresence:
  activeMinutes: 15
  awayMinutes: 30
  quietStartHour: 23
  quietEndHour: 9
  atRiskMinutes: 60
```

Hours are normalized to `0..23`; absent or invalid fields retain defaults.

## Bounded worker supervision

Every row-executing profile must target about 15 minutes of work. If an assignment clearly will not fit or context approaches compaction, the worker stops at the next checkable result, reports completed work with a receipt, and proposes a split of what remains.

`todo_dispatch` must issue a non-blocking PLAN CHECK once per active worker when its child session compacts or its run exceeds 15 minutes. The notice identifies the worker and condition, asks the lead to request done/left through `write agent://<id>`, then split the remainder. A ten-minute worker without compaction must not be named; the silent-15-minute notice remains independent. The oracles are `agent_router.test.ts` and `todo_dispatch.gates.test.ts`.

## Retrospective gate reset

A retro-facilitator `task` result clears the due flag and the notified-trigger key together: `retroDueReason`, `goalWorkStartedAt`, `reopenedRows`, and `retroDueNotifiedKey` all reset, so a later trigger with the same reason and deadline/delivery key notifies again. Cancelled/aborted worker jobs are never added to `workerFinishes` and so never appear as retro participants, though they still count as seen so they are not reprocessed. While a trigger's reason, deadline/delivery key, and finished-worker roster stay unchanged, the "retrospective due" line is emitted once and omitted from every subsequent PLAN CHECK; a new worker finishing under the same trigger changes the roster and reopens the notice. The oracle is `todo_dispatch.retro.test.ts`.

## Waiting on ready work

The wait gate lets the chief wait when the open work is waiting on something real: no refusal and no "N of 20 slots" notice. The points below are the whole requirement; each names its oracle.

1. **Waiting on running work or on the user is allowed.** While at least one task worker runs, `wait` passes (no block, no capacity notice) when every open row without a running worker either depends on a row owned by a running worker, or is `blocked` awaiting user approval of a proposal the chief has recorded. Example: 3 running workers, row A depends on a running worker's row, row B awaits user approval of a recorded proposal: the wait is allowed. Rows in these two states are never counted as parked, idle or unused capacity in any notice. Oracle: `todo_dispatch.wait.test.ts`.
2. **Shown capacity is capacity that can start.** Every worker-capacity number the package shows (wait refusal, chief refusal, MANDATORY REPLAN, PLAN CHECK, `Task cap=`) equals the number of workers that can start now: the Task cap bounded by the machine and the count of unique provider/model routes that pass the live, authenticated, non-depleted check used by `agentHasLiveModel` in `agent_router.ts`. A fixed or configured cap is never shown as free slots that no provider can fill; with no startable route the shown capacity is 0. Oracles: `agent_router.test.ts`, `todo_dispatch.test.ts`, `todo_dispatch.wait.test.ts`.
3. **The same refusal is noticed once.** Refusal notices are deduplicated by their content, not by an internal key: a refusal whose rendered content is identical to the previous refusal notice is not delivered again, whether or not the plan revision or any other internal key changed. Repeating the same `wait` returns no block and no new notice until the refusal content differs. Oracle: `todo_dispatch.wait.test.ts`.
4. **Clock times use the user's timezone.** Every clock time in a notice (`due HH:MM`, `P95 HH:MM`, `compacted at HH:MM`, past-P95 check-ins) is rendered in the timezone `goal_deadlines` derives (persisted `state.timezone`, else the process `Intl` timezone), never raw UTC. With `TZ=Asia/Tbilisi`, a P95 of 19:16Z renders as `due 23:16`. Oracles: `goal_deadlines.test.ts`, `todo_dispatch.gates.test.ts`.
5. **Work with no commit is surfaced, never aborted.** A running worker, an `in_progress` row, or a wait that has run for more than 15 minutes since the worker's spawn or resume with no new commit in that worker's worktree is marked `⚠ <N>m no commit` (for example `⚠ 17m no commit`) on its TODO row and HUD line, and is listed first in PLAN CHECK as `suspect: <row> · <worker> · <minutes> · <last line>`. The chief answers each suspect with an action or a one-line explanation. The harness never aborts, cancels or re-dispatches the worker for this. A worker whose worktree gained a commit within the last 15 minutes, or that has run 15 minutes or less, is not marked. Oracles: `todo_dispatch.gates.test.ts`, `interactive-mode-todo-clear.test.ts` (coding-agent).
6. **A worker is shown once.** A running worker appears exactly once across the TODO section and the Subagents list: on the TODO row it owns when it owns an open row, otherwise in Subagents; never on both surfaces. Oracles: `subagent-hud-render.test.ts`, `interactive-mode-todo-clear.test.ts` (coding-agent).
7. **Owned work survives collapse.** An `in_progress` row owned by a running worker stays visible when the TODO section or its stage is collapsed. Oracle: `interactive-mode-todo-clear.test.ts` (coding-agent).
8. **`OMP_LANE_UNIT` is a single-writer lane.** When the variable is set, including to an empty value, the extension does not register staffing requirements, refuse tools to compel worker staffing, inject chief-of-staff role/advice/PLAN CHECK or retrospective notices, or enqueue automatic continuation wakes. This mode overrides the chief-gate, retrospective and wake outputs above; non-staffing safety controls remain active. Oracle: `todo_dispatch.wait.test.ts`.

Negative controls, unchanged outside `OMP_LANE_UNIT` mode: a truly idle row (dependency-ready, not awaiting approval, no exact running owner) with free startable capacity still refuses the wait, and so does waiting with nothing running. That refusal identifies the row and its recorded owner, states that the owner is not running, and gives one conditional repair: set `schedule.owner` with `todo schedule` if a running worker already does that row; otherwise start a worker for it. A single ready row is never framed as unused machine capacity. A failing service or failed task worker still raises its recovery notice; allowing a wait never suppresses it. Oracles: `todo_dispatch.wait.test.ts`, `todo_dispatch.test.ts`.

## Event-woken turns and file safety

9. **Repeated event-woken status does not reach the user twice.** Only worker-result, IRC, or harness-notice wakeups are event-woken; user-initiated turns are never collapsed. Normalize digits, hex ids/SHAs, and worker names, lowercase, then collapse a final reply whose token-set overlap with the previous user-visible reply is at least 0.8 to one dim `(no change: status repeated)` line and one chief notice. Also collapse event-woken replies with at most six tokens and no digit, SHA, or URL. A duplicate receipt with the same worker id and result-text hash starts no new turn. A new SHA remains visible. Oracles: `event-controller-message-start.test.ts`, `agent-session-async-delivery.test.ts`.
10. **One non-isolated writer per checkout.** Refuse dispatch of a `coder`, `ui-coder`, `workhorse`, or `git-pr-owner` without `isolated: true` while another such writer is running in the same checkout. Name the active worker and tell the caller to pass `isolated: true`. One non-isolated writer and an isolated writer remain allowed. Oracles: `agent_router.test.ts`, `structured-subagent.test.ts`.
11. **File writes cannot silently destroy tracked content or escape the checkout.** Refuse empty writes and writes under 5% of an existing tracked file's byte size unless the call explicitly sets `replace: true`. Refuse `write`/`edit` paths outside the session repository and its worktrees unless the exact path is in `reemxyWriteAllowlist` user or project settings. Every refusal names the path and reason; normal in-repository writes pass. Oracle: `agent_router.test.ts`.
12. **A wake requires new information.** A harness notice with the same rendered content for the same row/kind is appended silently and does not start a chief turn; retro-due emits once per trigger key until that key changes. Empty event-woken assistant finals are not rendered. A new worker failure still wakes the chief. Oracles: `todo_dispatch.wait.test.ts` (repeat notices and failure wake), `todo_dispatch.retro.test.ts` (retro trigger lifecycle), `event-controller-message-start.test.ts` (empty TUI final).
