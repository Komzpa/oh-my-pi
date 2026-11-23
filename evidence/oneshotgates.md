# One-shot gate proportionality — 2026-11-07

## Scope and result

Raw objective: a fully answered single read-only SpawnProbe request must finish without creating TODO/audit/critic/retro work; preserve real multi-row plan gates. Authority: patch and push only Komzpa/oh-my-pi #92 (`topic/rt-agent-runtime-core`); no install, updater, live sessions, desktop or writes under ~/.omp / ~/.config.

**Partial delivery, explicitly selected by lane_ask.** PR92 removes the premature reply-before-wait refusal for a single unplanned read-scoped worker, suppresses no-row plan checks and retrospective notices, and supplies static one-shot lead guidance. The unconditional requirement-candidate notices/publication bookkeeping belong to PR41 and remain unfixed. This is not a claim that the full installed probe now finishes or that all requirement bookkeeping is gone.

`oneshotgates-owner-decision.txt` directs use of PR92 hooks without duplicating the ledger. After inspecting those hooks and the actual PR41 implementation, `oneshotgates-scope-decision.txt` specifically directs narrow PR92 mitigation plus an explicit PR41 handoff; it rejects widening to PR41 or adding generic notice-dispatch policy. Followed that decision. GitButler `status` and `commit` both refused this linked worktree (`non-main worktrees are not supported`); used its documented worktree-local Git exception.

## Historical comparison and causal boundary

The supplied `../fixture-session.jsonl` is the exact session `01a1b6ca-cfc7-713a-a5c0-bebc060cae93`. `../fixture-output.txt` ends at SIGTERM, listing SpawnProbe, two plan critics, two auditors and IdentifyDispatchMechanisms. These files are inputs; no live session was resumed or queried.

56a22ad7 and f287b364 are binary SHA256 prefixes, not Git commits. Read-only updater receipts:

- `/home/kom/.local/state/omp-source-updater/attempts/20261107T150932.920355Z/receipt.json`: candidate `56a22ad7bb3f40a565c3d36a131cfcf1ead33ec510aa476f24808b7adc5a54fb`.
- `/home/kom/.local/state/omp-source-updater/attempts/20261107T160826.646731Z/receipt.json`: candidate `f287b364e78251816237d04024f0b43cc3faae866115de86fc73963556d97c38`.

Comparing assembly.prs by branch/headSha (ignoring resolvedAt), exactly 3 of 77 heads changed: PR92 ec0383dff989 -> 772058df757; restart queue 72872935462 -> 8847e85e37a; usage backoff 8f5a56c55b3 -> dd56aad7497. Full hashes: `oneshotgates-build-comparison.json`. Requirements ledger head did not change. PR92's intervening delta is forecast/calibration and owner-question handling, not a new reply/critic gate. The plan critic and unanswered-user prompt have no diff between those heads. Thus the fixture proves the bad gate sequence, but does not prove which intervening commit made the model choose it; the earlier successful run's journal is not supplied. No invented deterministic bisect conclusion.

Observed failure chain:

1. The ledger captures R1 at input admission and supplies a classify/create-row reminder despite no plan. This precedes the worker answer. PR41 `RequirementsLedgerRuntime.commitCandidate` and `remindUnclassifiedCandidates` own those notices.
2. PR92 `unansweredUserReasonWithDraft` refuses `wait` at 16:15:35.994Z despite the user explicitly asking to wait for the worker and then print its result. The worker also encounters its separate yield requirements format check; it eventually returns both values.
3. The main prints both values in the persisted final-answer message around 16:15:41Z, but PR41 `#publicationGate` sees an unclassified candidate, announces it again and queues a steer notice. It marks publication settled but queued bookkeeping still produces another model turn. The model then creates and links a TODO row.
4. That row activates normal scheduled-plan estimates, audits and plan critic. Audit then rejects the extra agents as violating the original worker-count limit. Incident state supplies a retro notice even when no original plan was requested. Repeated auditing cannot undo the recorded extra workers, so the run cannot reach its own completion oracle.

## Patch contract

`waitingForSingleRead` admits only `wait`, only with no open plan rows, exactly one running task, exactly one task dispatched after the latest genuine human input, matching that job's identity, and an explicit empty write-path scope. This is a declared scope boundary, not a semantic proof that arbitrary worker code is read-only. It does not exempt stop-before-answer or a newer human correction. Existing plan rows keep their gates. No model-name or user-word regex determines the exemption.

