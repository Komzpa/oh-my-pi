# Changelog

## [Unreleased]

### Added

- Add the `minor-coder` agent for small, known fixes of about 10 minutes or less (pool: Luna low, Mercury-3 low, Haiku 5.5 low, free dots, Sol low, mimo) and register it in the router pool sizes, write-capable workers, Claude effort cap and the dots role sanction; `coder` becomes the bigger-task role.
- Reorder agent pools by the omp agent x model report: `ui-coder` opens on Sol high then Sonnet 5.5 and drops Luna; `git-pr-owner` opens on Haiku 5.5 low, Sol low, Mercury-3 low and drops Luna; `coder` opens on Sol medium then Muse Spark and drops Luna; these four roles have a pool of two (different providers, shared load), the rest ordered fallbacks. `xiaomi/mimo-v2.6-*` moves to the end of every chain; scout, gate-runner, scribe and workhorse pool sizes drop by one to keep their pool members unchanged.
- Require commit workers to inspect effective Git author/committer identity and provenance, use configured real identities, stop without committing when identity is missing or invalid, preserve genuine contributor authors, and read back commit identities.

- `/brrrr` persisted routing with hot user-wide model classes and blacklist reads, fast-only Luna, Cerebras light-role preference, fail-closed mandatory routing, and Claude implementation effort capped at high.
- Route `anthropic/claude-haiku-5-5` (medium effort, never below: low effort skips searches and tool calls) in scout — replacing `anthropic/claude-haiku-4-5` — and directly after every `codex-lb/gpt-6-luna` entry in coder, gate-runner, git-pr-owner, reviewer, scribe, ui-coder, workhorse, and the `task` pool. The brrrr strong-model set is unchanged.

### Fixed

