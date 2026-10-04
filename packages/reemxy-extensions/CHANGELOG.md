# Changelog

## [Unreleased]

### Fixed

- Blocked worker rework messages when an active gate refuses the corresponding task dispatch.
## Unreleased

- Route free OpenRouter models first in the coder, git-pr-owner, and ui-coder worker roles: prepend `openrouter/inclusionai/ling-3.0-flash-sante:free` and `openrouter/dots-studio/dots-3-note-preview:free` to the coder and git-pr-owner `model:` chains, and `openrouter/dots-studio/dots-3-note-preview:free` only to ui-coder (it is the free model with image input; ling-3.0-flash-sante is text-only and cannot verify screenshots). Raise `POOL_SIZES` coder 6→8, git-pr-owner 3→5, ui-coder 4→5 so every paid pool member stays in the pool. Reviewer, coder-strong, ui-coder-strong, adversary, retro-facilitator, and plan-doctor profiles are unchanged and remain the strong check after free-model work.
