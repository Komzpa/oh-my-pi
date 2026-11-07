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
