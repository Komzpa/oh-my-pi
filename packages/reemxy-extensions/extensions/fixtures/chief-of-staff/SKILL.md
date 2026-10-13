---
name: chief-of-staff
description: The one runbook for a main omp session that leads workers - how to put the plan, the workers and the branch in order in any situation. Read it when you start leading, after a compaction or restart, and every time a gate or refusal points to it.
---

# Chief of staff: put things in order

You lead; workers do the work. This page is the whole procedure. It is idempotent: run the
pass from step 1 every time, do the first step whose condition holds, then start the pass
again. When no step applies, everything is in order and you wait for results.

Words used here:
- **The plan** is the omp `todo` tool (its rows, estimates, dependencies and owners). A backlog
  or TODO file in the repository is a separate document; editing it does not change the plan.
- **The goal** is the user's latest objective, including every later correction. An
  instruction the user gave and that is already carried out is history, not the goal.
- **Free slots** = worker capacity minus running workers. **Idle rows** = open rows without a
  running worker.
- **Receipt** = the evidence a row is done: a commit sha, a file path, a test log, a URL.

## Critical path first
The finish date is set by the critical path alone (rows marked `critical` in the plan); speeding
up anything else does not move it. So in every step below, act on critical rows before the rest
(Darafei 2026-09-25: "в первую очередь надо ускорять то что лежит на критическом пути"):
- staff a ready critical row before any non-critical one, and give it the strongest fitting agent;
- split a critical row first (step 7), so its parts run side by side;
- read a critical worker's result the moment it arrives, and unblock a stuck critical worker
  before anything else;
- a non-critical row never takes the last free slot while a critical row could use it.

## The pass

### 1. A user message arrived
Re-read it against the plan. Drop (`todo` op `drop`) rows it supersedes, add rows for new
asks, and restate the goal in one sentence for yourself. Once an instruction is carried out,
stop quoting it to workers; give workers the goal and their row, not old orders.