No-row plan checks and retro notices are suppressed; real Git integration facts and customer-return notices are preserved. Plan critic already skips work without open rows and remains unchanged. One-shot guidance is a static Markdown prompt appended through before_agent_start; explicit worker/action limits also govern bookkeeping.

## Verification

Code commit: `e07e024db46` (full SHA in `oneshotgates-heads.json`).

- Fixture projection `extensions/fixtures/oneshot-spawn-probe.json` retains the original human request, first task call (including empty write scope), and visible answer; omits unrelated memory recall, reasoning and provider payloads.
- Base `828a38e83738a8b84456771231246692da6750b2`, same new test files: `bun test packages/reemxy-extensions/extensions/todo_dispatch.wait.test.ts packages/reemxy-extensions/extensions/todo_dispatch.retro.test.ts`: **133 pass, 1 fail**, specifically the SpawnProbe wait assertion; DC-plan and newer-user controls pass. Initial base execution lacked a native addon and was not counted as regression proof; repeated with the lane-provided addon after confirming no native-source delta between base and candidate.
- Candidate focused run: **134 pass, 0 fail**. Full package `bun run --cwd packages/reemxy-extensions test`: **750 pass, 0 fail, 10324 assertions**, 71 files. Created its expected package-local `.tmp` directory. A first run exposed test harnesses relying on journal fallback; fixed the new guards to use canonical todoStateEntries rather than treating missing snapshot APIs as an empty plan. Preserved Git facts and normal role notes.
- Package typecheck and touched-file oxlint: exit 0. No whole-file formatting; diff and diff -w have identical change counts.
- `bun check`: TypeScript lint/format/types pass; Rust formatting fails in unchanged `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`. No Rust files changed. This check is not reported green.
- Fresh 77-head fetch and `oneshotgates-assemble.py`: candidate replaces only PR92, all 77 full heads verified as union ancestors. Union `138c98cfa248ddf839a1911362a1bf575e0ecf51`. All package `check:types` commands exit 0. Manifest, heads and ancestry ledger are retained in `oneshotgates-manifest.json`, `oneshotgates-heads.json`, `oneshotgates-merges.json`. No generated-file conflict markers occurred. `stack_check.py --repo . --candidate topic/rt-agent-runtime-core=e07e024db46 --no-fetch`: `OK: 77 PRs merge cleanly onto upstream 9370e7bfe2`.
- Fetch/rebase onto fork/main `9370e7bfe26e948d72f53f918e681b402e600383`: already current; range-diff preserves all 318 old commits byte-identically and adds this one code commit. No teammate history rewritten.

Command outputs remain lane-local as `evidence/oneshotgates-{base,focused,suites,check,types,lint,assembly,composite-types,stack-check}.log` (ignored by repository rules; not force-added). Native test addon supplied in this worktree: SHA256 `2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b`; no native changes in this patch. Its build provenance was not supplied, so these are extension behavior/type results, not a new native build acceptance claim.

## Required PR41 handoff (not executed)

Owner: `feat/requirements-ledger`, `packages/coding-agent/src/session/requirements-ledger-runtime.ts`.

Preserve original input capture, but defer candidate reminders in `commitCandidate` / `remindUnclassifiedCandidates` and publication bookkeeping in `#publicationGate` when no TODO rows or linked requirements exist. Do not create a row or launch an auditor merely to discharge an answered one-shot candidate. Once a real plan exists, retain classification, linked-row freshness and auditor gates. Add actual runtime tests with the projected SpawnProbe request/result/answer and no plan, asserting no queueModelNotice continuation, plus a neighbouring multi-row plan that still demands classification/audits. Avoid a dispatch-layer customType suppression or copying the ledger into PR92. This handoff is necessary for the original zero-bookkeeping guarantee.

## Publication target and rollback

Only target: `fork`, `refs/heads/topic/rt-agent-runtime-core`, PR https://github.com/Komzpa/oh-my-pi/pull/92.
Old remote head / rollback target: `828a38e83738a8b84456771231246692da6750b2`. New commits descend from that head; publish with the exact user-specified lease. No PR description/comment edits, upstream/main pushes, install or live actions.
