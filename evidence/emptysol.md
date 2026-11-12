# Empty Sol stop recovery — 2026-11-07

Objective: diagnose the DC lead's reasoning-only stops, rule out lost Responses output, keep demanded work from silently parking, regress base/head, check the 77-PR union and push only the owning fork branch. No installation, live-session action, desktop use or writes under ~/.omp or ~/.config.

## Findings

Stream-read the named 2.7 GB DC journal, one JSONL record at a time. `emptysol-journal.json` retains counts and selected decoded wire-item shapes, excluding encrypted reasoning. Empty means assistant `stop` without non-whitespace text, tool call or image; denominator is all persisted assistant records of the named model in that UTC hour. These are journal records, not independent user requests or raw provider attempts. The growing journal was sampled during this lane on Nov 7; 16h is partial.

- Opus: 10h 44/2, 11h 53/2, 13h 53/3 total/empty. The supplied 10h denominator 16 does not match this journal snapshot.
- Sol: 14h 75/39 (52%), 15h 75/30 (40%), partial 16h 25/5 (20%).
- 15:02:00–15:03:40: only reasoning wire items, output 19–77 and reasoning 13–71 tokens. Summaries include “Waiting for queued work”, “Still queued”, “Restart remains queued”. The six-token difference is not evidence of missing visible text.
- 16:06:19: wire message has `phase: final_answer` and explicitly empty `output_text.text`. 16:09:09: only a reasoning wire item. These are persisted `providerPayload.items` from the adapter, not an independent raw transport capture.
- Preceding dispatcher notices contain ready/needs-worker rows, an escalated demand ignored 18 times, “Do not narrate unchanged status”, and instructions to stop silently if every row says WAIT. Sol's summaries describe waiting despite those demands. `emptysol-context.json` records selected notices/metadata. This is association, not proof that wording alone caused the behavior.
- Opus also silently stops: two 10h samples explicitly reason that all rows are WAIT; a later sample chooses silence. It does so much less frequently in these hours. No identical-input paired provider experiment was run; inputs and live work differ.

The supplied process log has no full raw SSE capture for these responses. For this session it records `unexpected-stop-handled` at 14:44 UTC, then at 15:17 UTC an empty-stop retry scheduled and immediately skipped with `session-unavailable`. It does not provide the maintenance route for the exact 16:06/16:09 samples. Deployed lifecycle is therefore not proven fixed by this source patch.

## Parser exclusion and owner

Read the standard `openai-responses.ts` adapter and `openai-shared.ts` event handling. It delegates item processing, preserves message text independently of phase, consumes text deltas/done snapshots, function/custom/computer calls, and recovers completed message/function items even without added events. Terminal transport failure is distinct from an ordinary stop. No parser change was justified by the retained wire items.

`openai-responses-empty-stop-shape.test.ts` runs reconstructed SSE through the actual HTTP adapter: commentary, analysis and final_answer messages plus function calls survive `output_item.done` even if terminal output is empty; reasoning-only plus empty final text remain a stop without invented text. These are reconstructed fixtures, not a claim of raw capture. Existing terminal/retry suites exercise truncated SSE and terminal error mapping.

Known upstream evidence:

- https://github.com/openai/openai-python/issues/2546 reports reasoning-only output with empty output_text (GPT-5-mini, small output limit); it is not proof of a GPT-6.1 defect.
- https://developers.openai.com/api/docs/guides/reasoning documents reasoning token consumption and incomplete results when output budgets are exhausted. Our sampled stops are `stop`, not `length`, with tiny usage; token exhaustion is not established here.
- https://github.com/openai/openai-agents-python/issues/4510 describes loss of finish-reason distinction on zero-visible-token truncation; this adapter's terminal suite preserves that distinction.

Current source had a separately reproducible bypass: `refreshAssistantVisibility()` unconditionally accepted empty stops for `silentAssistantTurn`. Dispatcher `prepareWake()` emits `silentAssistant: !realUpdate` even alongside a nonempty `actionDemand`. Thus a quiet action demand could bypass the existing bounded recovery and warning. This is the narrow repair in #92, not a claim it explains every historical turn (the sampled old notices lack these metadata fields).

Fix: on a silent wake with nonempty structured `actionDemand`, do not accept an empty terminal stop. Existing recovery injects its static continuation prompt, retries at most three times, then emits a visible failed `auto_retry_end`. Idle silent wakes without a demand retain their intended acceptance. Explicit silent APIs, parser, model routing, signed-thinking handling, dispatcher wording and successful yield semantics stay unchanged.

`emptysol-owner-decision.txt` approves #92 and rejects the initial signed-thinking hypothesis after corrected evidence. `emptysol-scope-decision.txt` explicitly approves scoped delivery with the historical limitation. The initial decision is retained in `emptysol-decision.txt` as superseded. local-source-patches skill was absent from searched skill roots; the decision approves the user's explicit branch/lease route. `but commit` refused linked worktrees; used its documented worktree-local git exception.

## Verification

- Base `772058df75734f40bd6d550a3f303ebb455f45fd`: new session regressions fail twice (no demanded tool execution; no retry-cap warning). Idle negative control passes. `emptysol-base.log`: 20 pass, 2 fail.
- Head source commit `9194755dbd3`: 111 pass, 0 fail, 347 assertions across six files in one process (`emptysol-combined.log`); includes executed tool-result evidence, bounded warning, idle silence, visibility, yield, parser and truncation controls.
- Touched-file oxlint: exit 0. Standalone all-package type checks: exit 0 (`emptysol-types.log`). `bun check`: TS checks pass; Rust formatting fails in pre-existing `crates/pi-shell/src/bash/trace/viz/runtime.rs` and `runtime_tests.rs`, unchanged by this patch. No unrelated formatting edits.
- `bun install --frozen-lockfile` refused a pre-existing catalog/lock mismatch. `bun install --no-save` succeeded without tracked lock changes.
- `emptysol-assemble.py` snapshots the live manifest and fetches 77 explicit fork heads; substitutes the candidate for #92, merges in manifest order using merge-tree/commit-tree and verifies all 77 ancestors. No canonical branch is changed. Candidate 9194755dbd3, union f6ace49c953: all package type checks exit 0 in detached throwaway `../emptysol-full`. Full hashes, order, manifest hash and ancestry receipts in `emptysol-heads.json`, `emptysol-manifest.json`, `emptysol-merges.json`; types in `emptysol-composite-types.log`. Only documentation/changelog/evidence added after that code snapshot.

## Publication

Exact target: Komzpa/oh-my-pi #92, `topic/rt-agent-runtime-core`. Old remote head/rollback target: `772058df75734f40bd6d550a3f303ebb455f45fd`. No other lane owns it: active service listing showed only omp-emptysol plus unrelated worker scopes. Push must use the user's exact lease. No can1357 or fork main mutation, PR comment, install or updater.