- Put gate recovery actions first and announce scheduling, staffing, ETA, reestimate, reply, and writer constraints before refusal ([#92](https://github.com/Komzpa/oh-my-pi/pull/92) by [@Komzpa](https://github.com/Komzpa)).

- Main sessions must reply to the latest human message before waiting or ending an empty turn ([#92](https://github.com/Komzpa/oh-my-pi/pull/92) by [@Komzpa](https://github.com/Komzpa)).

- `todo_dispatch`: the idle PLAN CHECK ticker fingerprints the problem list alone (worker telemetry excluded) and dedupes on that fingerprint, so an unchanged problem is delivered once instead of every minute (nine wake-ups in eleven minutes, live 2026-10-21); the receding-finish wording now says the projected finish moved from X to Y and names the current time.
- `todo_dispatch`: re-deliver an unchanged PLAN CHECK problem list once every 30 minutes after its last delivery, so problem kinds without an escalation step (understaffed, no worker) are not said once and then never again; a changed list or an escalation still delivers at once and restarts the 30-minute clock.


- Keep the main event loop responsive during Git integration checks: await Git in context and merge admission, share in-flight probes, and keep the synchronous advice callback free of subprocesses.

- `todo_dispatch`: the planning-failure worker-name refusal tells the chief to name the result its row produces, verb first (e.g. `AdmitChiefBashLooks`), matching the canonical chief-of-staff naming rule, instead of a semantic noun. Role names (`…Owner`, `…Oracle`) and reopen verbs stay refused; compliant result names and existing-owner resumption are unchanged.
- `todo_dispatch`: after compaction the model sees only the newest copy of each of the three custom types when present: chief rules, worker brief, and todo-error reminder. Journals remain append-only; `session_compact` reinjects chief rules in main sessions or the original brief in worker sessions only when canonical compacted context dropped the respective type. Canonical builder errors surface, and retained copies no longer duplicate. The all-three-seeded, five-compaction oracle still requires exactly one copy of each type.
- `todo_dispatch`: open instruction retrospectives for gate rejections, failed TODO updates, and missed ETAs; a completed retro covers unchanged row attempts so predictable workers do not reopen the demand.
- `todo_dispatch`: do not refuse chief work when no ready row can be delegated. Admit read-only monitoring and inspection commands, a leading `cd <dir> &&`, compound read-only pipelines, and recursively checked command substitutions in git branch containment queries; builds, tests, installs, mutations, and output redirections remain worker work.
- `todo_dispatch`: the chief bash gate admits a leading `cd <static dir> &&`, static absolute binaries (`/usr/bin/git`, `/bin/sed`) judged by basename, read-only `gh api` (GET only, no fields or body), `gh pr view|checks|list|diff`, `gh run view|list`, and git `patch-id`, `cat-file`, `rev-list`, `for-each-ref`, `name-rev`, `describe`, `blame`, `shortlog`, `grep`; `gh` writes, `git` mutations and mutating binaries stay refused.
- `todo_dispatch`: the retro incident trigger reads the worker's structured result — a non-zero `install_exit`/`updater_exit`/`deploy_exit`/`exit_code` or non-empty `blocked`/`remaining`/`gaps` on an updater/install-labelled row opens `retrospective due (updater rejection)` even when the job completed — and a lead re-dispatch of one row (Foo → Foo-2 → Foo-3 owners, or the row title re-sent after a completed attempt) opens `repeated failure`. `retro-facilitator` gains a `mechanism` scope: a defect that blocked a deploy or recurred MUST become a code row against the owning script with the failing receipt path and a reproducing test, never a prose rule alone.
- `todo_dispatch`: drop persisted parked children absent from the current process job snapshot after eviction or restart; retain known parked children separately from running jobs and exclude settled children.
- `todo_dispatch`: prune sprint state to live rows before persisting and coalesce a burst of changes into one entry, capping settled children at 32, so long sessions stop growing the branch without bound.
- `todo_dispatch`: an in-progress ready row whose owner just completed is an unread result waiting to be closed, not re-staffed — it leaves `dispatchableReady`, so the wait and chief gates stop demanding a new worker for it (pending rows with a completed owner still reopen; failed or cancelled owners stay dispatchable). Dependency-blocked rows waiting on real outputs are chain, not idle: once every ready row has a running owner they leave the parked/idle count in the chief and replan refusals, while dangling links and unstaffed ready rows keep their pressure.
- `todo_dispatch`: lead chief-of-staff work refusals with the `task` action and list the ready rows by title in the refusal ("Start one with a task call for: ..."), no capacity or row-count number; dependency-waiting rows stay out of the list. Keep unit/job staffing hints and read-only access.
- Record served-model attribution, first-turn model and structured fallback triggers on task and wait outcomes; apply retry cooldown only to a recorded failing source model. Older core results retain an explicit unrecorded reason.
- `todo_dispatch`: an escalated gate admits `context_notes` check-ins while still blocking unrelated calls such as `bash`.
- `todo_dispatch`: an escalated gate also admits `write agent://<id>` check-ins when `<id>` is a currently running task job; idle or parked agents stay refused (R47).
- Demote evidence-backed hard-fail models per role through the existing seed/user blacklist policy. Dots fabrication moves it behind unaffected coder, QA, verification and install candidates; publish (`git-pr-owner`) stays unchanged and free-first.
- `todo_dispatch`: allow read-only shell loops, conditionals, and leading environment assignments in the chief-of-staff bash gate; recursively inspect command substitutions and refuse malformed or unsupported syntax. Restrict `git branch` to known listing forms so branch mutations remain worker work.
- Use the canonical thinking-level enum for the `/brrrr` Claude effort cap; cover hot allow-list edits, child-session inheritance without disturbing the active parent's transcript, and unchanged mode-off routing.
- Blocked worker rework messages when an active gate refuses the corresponding task dispatch.
- Exclude the host-damaging Ling-3.0 free model from agent pools, fallbacks, and worker profiles.
- Keep critical-row fast-lane routing from displacing a free model at the front of the chain.
- Preserve the DeepSeek Flash fallbacks after removing Ling: shrink gate-runner, git-pr-owner, and scribe pools to four entries and leave all-unavailable chains unrouted.

- Cover resumed non-task workers as wait-eligible staffing, plus fresh-owner slip reestimates and the stale-owner refusal control.
- `todo_dispatch`: a `todo schedule` reestimate on a past-ETA running row that carries `evidence` (the failure reason) plus a new `estimate` is accepted under the same owner; a bare reestimate stays refused but the message names the evidence repair instead of demanding a kill (658).
- `todo_dispatch`: a `todo` override naming `todo-plan-doctor`, `todo-replan`, `todo-link`, `unread-receipts` (or `idle-wait`) now clears the refusal it answers: the parser maps it to its demand key, the escalation gate skips suppressed demands, and the wait refusal stands down while `idle-wait` is suppressed (547, 590).
- `todo_dispatch`: PLAN CHECK now intersects forecast, ready, unread-result, and overdue rows with the current TODO statuses, so completed or dropped rows are not reported from stale forecasts.

## Unreleased

- Route the free image-capable OpenRouter model first in coder, git-pr-owner, and ui-coder; raise `POOL_SIZES` coder 6→8, git-pr-owner 3→5, ui-coder 4→5 so every paid pool member stays in the pool. Reviewer, coder-strong, ui-coder-strong, adversary, retro-facilitator, and plan-doctor profiles remain the strong check after free-model work.
- Wait gate counts a resumed live worker (running job under the owner's name, live registry entry) as staffing instead of idle-live-owner, so `wait` is allowed and no second writer is demanded (522, 546). Slip reestimate refusal exempts freshly started owners (<15 min, e.g. crash recovery) whose reestimate replans the remainder rather than slipping the old ETA (658); same-owner estimate-only reschedules on slipping rows stay refused (495, 598, 602).

## Unreleased

### Fixed

- `todo_dispatch`: persist the dispatched retro-facilitator job names in the sprint state and restore them on `load()`, so a restart/reload no longer forgets a completed retrospective. `retrospective due` stops relisting the workers the retro already covered, while a genuinely new worker still opens its own window.
- `todo_dispatch`: record the covered worker cohort and the retro receipt id in `finishRetro`, and pick up background retro completions (async-result branch entries) that never arrive as a task `tool_result` or job-snapshot entry. A completed retro clears the demand once, the covered workers stay excluded from later cohorts across restarts, and a new demand names only workers no earlier retro covered.
- `todo_dispatch`: retrospectives fire on incidents only. Removed the `3h goal work` trigger and the `goal delivered` trigger, so a predictable delivery opens no retro and the workers' Retro blocks accumulate for the next incident-driven one. Immediate retro on: user correction, missed deadline or ETA, updater/deploy rejection or rollback, the same failure twice, a reopened row, an empty or substituted worker result. `retro-facilitator` runs on `codex-lb/gpt-6.1-sol:high`.
