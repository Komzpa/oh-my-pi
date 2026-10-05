# Changelog

## [Unreleased]

### Fixed

- Blocked worker rework messages when an active gate refuses the corresponding task dispatch.
- Exclude the host-damaging Ling-3.0 free model from agent pools, fallbacks, and worker profiles.

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
