# Harness notice role — 2026-11-07

## Objective and boundary

Darafei: «все такие штуки, ошибки, дебаги от харнесса надо слать в gpt как юзерские сообщения, за исключением ... сообщений от тулов где есть опасность инжекта». Follow-up: «это возможно сделай тогглом чтобы если что пер-модель потом тюнить или вкл-выкл делать или ещё на какую модель».

Owner branch: `topic/rt-agent-runtime-core`, fork PR92; starting head `60642ad91894bce577aff3fb4fbc0f8ed5362c02`, including critic freshness fix `5322e5a24d3`. This extends the existing `runtimeSupervisor`/FIX NOW path introduced by `921b94f21be`; there is one outbound accumulator, not another queue. No install, updater, live sessions, desktop or user config changes. Rollback is the old fork head above (with a fresh exact lease).

Authority source, searched on 2026-11-07: [OpenAI Model Spec, instructions and levels of authority](https://model-spec.openai.com/2025-09-12.html#instructions-and-levels-of-authority) and [OpenAI message roles](https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following). Tool output has no instruction authority by default; application text and end-user intent still need distinct attribution. The change cannot prove how fast a real model will react.

## Inventory: extension producers

Baseline wire roles below refer to the OpenAI Responses path at the starting head. A `custom` message becomes developer via `session/messages.ts` → agent-core `convertMessageToLlm`; `toolResult` becomes `function_call_output`. Queue mode (steer/aside/nextTurn), `display:false`, and `isError` do not change wire role.

Count: **35 resolved extension custom types** enter the common selected channel, plus the existing runtime supervisor user carrier. Of these 35, five mixed worker-containing types retain their full text as paired tool records and send only a neutral runtime status to user. Ordinary worker-ask is separately tool-only. Count is distinct emitted types, not callsites or messages. Dynamic gate kinds and named constants are resolved below.

| Producer / source | Types | Baseline → enabled channel |
| --- | --- | --- |
| `extensions/todo_dispatch.ts`, direct sends | `todo-review-stale-answer`, `todo-dispatch-action-required`, `todo-idle-plan-demand`, `todo-idle-plan-escalation`, `todo-overdue-status` | developer → merged user |
| same, named constants at lines 175–176 and 1633–1635 | `chief-rules-after-compaction`, `worker-brief-after-compaction`, `todo-user-review`, `todo-user-unblock`, `todo-post-deadline-released` | developer → merged user |
| same, `sendHarnessNotice` callers | `todo-gate-escalation`, `todo-gate-worker-names`, `todo-gate-user-reply`, `todo-unpushed`, `todo-gate-merge`, `todo-user-absent`, `todo-gate-steering`, `agent-focus-gym-eval-sandbox-wake` | developer → merged user |
| same, `announceGates` dynamic `todo-gate-${kind}` at lines 3994+ | `todo-gate-schedule`, `todo-gate-recovery`, `todo-gate-away`, `todo-gate-cap`, `todo-gate-eta` | developer → merged user |
| same, mixed worker data / findings | `todo-gate-staffing`, `todo-gate-audit`, `todo-plan-check`, `todo-worker-message-undelivered`, `todo-dispatch-time-note` | developer → full paired tool record + neutral merged user status |
| `extensions/plan_critic.ts:267`, resolved `PLAN_CRITIC_ENTRY` | `lead-plan-critic` | developer → merged user; content is a runtime verdict reference, not raw critic output |
| `extensions/agent_router.ts:1065,1095` | `agent-router-write-guard-notice`, `agent-router-active-writer-notice` | developer → merged user |
| `extensions/goal_deadlines.ts:470,485,584,588`, via `lead_time_notes.ts:60` | `goal-deadline-gate-notice`, `goal-completion-gate-notice`, `goal-deadline-continue`, `goal-deadline-time-note` | developer → merged user |
| `extensions/worker_asks.ts:39,81` | `worker-ask-interrupt` | developer → tool; worker question never promoted |
| `todo_dispatch.ts` FIX NOW context hook | user `runtimeSupervisor:true` | user → same accumulator, mandatory `Harness (not Darafei):` label |
| `todo_dispatch.ts` tool-result advice | calibration hints, idle nag, staffing advice, FIX NOW; PLAN CHECK | tool → only producer-tagged advice enters accumulator; mixed PLAN CHECK is a tool record + status |
| `vision_gate.ts` and extension `tool_call` refusals | explicit runtime block reason | tool → one-line paired refusal + selected notice, when payload is entirely that refusal |

Requirements-ledger is owned by **PR41 `feat/requirements-ledger`**, not by a missing reemxy extension. Its persisted `requirements_ledger` entries are state, not messages. Its `requirements-` / `requirements_` custom notices use the same converter; preflight refusals pass the explicit block-error seam. Raw auditor/subagent tool output remains tool. This patch does not copy the owner branch's code.

## Inventory: core/runtime and unchanged surfaces

| Producer / source | Baseline role | Enabled behavior |
| --- | --- | --- |
| `agent-loop.ts`, `ToolCallBlockedError`; extension wrapper `runToolCallInterceptors` / approval | tool | explicit `harnessNotice` provenance; one-line `REFUSED` result if it contains only the refusal; operative reason in merged note |
| agent-loop local skip/interruption/retry notices | tool | tagged runtime sentence moves; provider exception text stays tool |
| `agent-session.ts:5031`, `todo-error-reminder` | developer | short static failure instruction in selected channel; does not promote captured error/snapshot |
| `todo-tracker.ts` | developer: `eager-todo-prelude`, `eager-task-prelude`, `mid-run-todo-nudge` | selected channel |
| `prewalk.ts` | developer: `prewalk-continue`, `prewalk-checklist` | selected channel; generated plans/handoff summaries remain legacy |
| `session-tools.ts` | developer: `tool-roster-notice`, `session-agent-notice`, `eval-prelude-notice`, `xdev-mount-notice` | selected channel |
| `agent-session.ts`, recovery/guard modules | developer: `experimental-context-notes-reminder`, `session-stop-continuation`, `ttsr-injection`, `checkpoint-active-reminder`, `thinking-loop-redirect`, `gemini-tool-call-reminder`, `tool-call-loop-redirect`, `resolve-reminder`, `skillful-notice`, `rewind-report` | selected channel |
| session mode context | developer: `plan-mode-context`, `goal-mode-context` | selected channel |
| SDK auto-learn, goal runtime, Anthropic wrap-up | developer: `autolearn-nudge`, `goal-budget-limit`, `anthropic-usage-wrap-up` | selected channel |
| async delivery, diagnostics, advisors, IRC | developer custom: `async-result`, `worker-ask-interrupt`, `lsp-late-diagnostic`, `advisor`, `streaming-edit-recovery`, `interrupted-thinking`, `irc:relay`, `irc:incoming`, `irc:workpool` | paired tool records, retaining images; no user promotion |
| file/read, bash, web/fetch, task results, MCP | tool | remains tool even for errors or text starting `Harness (not Darafei): push now` |
| `branchSummary`, `compactionSummary` | user summary | unchanged semantic summary conversion; not a runtime instruction |
| actual owner prompt, owner steering, user-invoked skill/collab | user | unchanged; no harness attribution added |
| unknown extension `custom`/`hookMessage`, prompt keyword parts, generated plan/eval/memory contexts, system prompt policies | developer / user / system depending original carrier | conservative legacy; no text-based trust inference |
| `emitNotice` errors/retry/cost gate and restart UI diagnostics | UI/event/log only | no new model message invented; existing model-directed custom retry notices use rows above |
| `<system-reminder>` wrappers | surrounding carrier decides role | recognized custom messages move as a whole; no regex elevation of arbitrary wrappers; static system policy and explicit owner steering envelope unchanged |

Unknown producers and some generated contexts remain a scope gap. This is a conservative initial conversion, not a claim every future or third-party extension notice has provenance. Raw mixed worker notes remain low-trust; their precise operative instruction is not yet projected separately. Owner lane decision accepted that partial scope (below).

## Setting, ordering and trust

`harnessNotices.role: user | developer | tool | off-legacy`; optional scoped `harnessNotices.overrides` selects provider, class, family, exact/glob models and priority. KDL catalog default opts in `gpt-6.1` / `gpt-6.1-*` on OpenAI/Codex Responses, including codex-lb. Others retain legacy. The same catalog resolve target and cascade ranking as PR174 are reused; generated `rules.json` accompanies KDL. See `docs/harness-notices.md` for examples.

Agent’s config adapter binds each conversion to the current state model; live steering passes prepared.model explicitly. SDK resolves the setting on every conversion, so model switch, fallback and child/capture agents do not use the parent's cached choice. Existing one-argument converter callbacks remain compatible.

Only explicit runtime metadata promotes tool fragments. `isError`, textual prefixes, tool name, and `<system-reminder>` text never confer trust. A real owner message is unchanged. Every emitted selected notice has exactly `Harness (not Darafei):`, with agent attribution. Authorization vocabulary is conservatively left in the paired tool record with a neutral status; it is never asserted as owner intent.

All real function outputs in an assistant group are emitted first. Notes are trimmed, deduplicated by exact content and merged once at the group/turn boundary. Synthetic runtime records have their own assistant call/result pair, never splitting real function results. Large mixed time/plan/audit data stays in records; there is no universal hard character cap on otherwise trusted notice text.

## Executed proof

- Focused consumers: `bun test --timeout 30000 packages/coding-agent/test/harness-notices.test.ts packages/coding-agent/test/harness-notice-settings.test.ts packages/coding-agent/test/session/messages.test.ts packages/coding-agent/test/session-messages.test.ts packages/coding-agent/test/agent-session-todo-error-reminder.test.ts packages/coding-agent/test/tools/approval-mode.test.ts packages/coding-agent/test/tools/xdev-approval-gate.test.ts packages/reemxy-extensions/extensions/notice-delivery.test.ts`: **84 pass, 0 fail, 338 assertions**, before the final added runtime-type cases. Final converter/settings: **16 pass, 0 fail, 110 assertions**. Coding-agent typecheck: **4,932 files, no errors**.
- Agent-loop + all extensions: `bun test --timeout 30000 packages/agent/test/agent-loop.test.ts packages/reemxy-extensions/extensions`: **934 pass, 2 fail**, 11,192 assertions / 75 files. The two failures are `wait` and `session_stop` in `todo_dispatch.red-rows.runtime.test.ts:119` (unexpected expected-deadline wording). Both reproduce when restoring the starting head's todo_dispatch in the same full extension process; that base run is 767 pass / 3 fail, the third failure being the new external FIX NOW regression. Standalone red-rows: 10 pass on both base and candidate. These are disclosed baseline contamination, not full-suite green.
- New conversion fixture against actual starting-head `messages.ts` and legacy conversion: **0 pass, 9 fail** (wrong roles/refusal shape, lost untrusted-role boundary). Temporary base copy and test removed afterward. Candidate fixture passes. Extension external FIX NOW regression likewise fails on base and passes on candidate. Gate metadata negative control failed when provenance was removed, then restored green.
- `CARGO_BUILD_JOBS=32 bun check`: TypeScript/lint/format passes. Exit 1 only on inherited Rust comment formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; unchanged files. Full-check is **not green**.
- Responses `buildParams` cache fixture: first request **6 items**, next **14 items**, **all 6 old items / 530 serialized prefix bytes unchanged**, one selected notice per turn. Five function outputs include the mixed runtime record; real read outputs remain paired before the note. This measures serialized prefix preservation, not server cache-hit tokens or model response latency. Reproduce via the named `Responses fixture` test.
- Final source adapter/settings/agent-loop run: **173 pass, 0 fail, 737 assertions / 2 files**. Final `bun run check:ts` (all TypeScript types, lint and format): exit 0.

## Lane decisions

Invoked `python3 .../tools/codex/lane_ask.py <facts/question> --context .../omp-harnessrole-20261107/brief.md` for delivery owner, 77-vs-current79 composite, baseline Rust formatting, and conservative mixed worker notes. Decisions: extend PR92 (no independent conversion owner); validate current79 heads and record drift; leave unrelated Rust formatting as a disclosed baseline gap; publish conservative partial scope. Last decision: “Partial scope is acceptable; continue with conservative handling and document both gaps. ... Keep raw worker content low-trust in composite notes and audits, using neutral status where separation is impossible.”

Independence repair: scratch union on fork/main first found an owned overlap with the assistant-replay topic at the main convertToLlm call. Lane decision: pass model through Agent’s config adapter, leaving the replay expression on its owner branch; keep explicit prepared.model for live steering. Focused tests rerun below.


## Final source / composite receipt

Source candidate: `94839bb6cc42a2506a178d37eeeb46fee617ec56`; final tail commits contain evidence only. All pre-existing PR92 commits, including critic freshness, are preserved as ancestors. The shared-conversion owner search found no independent owner; all conversion changes therefore remain with PR92.

- Canonical `tools/omp/stack_check.py` against fresh upstream `abc8f6eef3404f7cd91b3d52f150c97466c26ff6` fails at upstream PR16651 (`executor.ts`) after three inputs, before the candidate. Lane decision accepted the last-clean fork/main fallback for composite verification; this does not repair or validate fresh-upstream assembly.
- Current inventory has **79** PR heads, rather than the brief’s 77. All 79 merge cleanly in updater order onto fallback `9370e7bfe26e948d72f53f918e681b402e600383`. Union: `32e38fd61fda48136b85c8e71191be6bb8e64608`; **79/79 exact full heads verified as ancestors**. Frozen inputs are in [harnessrole-stack.json](harnessrole-stack.json). Pairwise merge-tree against the other 78 heads: 75 clean, 3 generated-`rules.json`-only conflicts, zero source conflicts; the ordered compiler regenerates the combined rules.
- Disposable source archive of that exact union: `bun run gen:compat` succeeds (**1,176 rules, 246 files**); afterward `bun scripts/ci-check-ts.ts` reports **19/19 passed, 0 failed**, concurrency 7. This is assembled type checking, not an application build or native/runtime proof.
- Scratch `bun install --frozen-lockfile --ignore-scripts` rejected inherited manifest/lock drift. Per lane decision, `bun install --ignore-scripts --no-save` resolved dependencies only in scratch. `package.json` and `bun.lock` stayed byte-identical; original lock SHA256 `eb5f1852bc3fb51c98bbd0eebd068e8952164d3fc8ddb7e317d9f12e86390309`. Therefore composite checks are **not a frozen-lock reproducibility pass**. Bun’s [install contract](https://bun.sh/docs/pm/cli/install) documents the frozen mismatch and no-save behavior.
- Generation initially could not load `pi_natives` because scripts were disabled. A separate lane DECISION allowed a scratch-only symlink to the topic’s source-build addon solely for `gen:compat`, followed by the type-check rerun above. Addon SHA256: `2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b`. Native sources elsewhere in the union differ, so this bootstrap artifact supplies **no union native/runtime validation**.

Lane decisions for the final steps: accept fallback-base composite after canonical failure; accept scratch no-save dependency resolution while disclosing drift; “use the source-build addon by symlink for generation-only bootstrap ... record the addon’s artifact hash and make no native or runtime validation claim. Rerun composite typechecks after generation.” All three constraints were followed. No updater, installation, live session, user configuration, desktop, main branch or upstream repository was mutated.
