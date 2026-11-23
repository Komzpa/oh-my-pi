# Subagent SDK async waits — 2026-11-07

Request: identify async launch waits, reproduce four concurrent children with a busy parent and slow optional endpoints, fix the critical path, prove base failure/head success, type-check the 77-PR composite, and fast-forward fork PR #93. No installation or live-session mutation was performed.

## Result and scope

Two reproducible startup waits live in upstream SDK code (not another fork topic):

1. Deferred selectors awaited all runtime provider discovery even when their first choice already resolved from the catalog. Skip that await for an enabled, resolved first selector. Keep discovery for an unresolved first selector, even when a later fallback is cached.
2. Deferred usage-aware model selection awaited remote quota reports without a startup budget. Child sessions now give optional quota preflight 250 ms, pass cancellation to health lookup, and use the existing fail-open behavior on timeout. An explicit `fail-closed` policy retains its original wait and depletion rejection. Request-time credential/usage selection remains authoritative.

The production records alone do **not** prove these two paths caused the live 18–48 s stalls. In particular, a child already supplied an explicit `model` skips deferred selection. The new spans are needed to diagnose the next live slow record. No live after-install measurement exists.

## Await inventory

Durations use the existing bounded launch trace (256 names, 160 characters/name). Names contain operation names, never keys or endpoint URLs. Logger timing is already observed by launch tracing; no per-span disk logging was added. Wall durations overlap and must not be summed as CPU time.

| Startup wait | Trace boundary |
| --- | --- |
| Settings/init and journal writes/queues | Existing owner `settings`, `journal.queue.wait/work`, `journal.write`; inherited settings are synchronous |
| Auth discovery / registry creation | Existing `discoverModels`, `modelRegistry.construct` |
| Credential-scoped cache hydration | Existing hydration work plus `sdk.cacheHydration.wait` |
| Allowed models, discovery/retry, selected runtime metadata | Existing `resolveAllowedModels`, `modelRegistry.runtimeProviders.offline`, `resolveModelDiscoveryDeferredRetry`, discovery fallback names, `refreshInitialModelMetadata` |
| Startup credential selection / broker or refresh awaits | `modelRegistry.apiKey.wait` at the registry owner, including all nested auth work |
| Optional quota health | `sdk.usageHealth.work` and `sdk.usageHealth.wait` |
| Secret files/key initialization | `sdk.secretObfuscator.wait`, existing `loadSecrets` |
| Context, workspace, watchdog/advisor scans, rules | Existing separately timed discovery promises and `discoverTtsrRules`; workspace scan retains its 5 s deadline |
| Skills, custom commands, prompt templates, slash commands | Existing discovery work plus `sdk.skills.wait`, `sdk.customCommands.wait`, `sdk.promptTemplates.wait`, `sdk.slashCommands.wait` |
| MCP and extension binding/loading | Existing MCP/load/prepared-binding spans plus `sdk.inlineExtension.wait` |
| Settings-gated tool reconciliation | `sdk.settingsTools.wait` |
| Prewalk, corpse reclaim | `sdk.prewalkTarget.wait`, `sdk.reclaimDeadCorpse.wait` |
| Memory resolution / developer instructions | `sdk.memoryBackend.resolve.wait`, `sdk.memoryInstructions.wait`, existing prompt-build/start-memory spans |
| Advisor tool initialization, including otherwise hidden TaskTool discovery | `sdk.advisorTools:<tool>` and `sdk.advisorTools.wait` |
| Session construction, system prompt | Existing constructor and prompt spans |

Executor waits outside `sdkCreate` already have journal, roster, model-refresh-owner and session-start timing. Callback bodies installed during construction (tool execution, prompt rebuild, disposal, MCP reload) execute later; they are not startup waits. Background usage/discovery/LSP/memory tasks can outlive readiness and cannot inflate a closed launch trace.

## Replay and measurements

Test: `packages/coding-agent/test/sdk-optional-usage-wait.test.ts`.

The fixture uses real SDK parent/children, shared registry/auth, four simultaneous child creates, a parent runtime discovery in flight, and real loopback HTTP quota/discovery endpoints that withhold responses for 2 s. The parent is busy with background discovery; it does not run a model turn. No provider inference is dispatched. A second case waits 400 ms and verifies explicit fail-closed depletion still rejects.

