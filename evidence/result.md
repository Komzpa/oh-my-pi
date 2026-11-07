# Lead plan critic — result

Ready fork PR: https://github.com/Komzpa/oh-my-pi/pull/172
Branch: `topic/lead-plan-critic`; base: fork/main `9370e7bfe26e948d72f53f918e681b402e600383`.
Implementation commit: `c8cff71983264c71d55cb797eb55d7e33e05357d`.
Native hook dependency: PR #92, preserved whole at `5d5dc65875f338950f3fd149c0d98f26d658c25e`.
This report/changelog follow the source commit; the PR records the latest published head.

## Request and boundaries

Owner request: “A plan critic that runs every 30-60 min (configurable) when the lead has open rows, and immediately on a SLIP/STALL/CHURN-heads-chain trigger.”
“Port their logic, do not shell out.” “Binding: the next lead turns must execute or explicitly reject each action with a reason, enforced by behavior (tool calls and todo/task mutations), not by prose matching.”
“No install, no ~/.omp writes, no live sessions, no desktop.”

The critic is a new extension module. The only existing-code registration change is its package extension list. No edits to the other lane's todo_dispatch/lead_time_notes and no pushes to #92. The explicit hook-dependency exception in the request is used: this branch contains the whole fetched #92 head, preserving its commits and authorship. GitButler refused commit in this linked non-main worktree; its documented local-Git exception was used.

## Delivered behavior

- Main sessions with open rows get a review every 45 minutes; `OMP_PLAN_CRITIC_MINUTES` accepts 30–60. New trajectory triggers bypass that periodic interval. Concurrent callbacks coalesce; unchanged historical triggers do not repeatedly launch reviews.
- The native delivery-critic hook starts a fresh configured `reviewer` at low effort. No invented model name and no parent transcript is passed. The static task asks it to use only the digest, without file/tool/transcript inspection. The existing role/router owns model selection; no pricing or provider routing policy is added here.
- The digest is capped at 12,288 UTF-8 bytes. It includes first/original versus first-observed estimates, elapsed time, attempts, re-estimates, audit transitions, worker start/finish/failure records, waits and historical graph samples, timestamped open/completed counts and deadline history. Compaction preserves deadline endpoints and explicitly counts omitted rows.
- Structured verdicts include convergence, blocker, false waits, split/cut/escalation rows and exact next actions. Verdicts, dispositions, errors and wake escalations append to the session journal; previous entries are not overwritten.
- Successful native todo/task mutations satisfy cut-wait/dispatch/split/cut actions. Splitting requires the named new rows and retirement of the old row. Unrelated mutations, failed calls and lead prose cannot close an action. Explicit rejection needs a reason. Escalation publishes a concrete owner question. Pending actions block wait/yield, survive restart and trigger another lead turn if the lead stops without addressing them.

## Verification

As of the final source run on 2026-11-07:

| Check | Result |
| --- | --- |
| `bun test --parallel packages/reemxy-extensions/extensions` | 691 pass, 0 fail; 62 files; 9,975 assertions |
| `bun run check:ts` | All workspace type/lint/format checks pass |
| `bun run --cwd packages/reemxy-extensions check:types` | Pass after the final source edits |
| Focused critic tests | Real DC negative, converging control, cap/rollover, successful mutation versus prose/failed calls, rejection reason, restart, escalation, periodic interval, immediate churn, fresh input and coalescing |
| Binding mutation control | Temporarily disabled action observation: successful dependency-mutation regression failed; restored implementation passed |
| Trajectory mutation control | Clearing detector flags makes the real DC regression fail; restored implementation passes |
| Stack on requested base | `stack_check.py` with 77 manifest rows plus candidate: all 78 merge cleanly on `9370e7bfe26e948d72f53f918e681b402e600383` |
| Stack on current upstream | Existing conflict at #16530, before the candidate is reached, in `packages/coding-agent/src/task/index.ts` |
| `bun check` | Not green: inherited Rust comment formatting in `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; no Rust changes in the critic delta |

The stack tool only substitutes candidates already present in its manifest. The rehearsal therefore imports the canonical `tools/omp/stack_check.py`, points `STACK` at a temporary copy with this branch appended, and supplies `--candidate topic/lead-plan-critic=<full SHA>`. For the pinned-base rehearsal only, its `rev-parse FETCH_HEAD` result is supplied as the requested base. Neither the live manifest nor a Git ref is changed. The actual source candidate `c8cff71983264c71d55cb797eb55d7e33e05357d` passed this 78-entry rehearsal. The final documentation commit gets the same rehearsal before publication.

Fixture: `packages/reemxy-extensions/extensions/fixtures/plan-critic-dc.json`. Source is the owner's exact DC JSONL, bounded to its last 30 MiB, with 172 time-note first lines through snapshot `2026-11-07T05:08:53.045Z`, and two projected real graph snapshots. The detector identifies **Facility labels after rotation: leaders cross the building** as the critical-path blocker, with the real 11 MW dependency. It does not infer a false dependency from inconvenience alone; that judgment is left to the reviewer.

The deterministic fixture detector is exercised directly. Reviewer invocation, parsing, persistence and enforcement are exercised in a runtime harness with an injected reviewer response. No provider-backed session was started; live model judgment quality and compiled installed-package loading remain unverified under the no-live/no-install boundary.

Repeated-check investigation used `bun --help` (Bun 1.4.4) and the local API sources: `packages/coding-agent/src/extensibility/extensions/loader.ts:208` exposes the TypeBox module namespace and `packages/omptype/src/typebox.ts:521` exports its `Type` builder. The extension uses `pi.typebox.Type`, matching those sources; it adds no transitive runtime TypeBox dependency.

## Delivery state

Published to the Komzpa fork as a ready PR using an exact new-branch lease, then read back from the forge. Changelog attribution links #172. No updater, install, live session or desktop operation was run. Latest-upstream stack readiness and the inherited Rust formatting remain explicit external blockers; they were not hidden by checking the `bun check` box.
