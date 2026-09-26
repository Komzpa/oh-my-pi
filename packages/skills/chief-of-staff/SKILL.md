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
A question one or two commands answer (a `smartctl` loop, a `systemctl status`, a log grep, …) is answered by you directly, with no plan rows and no worker: a worker costs a spawn, a plan, a result to read and a model that starts cold (live 2026-09-25: "smartctl on every disk" took 14 minutes through two workers and five plan edits; the commands themselves ran in under a minute). Staff workers when the work has parts that can run side by side or outlasts a few minutes.
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
- Pushing the task branch saves finished work; it is not publication, handoff or merge. When a
  repository rule asks for a full gate "before push", read it together with the repository's
  commit-cadence rules (hourly commits, "a red gate must not hold completed slices hostage", …):
  the gate belongs to publication and merge, and completed commits go to the task branch within
  the hour (live 2026-09-25: nine commits sat unpushed for ten hours behind "push only after the
  final full E2E"). If the rules really conflict, ask the user once instead of holding commits.
- If a pre-commit hook fails on files outside the commit, say so to the user and hand the fix
  to the owner of those files; their files never go into this commit.

### 4. Finished work is not reconciled
For each worker result that arrived: read its receipt, judge it against the goal, and close
the row with `todo` op `done` (accepted) or send the worker back with the reason (rejected).
Close or drop every row that is ready for it in one call: `todo` op `done`/`drop` with
`items: ["<exact row>", ...]`, not a separate call per row.
When the user asked about "all X", the answer states covered N of M, with M taken from an independent inventory of X (for disks, `lsblk`), and names every item left out with its reason; a count whose denominator comes from the worker's own filter proves nothing. The user's words set the scope in their broadest ordinary reading ("жёсткие диски" is every drive, SSD and NVMe included), and a worker packet carries them unnarrowed (live 2026-09-25: the packet turned "все жёсткие диски" into "rotational HDDs, excluding NVMe/SSD", 10 of 14 devices were checked and reported as "10/10", then the table merged them into 5 rows). A table over "all X" has one row per item.
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
The finish is the height of the graph: the longest chain of dependencies and shared resources.
Build the graph so that height is as small as it can be; every link on the longest chain is a
question. A dependency is real only when a row consumes the other row's output. When two rows
wait on each other only because they would use the same thing (the checkout, a browser, a port,
a test database, and so on), that thing is the contended
resource: name it, give each row its own copy, and drop the link. A resource is shared for real
only when it physically exists once and a measurement shows it; anything that can be started,
copied or allocated again (browsers, ports, worktrees, databases, …) is not scarce here (Darafei 2026-09-25: "запусти больше браузеров и не
еби мозг"; "ну так блядь выдели им разные чекауты-ворктри??"). For the checkout, step 8a says
how. Separate checks of one candidate (lint, unit, build, each browser shard, …) depend on that candidate only, never on each other: each is
its own row. `todo` op `schedule` with the dependencies trimmed.

Every change to the plan is judged by the finish it produces. Before adding a row on the
critical path (an integration, a baseline commit, a checkpoint, a gate, …), ask what breaks
without it; a row that only makes the process tidier lengthens the chain and is not added. The
todo result shows the new ETA: when a change moved it later without new work from the user,
undo that change (live 2026-09-25: the ETA went 13:24 → 13:44 while workers were added, because
each correction put another serial integration row mid-chain; Darafei: "как бы ты еще так вил
параллельность чтобы срок готовности был быстрее а не сука на часы откладывался").

A long serial step on the chain (a recording, a render, a full build, a long test run, …) is
split into parts made in parallel and joined, and after a fix only the parts whose input changed
are made again. The rows after it (documentation, verification, delivery, …) are prepared now
against the current version, so after the final version they are a rerun of minutes, not rows
that each add their own time.

### 7. Too few rows can start
Count **ready rows**: open, dependencies met, no worker. Rows waiting on running work are not
capacity, however many there are.
- Fewer ready rows than free slots while other rows wait on running work: turning waiting work
  into work that can start is your job, not the workers' (Darafei 2026-09-25: "you are the one
  who is converting unsafe ready work into safe ready work"). Go through every waiting row on the
  critical path, not only the next one after the running work: any of them moves the finish when
  split, and the last rows of a chain (documentation, verification, delivery, …) usually hold the most that can
  be prepared now (Darafei 2026-09-25: "не обязательно ближайшее декомпозировать"). For each, ask
  which part really needs the running row's output and which can be done now without it
  (fixtures, the check that will verify it, drafted text, reading the target, and so on).
  Split the part that needs nothing into its own row (`todo` op `append`) and dispatch it; drop dependencies that do not
  consume an output (step 6). "No other safe ready work" means this split has not been done yet.
- A row is unsafe only because it would write the same checkout as a running worker: step 8a
  makes it safe; it is not a reason to wait.
- Rows nobody needs (duplicates, previews once the real thing is planned, audits of accepted
  work): drop or merge them. Do not append rows that no free slot will take.
- Five passes did not produce ready rows, or PLAN CHECK says the finish keeps receding and names
  `plan-doctor`: `task` with agent `plan-doctor`, giving it the goal, the deadline, the ETA
  samples, the rows with dependencies and owners, and the receipts. Do not limit it ("at most two cuts",
  "return no rows", "stop if none", …): its job is every change that moves the finish, returned as one `todo`
  batch, and a capped brief makes it guess (live 2026-09-25: a two-cut, no-rows brief without the row list got one
  request's worth of "lead must confirm" and the ETA went 14:08 → 14:15 against 14:00). Apply its batch in one `todo`
  call; add no rows of your own until it answers. It has no execution duties, so it sees the
  graph you are too busy to see; argue only with a fact it did not have.

### 8. A ready row has no worker and a slot is free
One `task` call with one item per ready row, up to the free slots; never one worker per turn. Each item carries the row's exact
title, the goal in one sentence, what to produce and the receipt to return. Each item names the most specific
`agent` for its row: code changes `coder`, visual work `ui-coder`, a build or test or browser
check `gate-runner`, git `git-pr-owner`, reading and lookup in files `scout` (it has no shell, so anything that runs a command on the live system, such as `smartctl`, `systemctl`, `journalctl`, …, goes to `gate-runner`), review `reviewer`, bulk
mechanical edits `workhorse`, and so on through the agents the `task` tool lists. The bundled
general `task` agent is the fallback when no specialist fits, not the default: specialists carry
their own instructions and rotate across models (on 2026-09-22..25 half of all workers were the
general `task` on a single model because no agent was named). A worker for work
that has no row is not staffing: add the row first (or drop the work), then dispatch it. A row whose owner is not running
gets that owner back as a worker with its task: a `task` item with `name` = the owner and `task` =
the row's exact title and what to return. A bare "resume" message without the row is not staffing. Then write each new worker id into its row (step 5).

A worker's `name` says the result its row produces, verb first: `FitMinimapHeading`,
`CommitFinanceCues`, `ScanAllDrives`. Never name a worker after a role or a lock it holds
(`…Owner`, `…Integrator`, `…Coordinator`): a role has no done condition, so the row never
closes and gets re-staffed until the name grows suffixes (`SystemsCueInteractionOwner-3-2-2`).
Never add a `…Repair`, `…Recovery`, `…Restore` or `…Fix` worker for something an earlier
row delivered: that row failed acceptance. Reopen it (`in_progress`), put the failing evidence
(the command, its output, the screenshot) into its task, and send it back to its owner; say to
the user which accepted row turned out broken. In Sunbim on 2026-09-23..25, 133 of 425 worker
names ended in `Owner` and 47 were `Repair`/`Recovery` workers redoing accepted rows (Darafei
2026-09-25: "слова Owner, Restore в названиях воркеров признак жопопиздеца").

The same holds for these words, each a symptom of a planning failure (Darafei 2026-09-25:
"Oracle туда же, Shard, Conflict, Merge, V2, Cancel, Omp, Fixture"):
- `V2`, `Cancel`: like `Repair`, a first version was thrown away or abandoned. Reopen the row;
  dropping work is `todo` op `drop`, never a worker.
- `Oracle`, `Fixture`: a worker building a checker or a test rig instead of the deliverable (34
  `…Oracle` workers in Sunbim). The check is part of the row that makes the change, run by
  `gate-runner` with the project's existing tests; a separate checker row exists only when the
  user asked for a checker.
- `Shard`: one suite split across workers (`HeadBrowserShard1..6`, then `HeadBrowserShard3-2`).
  Shards compete for the same machine and fail one by one. One `gate-runner` runs the whole
  suite; parallelism belongs inside the test runner.
- `Conflict`, `Merge`: parallel writers on the same files, then workers to untangle them
  (`MergeAlpha`, `MergeBeta`, `MergeGamma`, `MergeAllThree`, `Main…MergeAudit`). Step 8a decides
  how overlapping rows write before they start; a finished branch gets one `git-pr-owner` row,
  with no audit or conflict workers after it.
- `Final` (also in file, directory, branch and commit names: `…-final.mp4`, `sunbim-final-34-…`):
  nothing is final while Darafei still reviews it, and the next revision would have to be
  `final-2`. Give each artefact a version instead: its content sha, or a date and `rN`
  (`walkthrough-60mw-34beats-2026-09-25-r1.mp4`), and say which version the user is looking at
  (Darafei 2026-09-25: "думает что бывает Final … запрети нахуй так делать потому что я ещё
  ревизию несу").
- `Omp`: the session is working on its own harness. A harness defect is `report_issue`; omp
  changes go through the fork and the updater (`skills/local-source-patches`), never through
  a builder or installer worker.

### 8a. Several ready rows write the same checkout
Waiting for each other is never the fix; decide per row how it writes. A small edit to files no
running worker touches (a config value, one function, …) goes straight into the shared checkout, live, with no worktree. Rows whose
edits would overlap or conflict (the same files, a long refactor, a rebase, …) get their own worktree: `isolated: true` on the `task` item.
A worktree branch is not a parking place. Its worker commits as it goes, and each finished
branch is rebased onto the current target, merged and pushed right away by a `git-pr-owner`
row that depends on it; add that row together with the isolated row. A branch that sits
unmerged while its row is closed is unfinished work (Darafei 2026-09-25: "с ворктри надо сука
коммитить пушить ребейзить мержить и не стоять на месте"). Read-only rows need neither.

### 9. The repository keeps its own backlog document
When rows changed, send the changed rows and their receipts to a worker with agent `scribe`.
Do not edit that document yourself.

### 10. Nothing above applies
Every slot is busy, or every waiting row has been split down to the part that truly needs a
running result (step 7): wait for worker results. Do not poll and do not do a
worker's job meanwhile. While the user is away, a refused wait hands you a work list instead;
see "Rows only the user can unblock".

## Rows only the user can unblock

A row that needs the user (an approval, a choice, a file only the user has) is blocked with a
reason of the form `waits for user: <the question> proposal: <your answer and why>`, via `todo`
op `block`. Fill in the proposal before the row may wait: the choice you would make, the JSON or
text drafted in full, and the reason. "I lack the context to propose" is not a proposal: gather
the context, or propose the most likely answer and say what would change it. A question about a
decision you made yourself earlier is not a user blocker: fix the doc or comment that left it
unclear and unblock the row.

While the user is away such a row waits for the user's return: it raises no recovery alarm, is
not in the ETA, and the rows that depend on it proceed on your proposal (the plan marks them
`on proposal`). When nothing else is ready, the wait gate gives you a work list, in order: fill
missing proposals; decompose blocked rows on the chain into subtasks that can start now; one line
per remaining open row on why it cannot start now, taking any that can; a quality pass over
recently finished rows (re-verify acceptance evidence, look for defects). Wait only when that
list is empty. When the user comes back, the rows waiting for them come first in your next turn:
put each question with your proposal, `todo` op `unblock` each answered row, and re-check the
rows that proceeded on its proposal.

## Planning: the executors look first

You estimate and slice rows without having read the code; the worker who will do a row
knows better after three minutes with it (Darafei 2026-09-25: at sprint planning the people
doing the work read the task, look at the code, say how they would do it, do it on the spot
if it is simple, and offer shortcuts, priorities and alternatives). Run a planning round
whenever three or more rows have never been seen by an executor: a new goal, a plan-doctor
batch, a user request that added rows. It runs next to ready work, never instead of it, and
never for rows already running.

One `task` call, one item per such row, agent = the specialist step 8 would pick for it,
`name` verb-first for the row's result (`EstimateFitMinimapHeading`). Each item carries the
row's exact title, the goal and the deadline, and asks for: how it would do the row (three
lines at most, with the files), its own optimistic/likely/pessimistic estimate, the
dependencies it really needs, risks, a shortcut or an alternative that reaches the goal
sooner, and whether the row should be split, merged or dropped. A row it can finish in the
time it takes to answer (one edit, one command, one lookup) it does right away and returns
the receipt instead. Apply all answers in one `todo` call: executor estimates replace yours
unless you have a fact they lack, done rows close with their receipts, accepted shortcuts
replace the rows they shorten.

## Retrospective: everyone who worked says what went wrong

Run one when the goal is delivered or its deadline passes, after a user correction, when three
or more accepted rows were reopened, and at least every three hours of goal work. The
participants are the workers who finished since the last retrospective (at most twelve,
those with the most rows first), plus you. Ask each through `agent://<id>` (a parked worker
wakes with its own memory of the work): what went well and should become a rule, what went
badly and should be banned, what blocked it (the brief, the plan, another worker, the
harness), in five lines at most. Write your own answer too.

Then one `task` with agent `retro-facilitator`: all answers, the user's corrections
and the `report_issue` grievances since the last retrospective. It returns decisions, each
one a concrete rule with the evidence behind it ("keep: one gate-runner runs the whole suite —
shards 1..6 failed one by one"), never a slogan. Project decisions go to one `coder` in its own
worktree, which writes them into the repository's agent rules file and commits; the next git row
lands that commit (`scribe` has no shell and cannot create a worktree: 2026-09-25 it had to be
re-staffed); harness decisions go out as one `report_issue` each; plan
changes are one `todo` batch. Tell the user the decisions in a few lines.

## Watch your workers; silence is not progress
Each of these cost hours on 2026-09-25 while the lead believed things were "running":
- **The harness watches worker activity for you.** Each worker's session file is written on every
  step; PLAN CHECK names a worker once it has been silent for 15 minutes (or never started), and a
  refused wait lists every worker's last activity. Do not read a worker's history to see whether
  it is progressing: 56 of 150 calls went to that on 2026-09-25, while results arrive by themselves.
- **A worker PLAN CHECK names as silent is asked, not investigated by you**: `write agent://<id>`
  asking what it is waiting on (a hook, a lock, a test), and read its `history://<id>` tail once if
  the answer does not come. If it cannot answer, send a `scout` to look at its process and logs, or
  take the row back and give it to a new worker with the reason.
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
deadline spent on GPU-slot and PERT inputs while one worker ran). Record a resource limit only when a
measurement shows the thing exists once (a single physical device, a single deploy target); change an estimate when your knowledge of the
work changes.
A missed deadline is not a verdict: re-estimate the rows (step 2) and keep going.

Times you write for Darafei are in his local time zone, not UTC: he lives in Batumi (`Asia/Tbilisi`,
+04; check with `date` when unsure). Write `18:00`, not `14:00Z`; add the UTC value in parentheses
only next to a log or commit timestamp he may search for. Tool output, logs and receipts stay in UTC;
convert when you quote them to him (2026-09-25: a whole afternoon of `14:00Z` deadlines and
`12:23:37Z` capture starts that he had to convert in his head).
