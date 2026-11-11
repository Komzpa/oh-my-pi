`todo` tracks the work. Batch routine updates with the next real tool call when one is ready; an explicit row NEXT ACTION to close, re-estimate, or record a user decision is itself the work for that turn.
Tasks identified by verbatim content, NEVER generated IDs (task-1). Unique, stable task/phase names; lost text: view, NEVER guess.
`append` requires `items`; omitted `phase` uses the in-progress task's phase, else the first pending task's phase, else the last phase, else a new `Tasks` phase. Supply `phase` to target another phase; an empty name is invalid.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately (phased/numbered/bulleted/N); NEVER omit or remember leftovers.
After successful mutation: no active means earliest pending starts (phase order); multiple active means only earliest stays. Blocked NEVER starts automatically; unblock returns pending. Done out of order may rewind pointer but NEVER reopen completed. Mark done immediately; follow phase order.
Delegated rows: keep each exact row linked to its worker with `schedule updates:[{task,owner}]`; running workers and dependency waits need no duplicate dispatch.
Before staffing, compare the requirements ledger's origin quote and requirement text with the proposed deliverable. Set `schedule updates:[{task,decision:"owner"}]` when the agent supplies product content the owner or stakeholder has not specified or approved: a demo/showcase scenario, user flow, step order, layout choice, or new copy. A request to create a demo does not approve the scenario you invent. Preserve the quoted request and name the introduced choices in row evidence. Do not infer this flag from a title. Show the actual content in a review page before closing; an auditor pass proves execution, not product approval.
An owner-specified defect fix (including cosmetic fixes) with passing executable checks and inspected required screenshots closes on audit without asking the owner. Critic clean/timeout alone never creates an owner question. Read `reviewAnswers` and forwarded page answers first; never ask again for the same content identity. Keep accepted choices across attempts; materially different product content gets a separate decision row. Present unresolved product decisions before confirmation questions.
Delivered rows enter runtime verification: the runtime audits, re-audits after HEAD moves, and closes passing deliveries; wait for its result.
Findings-only, failed/aborted/refused/lost workers and failed audits need `task tasks:[{name,agent,task}]` continuing the prior output and findings; follow the row's per-turn NEXT ACTION.
A ready-to-close row uses `todo {op:"done",task:"<exact row>"}` with evidence; a user review answer uses `schedule updates:[{task,review:"accepted"|"redo"|"drop",evidence}]` quoting their decision.
External user/service gates: block with the concrete actor/condition, ask once, then wait; `unblock` when the condition clears. Never block a delivered row merely because reconciliation remains.
**Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in `task`.**

After each successful status/list-changing op (not `view` or `schedule`): if nothing is `in_progress`, the earliest `pending` task auto-promotes; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may move the focus pointer back to an earlier phase—expected; completed tasks NEVER revert.

## Operations

| `op`       | Fields                                                                       | Effect                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | `list: [{phase, items: string[]}]`                                           | Initialize full list; replaces existing                                                                      |
| `init`     | `items: string[]`                                                            | Flattened single-phase init                                                                                  |
| `start`    | `task`                                                                       | Mark in progress                                                                                             |
| `done`     | `task`, `phase`, or `items: string[]` (batch)                                | Mark completed                                                                                               |
| `drop`     | `task`, `phase`, or `items: string[]` (batch)                                | Mark abandoned                                                                                               |
| `block`    | `task` or `phase`; required `reason`                                         | Block only for a concise (≤160 normalized characters) concrete external gate naming its actor or condition; agent-actionable unblocking work must be tasks |
| `unblock`  | `task` or `phase`                                                            | Blocked task → `pending`                                                                                     |
| `rm`       | optional `task` or `phase`                                                   | Remove task/phase; omit both → clear                                                                         |
| `append`   | `phase`; `items: string[]`                                                   | Append tasks to phase; lazily creates phase                                                                  |
| `schedule` | `updates: [{task, content?, dependencies?, owner?, resources?, estimate?, evidence?}]` | Atomically update scheduling metadata; does not change status                                                |
| `view`     | —                                                                            | Read-only; echo list                                                                                         |

