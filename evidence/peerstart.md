# Peer startup: PR #146

2026-11-07, lane `lane/peerstart146`. Source candidate `c6af193d7c64e3baf2de92228a5dace644fc756f`, descendant of owner head `1f534b47305b07d1431758d05b579dd93981ab1c`. Publication adds this evidence only.

## Objective and authority

User: “subagent launch must not wait on peer git-status init (PR #146 topic/task-coordination-advisory-ownership)”. Close disposal cancellation and early-mutation attribution, preserve existing peer behavior, verify the 77-PR composite in manifest order, compare SDK tests to base, and push only this fork topic with the supplied lease. No installation, updater, live sessions, desktop, other topic/main mutations, or configuration writes.

The earlier owner-mismatch report is superseded by this explicit #146 instruction. The original diagnostics note misattributed `db24d40a606603fff4beeddae0311daca5fd908a` to #23; the introducing commit and runtime belong to #146. PR #41 owns the status cooldown and is unchanged.

## Change

SDK creation starts peer initialization without awaiting it. The runtime's pending chain still orders observations and handover after initialization. It captures HEAD synchronously, retains filesystem changes during the initial status wait, and reconciles them against tracked/untracked paths and existing shared-checkout ownership rules. This preserves early shell edits, deletion of tracked files and new untracked files even when the initial status is cached, without claiming untouched dirty files, ignored output, or sibling-owned paths. Existing direct mutation and shell-redirection attribution remains active.

Disposal aborts the VCS requests, closes the temporary watcher, unsubscribes events and clears retained paths. Every awaited initialization/observation stage checks disposal before further state or registry writes. The coordinator cancellation probe proves a queued waiter and its timer disappear without starting queued Git work; the topic test also deliberately resolves a backend after abort and proves no late attribution or extra status request.

Tests use OS temporary directories and an outer repository proxy so the status-boundary injection works with both native repositories and #41's wrapper. The SDK handover fixture checks disjointness before its first accepted yield, preserving the composite's single-acceptance contract.

## Latency proof

Three real concurrent SDK sessions after a parent request, using the actual #41 coordinator. Only baseline discovery is injected. Model/auth setup and imports are outside the measured launch interval. No provider requests or live agents are involved.

| Source | Child 1 | Child 2 | Child 3 |
| --- | ---: | ---: | ---: |
| Base, actual 10,000 ms timer | 10,001.17 ms | 20,001.36 ms | 30,001.48 ms |
| Final source, actual timer | 105.59 ms | 105.59 ms | 105.59 ms |

The supplied simulated-clock fixture fails on base (0 ready versus 3 before queue release), passes on head, and retains starts `[0,10000,20000,30000]` simulated ms. A separate probe runs the real initialization prefix on the composite repository: discovery, synchronous HEAD read and watcher setup take 6.68 ms. The real-timer fixture's injected initialization therefore does not hide a comparable synchronous startup delay.

Lane-local receipts: `queue-base.log`, `queue-head.log`, `wall-base.log`, `composite-contracts-final.log`, `sync-startup.log`. Reproduction fixtures: supplied `../sdkwait3-peer-startup-queue.fixture.txt`, plus `sdk-peer-startup-wall.fixture.txt`, `peer-queue-dispose.fixture.txt` and `measure-sync.fixture.txt` in this evidence directory. Copy the `.txt` fixtures to their matching `.test.js` names under the composite's `packages/coding-agent/test/`. Set `EXPECT_COOLDOWN=1` only for the real-timer base control. The base composite reverses `source.patch`; all other PR inputs are identical.

## Verification

- Topic `bun check`: exit 0; lint, formatting and package types pass. Rust is skipped by the repository's unchanged-Rust rule. Existing unrelated lint warnings remain. `check-final.log`.
- Topic peer runtime, coordination and advisory tests: 22 pass / 0 fail. `peer-final.log`.
- Final composite: 26 pass / 0 fail across those tests, original queue fixture, real-timer fixture, coordinator-disposal probe and synchronous-prefix probe. `composite-contracts-final.log`. Run with `bun test --timeout 60000` because existing handover observations still honor #41's real cooldown.
- Both new topic contracts fail on the old implementation: abort signal absent and early edits swallowed by baseline. `contracts-base-final.log`.
- SDK command on both source trees: `bun test packages/coding-agent/test/sdk-*.test.ts`. Base and final source each have 323 pass / 2 fail, 325 tests in 44 files. The same failures are `sdk-move-cwd.test.ts` destination failed Hindsight recall and `sdk-context-file-refresh.test.ts` active repository context after cwd change. `sdk-base.log`, `sdk-final.log`. They are inherited, not fixed or suppressed here.

Manifest `~/.config/tasks-loop/omp-live-stack.json` remained read-only and retained SHA256 `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`, 77 rows. Heads were resolved from the fork in one snapshot, preserving manifest order in `resolved-stack.json`. Stack base is the recorded fork/main `9370e7bfe26e948d72f53f918e681b402e600383`. The candidate replaces only row #146. `assemble-verified.py` reproduces the assembly; all 77 selected full SHAs are verified ancestors. Source composite `d0ccfde876e1644a14af51ad1dcd0eb711921aff` in `../peerstart-verified-composite`; `bun run --filter './packages/*' --sequential --if-present check:types` passes (`composite-types-final.log`). Only the existing generated `rules.json` conflict was resolved, by `bun run gen:compat`; no source conflicts were hand-resolved.

The preprovided native addon was reused; its hash is in `native-addon.sha256`. No native source changed in this topic and no installed binary was replaced. Raw logs, resolved pins and scratch worktrees remain local; this report is the published evidence carrier.

## Limits and publication

No live launch/deployment proof is claimed. Initial attribution now depends on filesystem notifications during the bounded startup window; the exercised platform is Linux/local filesystem. Handover can still await status cooldown. This patch does not require changing #41's cooldown.

The canonical stack checker against newer upstream `4fc4afd588cecdff189690dca1e029340f59bcdf` fails before #146 at PR #16530, `packages/coding-agent/src/task/index.ts`, after seven clean PRs. The old owner head produces the identical failure (`stack-check.log`, `stack-check-base.log`). This does not invalidate the recorded-base composite, but fresh-upstream integration remains blocked by that separate topic; no other branch was repaired.

Publication target: `git@github.com:Komzpa/oh-my-pi.git`, `refs/heads/topic/task-coordination-advisory-ownership`, ready fork PR #146, base `main`. Exact lease and preserved rollback ancestor: `1f534b47305b07d1431758d05b579dd93981ab1c`. The pushed commit must be its descendant. Read back both the remote branch and PR head and compare with the full pushed SHA. Publication receipt: lane-local `push-readback.json`. No PR comments, description edits, main pushes or installation are part of this task.