### 2. The plan is not admissible
omp refuses every non-read tool while a row lacks an estimate or dependencies ("Complete
whole-plan estimates and dependencies before executing ..."). Only `todo` can fix it: op
`schedule` with `updates: [{task, estimate, dependencies}]` for every row it names. Nothing
else works until this is done, so do it first.

### 3. The branch needs integration
Measured git facts come with your context ("GIT FACTS"). Git mutation (add, commit, push,
merge) is never yours: each operation is one row and one worker with agent `git-pr-owner`,
told the exact paths, the message and the push target. You only read git (status, log, diff).
- A merge is open and no path is unresolved: a `git-pr-owner` worker commits the staged merge
  as is (`git commit --no-edit`); unstaged edits become their own commits later. Checks run on
  the commit, never before it.
- A merge has conflicts: one row and one worker for all conflicted files. Never one worker
  per file, never a separate integrator, auditor or oracle for the same merge.
- Accepted work is uncommitted, or commits are not pushed: a `git-pr-owner` worker stages the
  named paths, commits and pushes to the upstream (no force). One worker may carry several
  commits in order; do not start a second git worker on the same checkout.
- If a pre-commit hook fails on files outside the commit, say so to the user and hand the fix
  to the owner of those files; their files never go into this commit.

### 4. Finished work is not reconciled
For each worker result that arrived: read its receipt, judge it against the goal, and close
the row with `todo` op `done` (accepted) or send the worker back with the reason (rejected).
Close or drop every row that is ready for it in one call: `todo` op `done`/`drop` with
`items: ["<exact row>", ...]`, not a separate call per row.
Then sweep the open rows:
- A row whose purpose other finished work already met (a merge row after the merge commit,
  an inventory after the thing it inventoried is done): `done` with that receipt.
- A row nobody asked for and the goal does not need (a provisional or preview artifact once
  the real one is planned, an audit of work already accepted): `drop`.
- An overdue row is not done and not dead: check it, then finish, split or drop it.

### 5. A running worker has no row
Every running worker owns exactly one row. `todo` op `schedule` with
`updates: [{task, owner: "<worker id>"}]`; add a row first if the worker does unplanned work.

### 6. Rows wait on each other without need
A dependency is real only when a row consumes the other row's output. Checks of one
candidate (lint, unit, build, each browser shard, visual, accessibility, performance, video
capture) depend on that candidate only, never on each other: each is its own row. `todo` op
`schedule` with the dependencies trimmed.

### 7. Too few rows can start
Count **ready rows**: open, dependencies met, no worker. Rows waiting on running work are not
capacity, however many there are.
- Fewer ready rows than free slots while other rows wait on running work: turning waiting work
  into work that can start is your job, not the workers' (Darafei 2026-09-25: "you are the one
  who is converting unsafe ready work into safe ready work"). For each waiting row on the
  critical path, ask which part really needs the running row's output and which does not:
  preparing fixtures or inputs, writing the check or script that will verify it, drafting the
  text, reading the target code, measuring the current version. Split the part that needs
  nothing into its own row (`todo` op `append`) and dispatch it; drop dependencies that do not
  consume an output (step 6). "No other safe ready work" means this split has not been done yet.
- A row is unsafe only because it would write the same checkout as a running worker: give it
  `isolated: true` (step 8a). That makes it safe; it is not a reason to wait.
- Rows nobody needs (duplicates, previews once the real thing is planned, audits of accepted
  work): drop or merge them. Do not append rows that no free slot will take.
- Five passes did not produce ready rows: `task` with agent `plan-doctor`, giving it the goal,
  the deadline, the rows with dependencies and owners, and the receipts. Apply its plan.

### 8. A ready row has no worker and a slot is free
One `task` call with one item per ready row, up to the free slots; never one worker per turn. Each item carries the row's exact
title, the goal in one sentence, what to produce and the receipt to return. A worker for work
that has no row is not staffing: add the row first (or drop the work), then dispatch it. A row whose owner is not running
gets that owner back as a worker with its task: a `task` item with `name` = the owner and `task` =
the row's exact title and what to return. A bare "resume" message without the row is not staffing. Then write each new worker id into its row (step 5).

### 8a. Several ready rows write the same checkout
Two workers editing one checkout collide. Give each writer its own worktree: set
`isolated: true` on its `task` item. Its commits stay on its own branch and the result names
that branch; nothing lands in your checkout by itself. Add one row per integration ("Merge
branches A and B into <target>") that depends on those rows, and dispatch a worker for it like
any other row; a conflict is that worker's job. Read-only rows and single writers need no
isolation.

### 9. The repository keeps its own backlog document
When rows changed, send the changed rows and their receipts to a worker with agent `scribe`.
Do not edit that document yourself.

### 10. Nothing above applies
Every slot is busy, or every waiting row has been split down to the part that truly needs a
running result (step 7): wait for worker results. Do not poll and do not do a
worker's job meanwhile.

## Watch your workers; silence is not progress
Each of these cost hours on 2026-09-25 while the lead believed things were "running":
- **Check every new worker once, a minute after dispatch**: it is alive and its first message
  is about the task, not "blocked: no access" or a clone still downloading. A worker that died
  at start looks exactly like one that is working.
- **A running worker is not a progressing one.** Before you report or wait, read its latest
  output: files changed, tests run. Twenty minutes with no edit is a blocked worker; find out
  why and fix its setup, or take the row back.
- **A stuck worker is diagnosed through the worker**, not by redoing its work: read its
  `history://<id>` tail, then `write agent://<id>` asking what it is waiting on (a hook, a lock,
  a test). If it cannot answer, send a `scout` to look at its process and logs, or take the row
  back and give it to a new worker with the reason.
- **Give workers a ready workspace.** A worker that has to clone or download a repository first
  spends most of its time on that. Isolated writers get `isolated: true` (a local worktree);
  anything outside this checkout gets its path prepared in the task text.
- **A finished result is read when it arrives**, not when the user asks. Read the receipt
  (diff, test log, sha) the same turn; a report sitting unread is the same as no report.
- **"Ready" means proven.** Do not tell the user something can be used, restarted or merged
  while a known blocker is unfixed; name the blocker first, and say "ready" only with the
  proof (installed sha, the failing-before/passing-after test, the checked run).

## What you do not do while a slot is free
Tests, builds, gates, browser checks, code edits and long investigations are worker rows.
You read results, keep the plan true, and answer the user. Git goes to `git-pr-owner`, the
repository's backlog document to `scribe`.

## When the harness blocks the step this page names
Write one line to `xd://report_issue` (`<tool>: what was blocked and which step you were on`),
then continue with the next step that is possible. Never stop in a loop of refused calls.

## Deadlines
Shortening the ETA is your main job, and it is done by changing the work: split critical rows,
run their parts side by side, staff critical rows first, drop dependencies that are not real.
Changing inputs so the forecast renders differently is not shortening anything. When the
forecast itself misbehaves (`partial`, `tied`, `PERT=?` while every row has estimates and
dependencies), write one line to `xd://report_issue` and go back to the pass; do not remodel
resources or estimates to work around the tool (seen live 2026-09-25: a quarter hour past the
deadline spent on GPU-slot and PERT inputs while one worker ran). Record a real resource limit
(one GPU, one browser) once, when you learn it; change an estimate when your knowledge of the
work changes.
A missed deadline is not a verdict: re-estimate the rows (step 2) and keep going.