`schedule` identifies tasks by their exact unique content. Dependencies are exact task-content references, not phase/list ordering; only add edges for real prerequisites. `owner: ""` clears the owner; `resources: []` clears exclusive resources. An estimate has optimistic/likely/pessimistic **remaining seconds** (O/M/P), qualitative confidence, and a nonblank `basis`; `likelySeconds` is the most likely duration, not the mean. Native ETA is the P95 of simulated beta-PERT completion times through the dependency/blocking graph and resource constraints, not a sum of task percentiles. Shared predecessors are sampled once; parallel joins wait for every predecessor. Expected CPM uses the mean `(O + 4M + P) / 6`. Forecasts disclose independent-duration and numerical-sampling assumptions; unknown blockers keep dependent ETAs unknown. O/P are scenario bounds, not a statistical confidence interval. Estimate every row from its own scope: a `schedule` call that gives three or more rows the same O/M/P is refused, and a result may list the median and p90 of finished runs for an owner's role/model; calibrate against it. Runtime supplies the timestamp. Nonempty `evidence` records observed progress and its timestamp, but never marks a task done.
`content` on a schedule update renames the row; its status, owner and history stay attached, and dependency references follow the new title. Blank or colliding titles reject the entire schedule batch.

After `init` or `append`, schedule EVERY unfinished task before continuing affected work, including blocked future work: each needs a finite ordered optimistic/likely/pessimistic remaining-seconds range, confidence, evidence-based nonblank `basis`, and an explicit dependency set (`[]` only when independence is established). Missing scope means bounded discovery and an assumption-based range, not unknown or a fabricated default. Estimate discovery first when needed, then update the range from its evidence. If pessimistic work exceeds 3600 seconds, decompose it into executable tasks and schedule those. Effort estimates for work after a release remain required. A genuinely external, unbounded release may remain blocked with its exact condition and action evidence, without any invented release ETA.

ETA is fixed to the last accepted estimate (or a later real start), never to the redraw clock. When ETA is missed, explicitly reestimate remaining work with the failure reason, observed artifact evidence, and a new duration range. The runtime counts accepted replacement estimates; evidence-only edits, view, and rejected batches do not reset the clock or counter. Repeated misses require a changed strategy, smaller bounded steps or reassignment, not the same estimate again. Keep the original deadline unchanged.

Use the critical path and total/free float to choose late starts and recovery order. Start independent work promptly and in parallel with distinct owners/resources when useful; the single `in_progress` marker is a focus pointer, not a limit on concurrent owners. If a critical/low-float task slips or fails, reassign/replan promptly and protect the overall deadline; never extend a user deadline. Missing planning inputs make the forecast incomplete and require concrete discovery/repair. Do not count time passing as progress or repeat validation as fake work; there is no universal forced test stage.

## Anatomy

- Task content: 5–10 words; what, not how; unique identifier.
- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules

- Mark tasks done immediately after real completion; express prerequisites with schedule dependency edges, never phase order.
- Batch routine updates with real work when available. Act on explicit row closure, re-estimation and review instructions immediately; do not invent another tool call to accompany them.
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

For a user decision, use `schedule` with `review: "user"` and `reviewPage: "http://..."` on the decision row. Publish one review card per decision (accept/redo/drop). Set `reviewCard` to the published card slug. The runtime reads `api/answers` about every 60 seconds and on lead idle, and applies current accept/redo/drop answers through the native review path once per row/card/content hash/answer. Legacy rows match one unique card by its exact landed row, title or content; ambiguous matches stay unresolved. Hashes come from the manifest or rendered `data-id`/`data-sha`. Stale answers are reported to the lead, never applied. Read saved decisions before asking again. `reviewPage: null` clears the artifact.

At 50 closed rows, a row closure automatically archives older closed history. The last ten closed rows, open-row prerequisites and pending review/handoff rows stay live. Use `view` with `archive: true` to list the archive, or `view` with `task` to retrieve any row by its exact content. Archived rows remain addressable for review acceptance and reopening.
