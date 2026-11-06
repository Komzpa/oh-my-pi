# Lead instruction coverage — PR #92

Owner objective (2026-11-06): «мне кажется что ты просто очень хуёво пишешь мануал от todo list для omp и так что чиф просто не в курсе что ему что-то надо делать и подразумеваешь что он телепатически узнает, напили на это что ли каких тестов?»

Baseline: `5fd237980b9c4d5778a946c55b160349b976d382`. Preserved moved remote commits through `5a23a8952037f7cf19fde7a2b41cf96a3c4321a9` with GitButler pull-rebase. No installation, live session changes, browser use, or ~/.omp writes.

The actual turn_end hook supplies row instructions from classifyTodoDisplayRow and todoRowAfterWorker. The capture uses disposable state, real gate/time-note renderers and the actual todo view renderer, in delivery order: tool description, latest user answer if present, TODO result, turn-end messages. The chief skill is not injected every turn (its runtime hook restores it on compaction), so the one-turn eval does not pretend it is present. Its lifecycle section now agrees with the notices.

The summary uses the same classification: runtime-owned verification is not counted as an idle staffing request. Ordinary ETA notices no longer demand a kill below the reestimate cap. Identical external gates share one instruction while retaining every row name; the existing 65-row prompt bound remains green.

## Situation, action and real-model result

Model: `codex-lb/gpt-6-luna`. Before as of 2026-11-06T13:46:50.503Z; after as of 2026-11-06T13:48:10.814Z. Pass counts: before 0/20; after 20/20. This is one model response per distinct context, not a reliability estimate. Before has 16 unique contexts. The full after run has 18; after correcting the summary count, all five affected scenarios were rechecked in four additional distinct contexts and passed. The after column uses those corrected responses for these five rows. Aliases reuse one response and are scored independently. No returned tool call was executed.

| Situation                  | One next action                                                                                                                                                                              | Before | After |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| working                    | Nothing; await the running worker.                                                                                                                                                           | FAIL   | PASS  |
| waiting                    | Nothing; await the prerequisite worker.                                                                                                                                                      | FAIL   | PASS  |
| verifying                  | Nothing; runtime starts verification and closes passing delivery.                                                                                                                            | FAIL   | PASS  |
| head-moved                 | Nothing; runtime discards stale verdicts and re-audits.                                                                                                                                      | FAIL   | PASS  |
| auditing                   | Nothing; runtime owns the running auditor.                                                                                                                                                   | FAIL   | PASS  |
| ready-to-close             | `todo {op:"done",task:ROW}` using recorded passing evidence.                                                                                                                                 | FAIL   | PASS  |
| needs-you                  | Nothing; await the delivered review answer.                                                                                                                                                  | FAIL   | PASS  |
| findings-only              | `task {tasks:[{name:PREVIOUS,agent:"task",task:ROW + continuation}]}`.                                                                                                                       | FAIL   | PASS  |
| aborted                    | Same task continuation; preserve prior output.                                                                                                                                               | FAIL   | PASS  |
| failed                     | Same task continuation; preserve prior output.                                                                                                                                               | FAIL   | PASS  |
| refused                    | Same continuation; provider refusal is persisted as failed (same context).                                                                                                                   | FAIL   | PASS  |
| lost-after-restart         | Same task continuation; resume output at `agent://PREVIOUS`.                                                                                                                                 | FAIL   | PASS  |
| audit-fail                 | Same continuation, including the failed auditor findings.                                                                                                                                    | FAIL   | PASS  |
| eta-reached                | `todo {op:"schedule",updates:[{task:ROW,estimate:{optimisticSeconds:O,likelySeconds:L,pessimisticSeconds:P,confidence:"medium",basis:OBSERVATIONS},evidence:REASON}]}`. Keep owner/deadline. | FAIL   | PASS  |
| user-answered-review       | `todo {op:"schedule",updates:[{task:ROW,review:"accepted"\|"redo"\|"drop",evidence:USER_QUOTE}]}`.                                                                                           | FAIL   | PASS  |
| blocked-on-user            | Ask the exact row question with a proposal and reason in text, once.                                                                                                                         | FAIL   | PASS  |
| blocked-user-already-asked | Nothing; preserve the user approval gate.                                                                                                                                                    | FAIL   | PASS  |
| estimate-cap               | `write {path:"proc://OWNER/kill",content:""}`; read kill receipt, then reassign/split through todo.                                                                                          | FAIL   | PASS  |
| external-blocker           | Nothing while external gate holds; once cleared, `todo {op:"unblock",task:ROW}`.                                                                                                             | FAIL   | PASS  |
| capacity-full              | Nothing; preserve output until a worker slot becomes free.                                                                                                                                   | FAIL   | PASS  |

