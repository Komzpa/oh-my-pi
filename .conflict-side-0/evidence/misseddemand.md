# Missed deadline and idle-row action demands — PR #92

## Request and scope

Raw defect: anchored deadline 13:57 missed on the live DC lead (installed 0b5e835f, 2026-11-07 +04); notes at 14:00 and 14:37 said “Replan now”, but no split/cut/staff/escalate followed by 14:51. One worker ran beside one ready unowned row; measured pace was 0.4 rows/hour with seven open rows. At 14:43 the lead opened with “Nothing new for you since the last message.”

Required invariant: a missed/slipped anchored deadline must persist an action demand in the existing CHURN journal, survive ignored turns/reload, and accept observed structural recovery rather than prose. Ready unowned work with spare capacity must demand staffing or a recorded row hold after ten minutes. No prose regex gates.

Authorized target is only `fork/topic/rt-agent-runtime-core` (Komzpa/oh-my-pi #92). Starting/rollback head: `c1d10d7528f3cf5d4397902b9b104b66477da3b3`. The lane started detached at that exact head; fetch and the requested fast-forward sync found it current. Attached only `lane/workerask`; existing commits/authorship are retained. GitButler reports “non-main worktrees are not supported”, so the documented linked-worktree Git exception was used. No install, updater, real-home configuration changes, desktop access, or live-session actions.

## Behavior

- Deadline recovery and idle observations are fields on the existing `todo-dispatch-action-demand` receipt, with its existing required/escalated steering. Ordinary turns also arm demands; this does not depend on an internal wake. After two ignored turns, `wait`/`yield` is refused until recovery.
- An ignored deadline demand retains its identity even as time/forecast recedes. After satisfaction, a later ten-minute slip step re-arms it; an improved forecast cannot re-arm an earlier answered step. The anchor is never postponed.
- Deadline satisfaction requires a successful native tool boundary and an observed cut/removal/abandonment of an open row, two newly linked split children, or a new live executor on a previously ready row. Owner labels, re-estimates, completion alone, unrelated additions/dispatches, and failed tools do not satisfy it.
- Explicit escalation uses existing `todo-user-unblock` asked records or `lead-plan-critic-question` records tied to a demand row and timestamp. Critic questions now carry their row and timestamp. Old/unrelated questions do not count.
- `todo_dispatch_forecast` records measured completed rows/hour, measurement start/end, completed count, open count and computed ETA on the same receipt. It takes no supplied ETA or pace. Zero pace has no finite ETA and leaves the demand pending. This is a forecast, not a new deadline or promise.
- Idle age survives reload. It uses canonical dispatcher-ready rows and actual running job count (not the aliases in the owner-name set), within existing effective capacity. An idle demand accepts a new live executor or blocked status with a nonempty blocker on that exact row. Healthy live legacy owners do not accrue idle age.
- No new timers. Existing no-host-timer guards remain in the dispatcher and critic. The existing demand kill switch also disables these new turn and wait gates.

Canonical owners: `extensions/dispatch_wake.ts` for durable recovery state/observation; `todo_dispatch.ts` for tool/lifecycle wiring; `plan_critic.ts` for structured owner-question metadata. Static recovery instructions live in `dispatch-recovery.md`.

## Regression proof

Synced base: `c1d10d7528f3cf5d4397902b9b104b66477da3b3`. New runtime cases copied to a detached base checkout: **7 existing pass, 5 new fail**. Failures expose missing durable deadline/idle demand and missing measured-forecast tool. Raw output: lane-parent `evidence/misseddemand-base.log`.

Source candidate: `2729f30e455afed7e2d33e27cf9a7c62e0c43186`. The evidence-only descendant carries identical source.

Broad runtime command:

```sh
bun test --timeout 120000 packages/reemxy-extensions/extensions/goal_deadlines.test.ts packages/reemxy-extensions/extensions/todo_dispatch*.test.ts packages/reemxy-extensions/extensions/plan_critic*.test.ts packages/reemxy-extensions/extensions/plan-trajectory.test.ts packages/reemxy-extensions/extensions/user-deadline-replay.test.ts packages/reemxy-extensions/extensions/dispatch_recovery.test.ts
```

Final broad result: **516 pass, 0 fail**, 8,750 assertions across 39 files. Raw output: `../evidence/misseddemand-accepted-head.log`.

Controls cover ignored estimate changes, unrelated dispatch, owner label without a live executor, failed tool, fresh versus old/unrelated question, zero pace, exact computed ETA, reload, idle age at 9:59/10:00, full capacity, healthy legacy live owner, unrelated rows versus linked split, and slip-step re-arm. These tests execute state/tool behavior; none grep implementation source.

## Main and full-stack proof

Read-only manifest SHA256: `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`; **77 PRs**. The current manifest and frozen copy have the same hash. All branch heads were fetched from the fork and pinned before assembly. Main: `9370e7bfe26e948d72f53f918e681b402e600383`.

| Tree | Commit | All package type checks | Focused runtime |
| --- | --- | --- | --- |
| main + #92 | `801aa6beb7d3e256072690585f5647387601f8f4` | PASS, exit 0 | 109 pass, 0 fail, 8 files |
| main + all 77 PRs | `8175f3d20768960997fb8c0bef99be347e2fe4dc` | PASS, exit 0 | compiled SDK acceptance below |

Type-check command on each detached throwaway tree under this lane's parent:

```sh
bun run --filter './packages/*' --sequential --if-present check:types
```

Assembly uses `git merge-tree --write-tree`/`git commit-tree` in exact manifest order, verifies **77/77 pinned heads as ancestors**, accepts only the known generated catalog `rules.json` overlap, and regenerates it using `bun run gen:compat`. No topic branches are rewritten for assembly. Replay scripts, pinned heads, merge ledger, results JSON and raw logs are in `../evidence/misseddemand-accepted-{assemble.py,verify.py,manifest.json,heads.json,merges.json,results.json}` and matching logs. External dependencies and the pre-existing native addon are shared; workspace package imports resolve inside each proof tree. Native sources were not changed or rebuilt.

Changed helper/tests oxlint and `git diff --check` pass. Package type checks include the new typed helper and tests; existing dispatcher file retains its pre-existing `@ts-nocheck` policy.

## Compiled SDK acceptance

**PASS**, exit 0, canonical compiled SDK/native proof `ok: true`. Binary SHA256: `c734a9e26aa6c4a4404c9aa2f592e53b2b774ec868d9b7fb2905418110f55e25`. Built from the full composite above using the source `compileCodingAgent` helper from the composite working directory. Proof: `../evidence/misseddemand-compiled-proof.json`; runner: `../evidence/misseddemand-acceptance.py`; build entry: `../misseddemand-accepted-full/.missed-compile.ts`; output and compile logs share the `misseddemand` prefix in the lane-parent evidence directory. The runner uses a lane-owned disposable home/XDG tree, no auth or live configuration, `--no-session`, `--no-tools`, `--no-lsp`, `--no-pty`, `--no-extensions`, `--no-skills`, `--no-rules`, and only the explicitly loaded canonical `tools/omp/source_update_acceptance.ts`. It does not invoke an updater or installer. A dummy, nonfunctional API-key placeholder and explicit catalog model allow CLI startup without live auth; no prompt or provider turn is submitted. The acceptance extension shuts the process down at session start. SDK deadline/PERT/resource/unknown-work, reestimate and completion contracts, restart-drain API, extension lifecycle, and native glob/streamed-cancellation checks all pass. The initial build was invoked from the wrong working directory; rerunning in the composite fixed its virtual-module resolution without source changes.

## Publication and risks

Publish only the explicit topic ref with `OMP_UPSTREAM_PR_PUSH=topic/rt-agent-runtime-core` and exact lease against the starting head. Verify ancestry, remote SHA and PR #92 head readback; final publication evidence is in the lane-parent publication log. No PR description/comments are changed.

Risks: measured pace counts observed completed rows over up to a 90-minute window; unequal row size makes that forecast coarse. With no observed completed row, the lead must use a structural recovery or recorded escalation. Ten-minute idle age starts with runtime observation, so time before the first persisted observation is not invented. Proof is source/runtime/compiled acceptance, not an installed or live DC lead observation.
