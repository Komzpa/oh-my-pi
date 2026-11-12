# SDK post-construction gap — continuation 3, 2026-11-07

Status: PR #93 diagnostics delivered; shared status cooldown reproduced; latency fix is an **unapplied owner patch**, not part of the executable source on this branch. SDK suite is not green (two verified inherited failures). No live latency acceptance is claimed.

## Scope and inputs

Raw objective: instrument every material step between session construction and memory startup, reproduce parent-busy concurrent launches, fix unnecessary serialization, prove base/head, check the read-only 77-PR composite in manifest order, and publish only a fast-forward descendant of `1be937f75369f6ec6e3db349999d7245c476f0b7` to fork `topic/rt-restart-queue` (PR #93). No installation, updater, live sessions, desktop, other topic mutation, or writes to `~/.omp` / `~/.config`.

Lead's supplied raw `../live-launch-spans-1541.jsonl`, SHA256 `69f98a3311c0bf9f632ee553fc35048c7fe0bafbaece891968345a5f173bde6c`, contains:

| Launch | Total ms | construct:end → memory:start ms |
| --- | ---: | ---: |
| Pr114PipelineWatch-8 | 9,418.731 | 9,075.181 |
| CoolingTrunksJourney-17 | 19,015.061 | 18,700.751 |

The latter has 180 timer samples, largest drift 299.256 ms. This supports an asynchronous wait rather than one continuous 18.7 s main-thread stall. Parent unknown-phase warnings alone do not identify the callsite. The installed build identity/time is lead-supplied; no installed binary or live session was touched.

## Ownership and demonstrated mechanism

The main-based PR #93 SDK has only late-tool reconciliation awaits in this stretch. The existing 77-PR composite adds another await:

`await peerRuntime.initialize()` — `feat/peer-session-messages`, PR #23, pinned head `dd748df69e5d1e6ad964897f76f0671c73d0f058`; introducing SDK commit `db24d40a6066`.

`PeerRuntime.initialize()` calls `repository.statusPorcelain({ untracked: "all", nulTerminated: true })`, stats every dirty path, then reads HEAD and branch. The composite's native JS facade routes status through `statusCoordinator` from `feat/requirements-ledger`, PR #41, pinned head `763bf779249730d56fe762d5a25f13f2f63e154a` (introducing commit `4df5c148e6f5`). That coordinator enforces **10,000 ms between starts per repository**, across status snapshots. A parent `untracked: normal` request can therefore hold a child's `all` request; metadata changes or invalidation can create further queued generations. Identical snapshot/metadata/generation requests coalesce. Neither the cooldown nor its ownership was guessed from a PR title.

This composition explains the shape and approximate one/two-interval live delays. It is the strongest identified candidate, **not yet a live callsite proof**: the old record lacks a peer span and the installed source was not inspected. Tool mutation queues are per session, not one global parent queue.

## Published diagnostics and regression

Source candidate `1946e65fa3a` adds named timing for session/settings bindings, skill compression kickoff, advisor restore kickoff, late-registration snapshot/reconciliation wait, registry queue versus mutation execution, presentation changes, extension-source binding/discovery, registry attachment/status, dispose binding, prewarm kickoff/API-key wait, LSP warmup kickoff and auto-learn construction. Existing LSP discovery/warmup and memory spans remain. No scheduling behavior changes on this branch. PR #23's absent peer callsite is instrumented only in the separate owner patch below.

The existing real-SDK diagnostic test injects 40 ms synchronous advisor kickoff work and asserts that it appears in `sdk.advisorCostRestore.kickoff.syncPrefixMs`. Exact base `1be937f7536`, detached `../sdkwait3-base`, same test: **1 pass / 1 fail**, missing named duration. Source candidate: **2 pass / 0 fail**. Logs: `../evidence/sdkwait3-regression-{base,head}.log`.

## Owner patch, reproduction and limitations

Artifacts: `sdkwait3-peer-owner.patch` and inert `sdkwait3-peer-startup-queue.fixture.txt`. They are review material, not automatically executed or applied to another topic. To replay, copy the fixture into the composite as `packages/coding-agent/test/sdk-peer-startup-queue.test.js` and run `bun test` on that exact file, before and after applying the patch.

The fixture creates three real concurrent SDK sessions. It substitutes only `PeerRuntime.initialize` with requests to the **actual isolated status coordinator**, using a simulated clock and distinct child metadata generations after a parent normal-status request. It also runs 50 ms of synchronous parent-thread work. Base: all three SDK calls remain unready before releasing the queue; assertion fails (0 ready versus 3). Queue starts are `[0, 10000, 20000, 30000]` simulated ms. Draft patch: all three SDK calls are ready before queue release; **1 pass / 0 fail**. Raw logs `../evidence/sdkwait3-peer-{base,head}.log`. This is a controlled dependency injection at the baseline boundary, not a replay of real Git load or evidence that every live launch uses distinct metadata.

Patch changes PR #23's call to `startInitialization()`: background baseline discovery with logged failure, observation/handover work ordered through the existing pending chain, and spans for repository discovery, status wait, snapshot, HEAD and branch. Patched disposable composite package type-check: exit 0 (`sdkwait3-owner-patch-types.log`).

**Owner review remains necessary:** baseline discovery is not cancelled/bounded on disposal; early tool mutations may happen before its initial status snapshot and escape baseline-difference attribution. These need contract tests and a policy decision in PR #23 before treating this draft as ready. Moving the baseline off readiness proves the startup property, not complete peer-attribution correctness. PR #41's cooldown is intentional containment and was not bypassed globally. No other branch was written.

## Checks and composite

Standalone package type-check and changed-file oxlint/oxfmt: exit 0. Full SDK suite on the initial instrumentation source: **327 pass / 2 fail**, 46 files. Both failures reproduce on exact base: destination failed Hindsight recall (`sdk-move-cwd`) and active repository context after cwd change (`sdk-context-file-refresh`). Base control log: `sdkwait3-sdk-base-controls.log`. They are outside the gap and were not hidden or weakened. Final source SDK rerun: **325 pass / 4 fail**, including two 5-second timeouts in `sdk-skills` while composite assembly/checks were running (`sdkwait3-sdk-final.log`). Focused head/base skill controls are in `sdkwait3-skills-{head,base}.log`; both pass 10/10, so concurrency attribution is not asserted as proven. The idle full-suite replay finished **327 pass / 2 fail**, the same two base failures (`sdkwait3-sdk-idle.log`).

Canonical manifest was read only and byte-compared with `../evidence/manifest.json`: both SHA256 `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`. Resolved pins: `../evidence/resolved-stack.json`, 77 rows, base `9370e7bfe26e948d72f53f918e681b402e600383`.

Accepted disposable composite: `../sdkwait3-composite-verified`, all 77 rows in manifest order, source `1946e65fa3a` substituted at row 24, all selected heads verified ancestors. Composite `9c81acea30f3412d53398d4aba1385b98dde901c`. Only the known row-26 generated `rules.json` conflict was resolved by `bun run gen:compat`; no hand-resolved source conflicts. `bun run --filter './packages/*' --sequential --if-present check:types`: **exit 0**. Logs and exact assembly script: sibling `../evidence/sdkwait3-*`. Publication adds evidence only after this source proof.

Discarded attempts are not acceptance: an initial assembler received symbolic HEAD (wrong in a changing composite), then an exact-head assembly found two source conflicts. Revised tracing avoids those conflicts. An early test assertion had a type error, fixed before the accepted check. The first owner-patch run could not import launch-trace in the diagnostic-free scratch composite; it was changed to the existing logger timing API, then passed. Native addon was reused only for SDK fixtures and generator execution, not as a proof of the composite's changed native source.

## Publication

Target: `git@github.com:Komzpa/oh-my-pi.git`, branch `topic/rt-restart-queue`, PR #93. Exact lease/rollback ancestor: `1be937f75369f6ec6e3db349999d7245c476f0b7`. Preserve all prior commits and authorship. Publish only a descendant with the user-supplied explicit lease, then compare remote branch and PR heads. This evidence does not mark the live latency fix or all-green SDK acceptance complete.

Publication readback receipt: `../evidence/sdkwait3-push-readback.json`; compare its branch and PR heads with the commit containing this evidence.