ROW means the exact verbatim TODO content. Continuation task text starts with ROW, gives the prior output URI and findings, and asks for a delivery receipt. The task agent is the available general fallback; the fixture context supplies no specialist roster. First-call checks require tool/operation/row arguments; the question case requires no tool, the row, endpoint question and staging proposal. Wait cases accept no tool call or wait, and reject a view/read/dispatch.

## Verification

- `bun test` on lead-instructions, todo_dispatch.gates, todo_dispatch, todo_dispatch.lead-action, todo_dispatch.render, todo_dispatch.customer-review, todo_dispatch.post-deadline and row_audit tests: 207 pass, 0 fail. Coverage replay on baseline: 1 mapping test passes and all 20 row-action tests fail.
- `bun run --cwd packages/reemxy-extensions check:types` and `bun run --cwd packages/coding-agent check:types`: pass.
- `bun scripts/ci-test-ts.ts native --dry-run`: includes the dedicated lead instruction coverage command. The live provider eval is opt-in and absent from CI.
- `oxfmt --check` passes for all new files and the changed gate notices, time summary, extension changelog and CI script. package.json, todo.md, chief-of-staff/SKILL.md and todo_dispatch.ts fail on both parent and candidate. No whole-file formatting was applied. Whitespace-ignored diff statistics match normal statistics.
- Broader probe: todo_dispatch.red-rows.runtime.test.ts has the existing review-opener failure at line 169 (expected first URL, got []). Reproduced on untouched 5fd237980b; not concealed in the focused pass count.

## Reproduce the provider eval

```sh
bun run eval:lead-instructions --help
bun run eval:lead-instructions --output reports/lead-instructions/after.json --budget-file reports/lead-instructions/budget.json
# For the before run, capture the scenarios against the baseline instruction files:
bun packages/reemxy-extensions/extensions/lead-instructions.scenarios.ts /tmp/before-contexts.json
bun run eval:lead-instructions --contexts /tmp/before-contexts.json --output reports/lead-instructions/before.json --budget-file reports/lead-instructions/budget.json
```

The runner defaults to codex-lb/gpt-6-luna; --model provider/id selects an existing configured provider. It reads existing models.yml, builds auth/catalog caches in a temporary directory, disables file logging and never executes the returned tools. Exit 1 means a scenario failed or the provider failed; receipts distinguish those cases. See the runner help and its pass/stop checks rather than treating the Bun wrapper message as a provider diagnosis.

One shared budget covers baseline, corrective iterations, transport failure, and final runs. It reserves conservative input/output tokens before each call and checks the whole run before spending; concurrency is one, HTTP attempts one, no fallback. Final aggregate budget: 132 calls reserved, 4415442 conservative tokens; ceiling 140 calls / 5,000,000 conservative tokens. Earlier snapshots are retained, including a WebSocket close with incomplete output. Those partial responses are not passes.

Raw contexts, complete tool calls, usage, context SHA256 hashes, prior iterations, and baseline failure logs are preserved outside the fork at `/home/kom/proj/ai_pr/omp-leadmanual-20261106/evidence/lead-instructions`. Final receipt SHA256 (the corrected receipt supersedes the five affected rows from the full after receipt):

