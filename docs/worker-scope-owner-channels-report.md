# Running worker scope and owner answer channels — PR #92

Defect, 2026-11-06: «почему он блядь figuring out когда тебя просили ещё вчера сделать чтобы однозначно всё было в инструкции?» Baseline: `5e399ba9a94783ad09f75c49f97b092cfa6bae0b`. Target: Komzpa/oh-my-pi `topic/rt-agent-runtime-core`. No installation or live session changes.

## Enforcement found

- `todo_dispatch.ts:refuseRelativeWorkerWrite` remembers an outside absolute path per worker session and refuses later relative edit/write/ast_edit paths. It prevents accidental writes into the lead checkout; it does not snapshot row resources.
- `dispatch_preflight.ts:workerToolPreflight` checks explicit file targets, patch/rename targets and recognized shell write operands. Previously its only allowed root was the worker's session cwd, independently of row resources. Opaque shell scripts are not a filesystem sandbox.
- `agent_router.ts:ownedCheckoutScopes` resolves declared resources, exact row ownership, assignment text or cwd for dispatch. `activeWriteWorker` previously used the spawn's stored checkoutScopes forever. This was the actual frozen ownership check; `checkout_scope.ts` normalizes paths and compares overlaps, rather than owning a snapshot.
- Writes now read the parent's current matching row on every call. The existing peer bridge exposes getTodoPhases synchronously, so worker threads also read current parent state. Absolute row paths replace the implicit cwd scope; without absolute path resources the existing cwd fallback remains. Scope changes can revoke the old path as well as permit the new one.
- Active writer locks refresh from current matching row resources. Successful resource schedule results steer the existing worker with one line naming its row and new resources. No stop or redispatch is involved. A missing/ambiguous scope refusal names the exact path, row, todo schedule fix and instructions to restore a disappeared worktree or declare its replacement absolute path.

Scope instructions remain in the existing gate-notices.md owner, used in active-writer and working-row turn context. The existing handoff instruction now explicitly sends the review link in text before marking it handed off.

## Model proof

Model: `codex-lb/gpt-6-luna`; one response per unique context, no HTTP retries or fallback. One shared aggregate budget: 78 calls, 2,754,454 conservatively reserved tokens, ceilings 100 calls / 4,000,000 tokens. This is a behavioral probe, not a reliability estimate.

Before: **24/28**, including **4/6 new scenarios**. Full final run: **27/28** under an overly strict exact-resource matcher (it demanded the file while the model granted its containing worktree). The corrected channel run accepts either valid grant and replays the actual TODO update: **7/7**, covering all **6/6 new scenarios** plus existing chat acceptance. Combined final result: **28/28**, retaining the full run's other 21 responses. Earlier failures and receipts remain preserved.

New scenarios cover saved page Accept, Redo plus note, Drop, a Reemxy owner_question reply delivered via Telegram as a user message, a row never handed to the owner, and a running worker's refused write. Chat acceptance remains covered. Page fixtures serve cards.json and api/answers over loopback and use the actual polling hook and TodoTool transition. Native TODO decisions returned by the model are replayed only in disposable state; worker, control and external tools are never executed. The channel checks reject another question, ask tool, or kill call. Page answers assert completed/accepted, pending/redo, or abandoned/drop; missing handoff requires the review link; scope repair requires todo schedule on the exact row and a resource granting the requested write.

Receipts and complete contexts/tool calls/usage/hashes: `/home/kom/proj/ai_pr/omp-regrant-20261106/evidence/`.

| Receipt             | SHA256                                                           |
| ------------------- | ---------------------------------------------------------------- |
| before.json         | 0a0e5a79aadc3542b813fae59b406193c058d599ed0c0b600204a7f71fc57844 |
| final.json          | 4f06d34b19df0fefb178b5862f23b7459990d6865c470b882e722adc0eaa3d7e |
| channels-final.json | 9125197dda2f7014b379836b097a9ad2e8f6356e4970b66bee126f8d445c18fe |
| combined-final.json | 82994b0421a0a7425e04901a93d3dab0bc51e1908e883a9e263d37537c24c056 |

Reproduce with `bun packages/reemxy-extensions/extensions/lead-instructions.scenarios.ts /tmp/contexts.json`, then `bun run eval:lead-instructions --contexts /tmp/contexts.json --output <new-receipt> --budget-file <shared-budget> --max-calls 100 --max-tokens 4000000`. Baseline contexts were captured with the changed production instruction/enforcement files restored to the baseline, retaining the new scenario capture.

## Checks

- Seven focused extension files: **155 pass, 0 fail** (lead-instructions, dispatch_preflight, agent_router, todo_dispatch.lead-action, todo_review_answers, checkout_scope, todo_dispatch.gates).
- Real worker-thread agents-bridge suite: **10 pass, 0 fail**, including a second peer read after changing the parent's resources.
- `bun run check:types` in reemxy-extensions and coding-agent: pass.
- `oxfmt --check` on touched files: clean except pre-existing drift in README.md, todo_dispatch.lead-action.test.ts and todo_dispatch.ts. Those files were not reformatted. `git diff --check` passes.
- Broader customer-review probe: **42 pass, 5 fail**, with the identical five failures reproduced on baseline todo_dispatch.ts. They concern pre-existing speculative dispatch/handoff fixture behavior; raw outputs are under evidence/checks. They are not counted in the 155 passing focused checks.