Base: `1ec28eb6adb6e44d0af42ee5a7ee95888da738c3` in sibling detached `base-proof`, using the same test file and workspace-local package resolution.

| Measurement, milliseconds | Base | Candidate |
| --- | ---: | ---: |
| Four SDK creates, individual inclusive `sdkCreate` | 4385.04–4385.34 | 294.84–314.12 |
| Whole concurrent launch batch | 4389.68 | 314.63 |
| Deferred runtime discovery wait | 2023–2191 | skipped for known first choice |
| Optional usage wait | unlabelled remainder on base | about 250 |

Base command: `bun test ../base-proof/packages/coding-agent/test/sdk-optional-usage-wait.test.ts`: 1 expected failure (4389.68 ms versus <1200 ms contract), 1 pass (fail-closed control).

Candidate command: `bun test packages/coding-agent/test/sdk-optional-usage-wait.test.ts packages/coding-agent/test/sdk-launch-instrumentation.test.ts packages/coding-agent/test/sdk-model-selection.test.ts packages/coding-agent/test/sdk-deferred-role-discovery.test.ts`: **77 pass, 0 fail, 245 assertions**. Existing cases cover depleted/reserve fallback, unknown deferred models, disabled providers, runtime cache hydration and fail-closed policy.

Native addon: pre-supplied lane artifact, SHA256 `2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b`. Base/candidate Rust tree is identical (`e2e133f344aadc2dbc821c2044dd24f8e2dd16c4`); no native changes or rebuild. Dependencies were relinked locally so workspace imports resolve to each proof worktree, rather than the donor lane.

## Composite and outstanding checks

Read-only manifest snapshot: 77 rows from `~/.config/tasks-loop/omp-live-stack.json`; heads resolved from fork at the beginning of this lane. Base `9370e7bfe26`. Detached sibling `composite` merges rows in manifest order. All 77 selected heads were verified ancestors. Additional lane-only timing follow-ups were merged as they removed overlap with PR #147 and PR #152; their behavior was preserved.

At row 26, PR #95 (`fix/impl-worker-effort-cap`, `d11a57d676d59f03698f59e4f34c98b9498b61b7`) conflicts in generated `packages/catalog/src/compat/rules.json`. Only in the disposable composite, `bun run gen:compat` regenerated that file from merged KDL. No source conflict was hand-resolved. Therefore this is a type-check proof of the regenerated composite, **not a clean raw-stack merge proof**.

Composite at verification: `05221a8ca2a3516d562d320500e340426831dd34`. `bun run --filter './packages/*' --sequential --if-present check:types`: **exit 0**, including coding-agent and reemxy-extensions.

Standalone and composite `bun check`: **exit 1** solely in inherited Rust formatting at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93` (comment reflow). TypeScript checks passed. These files are unchanged by this lane. Bun 1.4.4 `--help` confirms `check` is the type-check command; the repository's `check` script additionally runs lint/format and Rust checks. No retry is claimed to fix the inherited formatting.

The canonical `stack_check.py` also fails before this lane's row on fresh upstream: PR #16530 `upstream/task-eval-tools-builtin-names` in `packages/coding-agent/src/task/index.ts`, after seven clean rows. This external blocker and the generated conflict remain for the stack owner. No other branch or manifest was edited.

Raw replay logs, the resolved 77-head snapshot, manifest copy, merge transcript and command output are retained in sibling `../evidence/` under this lane directory. Remaining risks: live cause unconfirmed; no parent-turn/event-loop burst reproduction; providers ignoring abort may finish their quota fetch after the 250 ms startup deadline; explicit fail-closed and genuinely unresolved requested models still wait for required work. No install, updater, desktop, live-session changes, or writes to `~/.omp` / `~/.config` were authorized or performed.

Publication target: fork `topic/rt-restart-queue`, exact lease `1ec28eb6adb6e44d0af42ee5a7ee95888da738c3`. All original commits/authorship are preserved. Rollback is the recorded old head; this lane does not execute a rollback or alter main.
