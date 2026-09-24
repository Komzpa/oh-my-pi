**Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in `task`.**

After each successful status/list-changing op (not `view` or `schedule`): if nothing is `in_progress`, the earliest `pending` task auto-promotes; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may move the focus pointer back to an earlier phase—expected; completed tasks NEVER revert.

## Operations

| `op`       | Fields                                                                       | Effect                                                                                                       |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `init`     | `list: [{phase, items: string[]}]`                                           | Initialize full list; replaces existing                                                                      |
| `init`     | `items: string[]`                                                            | Flattened single-phase init                                                                                  |
| `start`    | `task`                                                                       | Mark in progress                                                                                             |
| `done`     | `task` or `phase`                                                            | Mark completed                                                                                               |
| `drop`     | `task` or `phase`                                                            | Mark abandoned                                                                                               |
| `block`    | `task` or `phase`; required `reason`                                         | Block only for a concise (≤160 normalized characters) concrete external gate naming its actor or condition; agent-actionable unblocking work must be tasks |
| `unblock`  | `task` or `phase`                                                            | Blocked task → `pending`                                                                                     |
| `rm`       | optional `task` or `phase`                                                   | Remove task/phase; omit both → clear                                                                         |
| `append`   | `phase`; `items: string[]`                                                   | Append tasks to phase; lazily creates phase                                                                  |
| `schedule` | `updates: [{task, dependencies?, owner?, resources?, estimate?, evidence?}]` | Atomically update scheduling metadata; does not change status                                                |
| `view`     | —                                                                            | Read-only; echo list                                                                                         |

`schedule` identifies tasks by their exact unique content. Dependencies are exact task-content references, not phase/list ordering; only add edges for real prerequisites. `owner: ""` clears the owner; `resources: []` clears exclusive resources. An estimate has optimistic/likely/pessimistic **remaining seconds** (O/M/P), qualitative confidence, and a nonblank `basis`; `likelySeconds` is the most likely duration, not the mean. Native ETA is the P95 of simulated beta-PERT completion times through the dependency/blocking graph and resource constraints, not a sum of task percentiles. Shared predecessors are sampled once; parallel joins wait for every predecessor. Expected CPM uses the mean `(O + 4M + P) / 6`. Forecasts disclose independent-duration and numerical-sampling assumptions; unknown blockers keep dependent ETAs unknown. O/P are scenario bounds, not a statistical confidence interval. Runtime supplies the timestamp. Nonempty `evidence` records observed progress and its timestamp, but never marks a task done.

After `init` or `append`, schedule EVERY unfinished task before continuing affected work, including blocked future work: each needs a finite ordered optimistic/likely/pessimistic remaining-seconds range, confidence, evidence-based nonblank `basis`, and an explicit dependency set (`[]` only when independence is established). Missing scope means bounded discovery and an assumption-based range, not unknown or a fabricated default. Estimate discovery first when needed, then update the range from its evidence. If pessimistic work exceeds 3600 seconds, decompose it into executable tasks and schedule those. Effort estimates for work after a release remain required. A genuinely external, unbounded release may remain blocked with its exact condition and action evidence, without any invented release ETA.

ETA is fixed to the last accepted estimate (or a later real start), never to the redraw clock. When ETA is missed, explicitly reestimate remaining work with the failure reason, observed artifact evidence, and a new duration range. The runtime counts accepted replacement estimates; evidence-only edits, view, and rejected batches do not reset the clock or counter. Repeated misses require a changed strategy, smaller bounded steps or reassignment, not the same estimate again. Keep the original deadline unchanged.

Use the critical path and total/free float to choose late starts and recovery order. Start independent work promptly and in parallel with distinct owners/resources when useful; the single `in_progress` marker is a focus pointer, not a limit on concurrent owners. If a critical/low-float task slips or fails, reassign/replan promptly and protect the overall deadline; never extend a user deadline. Missing planning inputs make the forecast incomplete and require concrete discovery/repair. Do not count time passing as progress or repeat validation as fake work; there is no universal forced test stage.

## Anatomy

- Task content: 5–10 words; what, not how; unique identifier.
- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules

- Mark tasks done immediately after real completion; express prerequisites with schedule dependency edges, never phase order.
- NEVER make a todo call the turn's only tool call. Batch with real work: `init` with first reads/edits; each `done`/`start` with next action. Solo todo turns waste a round trip.
- Blocking is not a way to avoid planning or reminders. First try safe agent-actionable unblocking work and split unfinished unblocking work into tasks. Block only while a real external gate still prevents safe progress; state the gate and its actor or concrete condition concisely (≤160 normalized characters), e.g. `Awaiting approval from the user` or `Waiting for production access permission`. Do not block vague internal prerequisites or lengthy explanations; preserve genuine user-authorized approval/permission gates.
- Keep introduced `task`/`phase` strings stable.
- Lost exact task text: `view` echoes list; NEVER guess from memory.

## Create a list

- Task requires 3+ distinct steps.
- User explicitly requests one.
- User provides a set of tasks.
- New instructions arrive mid-task: capture before proceeding.

<critical>
User gives multi-step plan—phased todo, numbered/bulleted checklist, or "N bugs/items/tasks":
- MUST `init` every item as its own task before working.
- Enumerate all; NEVER summarize into fewer tasks, sample "the important ones", drop items, or track the rest from memory.
</critical>