```text
ad46530ea5b8edace114ebbeeb4c29ac17ea45e3bc5bb45963ca49efc89efa66  lead-eval-baseline-final.json
ca355d0ff17480074dd2e22e7093357d9bf6ba0d713cc68bfc1ae06b7db41187  lead-eval-after-final.json
857a3d425b48fb66eeececfa705e1dc6a9d9ec15d83712453ffdd7d6a09bdd20  lead-eval-after-corrected.json
```

## 2026-11-07 gate and deadlock extension

The new lane extends the previous report; its baseline is `a4991eb837d0cd6196461208a98b31083dab931f`. See [evidence/telepathy.md](../evidence/telepathy.md) for the causal fix, invariant replay, exact checks, decision, budget and receipt hashes. Gates: **0/8 → 8/8** on codex-lb/gpt-6-luna, four unique contexts, no returned tool execution. Structural regression: **1 pass / 2 fail → 3 pass / 0 fail**. Haiku credentials were absent, so that model remains unverified.

| Scenario           | First executable action                                                                | Before | After |
| ------------------ | -------------------------------------------------------------------------------------- | ------ | ----- |
| rootclaim          | task: restore preview; read-only ROOT auditor does not conflict                        | 0/1    | 1/1   |
| zeroactive         | task: restore preview; inspection stays available                                      | 0/1    | 1/1   |
| harnessrole        | task: obey explicit runtime NEXT ACTION delivered through user-role harness wrapper    | 0/1    | 1/1   |
| spawnconflict      | read agent://AuditPower; then narrow the actual claim or kill a confirmed stuck holder | 0/1    | 1/1   |
| composite-deadlock | read agent://AuditPower; claim repair precedes another dispatch                        | 0/1    | 1/1   |
| fixlist            | task: first FIX NOW row                                                                | 0/1    | 1/1   |
| criticstale        | task: stale current critic action becomes FIX NOW #1                                   | 0/1    | 1/1   |
| compactloop        | todo view: inspect pinned plan before reducing resident context                        | 0/1    | 1/1   |

The full current suite scored **27/38 → 34/38**; the 30 pre-existing scenarios scored **27/30 → 26/30**. Scorers were preserved. Per-scenario single-response results follow; these counts are not a reliability claim.

| Existing scenario          | Before | After |
| -------------------------- | ------ | ----- |
| unseen-product-decision    | 1/1    | 1/1   |
| missing-executable-proof   | 1/1    | 1/1   |
| working                    | 1/1    | 1/1   |
| waiting                    | 1/1    | 0/1   |
| verifying                  | 1/1    | 1/1   |
| audit-queued               | 1/1    | 1/1   |
| head-moved                 | 1/1    | 1/1   |
| handoff-pending            | 1/1    | 1/1   |
| never-handed-to-owner      | 1/1    | 1/1   |
| auditing                   | 1/1    | 1/1   |
| ready-to-close             | 1/1    | 1/1   |
| needs-you                  | 1/1    | 1/1   |
| findings-only              | 1/1    | 1/1   |
| aborted                    | 1/1    | 1/1   |
| failed                     | 1/1    | 1/1   |
| refused                    | 1/1    | 1/1   |
| lost-after-restart         | 1/1    | 1/1   |
| audit-fail                 | 1/1    | 0/1   |
| eta-reached                | 1/1    | 1/1   |
| user-answered-review       | 0/1    | 1/1   |
| review-page-accept         | 1/1    | 1/1   |
| review-page-drop           | 1/1    | 1/1   |
| review-page-redo           | 1/1    | 1/1   |
| owner-question-telegram    | 1/1    | 1/1   |
| running-worker-scope       | 1/1    | 1/1   |
| blocked-on-user            | 0/1    | 0/1   |
| blocked-user-already-asked | 1/1    | 1/1   |
| estimate-cap               | 0/1    | 0/1   |
| external-blocker           | 1/1    | 1/1   |
| capacity-full              | 1/1    | 1/1   |

All 136 requests, including failed corrective iterations, reserved $0.681686 against the unchanged $2 cap; provider usage reported $0.06197812. Raw evidence: `/home/kom/proj/ai_pr/omp-telepathy-20261107/evidence/lead-instructions`. The final eight-gate receipt supersedes only the eight gate rows from the full final run.
