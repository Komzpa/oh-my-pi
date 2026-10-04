# Changelog

## [Unreleased]

### Fixed

- Blocked worker rework messages when an active gate refuses the corresponding task dispatch.

- Cover resumed non-task workers as wait-eligible staffing, plus fresh-owner slip reestimates and the stale-owner refusal control.
- `todo_dispatch`: a `todo` override naming `todo-plan-doctor`, `todo-replan`, `todo-link`, `unread-receipts` (or `idle-wait`) now clears the refusal it answers: the parser maps it to its demand key, the escalation gate skips suppressed demands, and the wait refusal stands down while `idle-wait` is suppressed (547, 590).
## Unreleased

- Route free OpenRouter models first in the coder, git-pr-owner, and ui-coder worker roles: prepend `openrouter/inclusionai/ling-3.0-flash-sante:free` and `openrouter/dots-studio/dots-3-note-preview:free` to the coder and git-pr-owner `model:` chains, and `openrouter/dots-studio/dots-3-note-preview:free` only to ui-coder (it is the free model with image input; ling-3.0-flash-sante is text-only and cannot verify screenshots). Raise `POOL_SIZES` coder 6→8, git-pr-owner 3→5, ui-coder 4→5 so every paid pool member stays in the pool. Reviewer, coder-strong, ui-coder-strong, adversary, retro-facilitator, and plan-doctor profiles are unchanged and remain the strong check after free-model work.
- Wait gate counts a resumed live worker (running job under the owner's name, live registry entry) as staffing instead of idle-live-owner, so `wait` is allowed and no second writer is demanded (522, 546). Slip reestimate refusal exempts freshly started owners (<15 min, e.g. crash recovery) whose reestimate replans the remainder rather than slipping the old ETA (658); same-owner estimate-only reschedules on slipping rows stay refused (495, 598, 602).
## Unreleased

### Fixed

- `todo_dispatch`: persist the dispatched retro-facilitator job names in the sprint state and restore them on `load()`, so a restart/reload no longer forgets a completed retrospective. `retrospective due` stops relisting the workers the retro already covered, while a genuinely new worker still opens its own window.
