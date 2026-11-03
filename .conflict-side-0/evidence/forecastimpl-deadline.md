# Deadline and time-note slice

Owned changes: `packages/reemxy-extensions/extensions/todo_dispatch.ts`, `deadlines.ts`, `lead_time_notes.ts`, `todo_dispatch.auto-goal.test.ts`, `todo_dispatch.planfact.test.ts`, new `lead_time_notes.forecast.test.ts`.

`autoGoalDeadlineState` preserves the original goal ID, anchor ID, membership, prediction version, forecast and baseline across re-estimate, reorder, split labels, empty/archived labels and an inactive persisted restart checkpoint. Optional explicit different `goalId` creates a new anchor, recording prior/new deadlines. Existing user-goal/deadline priority is preserved. No accepted-goal completion is inferred from disappearing rows. New labels generate append-only scope observations explicitly described as unknown split/addition lineage. Initial automatic forecasts are labeled as initial forecasts rather than user commitments.

`renderCurrentSetForecast` renders dated point and experimental empirical upper, observed coverage denominator and session count, modeled terminal dependency path/owner, empirical allowance, original baseline and current lateness, unknown scope lineage and unresolved external gates. `appendTimedNote` persists membership fingerprint, prediction version and anchor identity alongside the rendered note. Lead-time summary no longer repeats a competing forecast. Existing actionable worker questions/plan-fact diagnostics remain.

Decision obtained with:
`python3 /home/kom/Dropbox/Reemxy/tasks-loop/tools/codex/lane_ask.py --context /home/kom/proj/ai_pr/omp-workerask-20261107/brief-forecastimpl.md --timeout 90 '<optional goalId seam; preserve inactive anchors even if labels vanish; only explicit different goalId creates anchor; unknown lineage>'`
Response: **Approve.** Default auto-todo plan remains one session goal; optional explicit goal identity seam is authoritative. No new-goal identity is inferred from mutable TODO text/hash.

Verification:
`bun test packages/reemxy-extensions/extensions/todo_dispatch.auto-goal.test.ts packages/reemxy-extensions/extensions/lead_time_notes.forecast.test.ts packages/reemxy-extensions/extensions/todo_dispatch.planfact.test.ts packages/reemxy-extensions/extensions/user-deadline-replay.test.ts`
Result: **21 pass, 0 fail; 129 assertions**. Log: `deadline-focused-tests.log`.

Targeted break-code negative control: restored the old requirement that the saved automatic anchor must be active. Ran `bun test packages/reemxy-extensions/extensions/todo_dispatch.auto-goal.test.ts --test-name-pattern 'split, reorder'`. It failed at the externally read deadline: expected original **1793181600000**, received reset **1793206800000**. Log: `deadline-negative-control.log`. Restored correct code and reran the above four suites successfully. This is break-code evidence, not a claim of whole-branch base-red validation.

Semantic reread covered anchor guard/return paths, persisted fields, date units, displayed note, emitted metadata and new lifecycle assertions. Cross-midnight fixture distinguishes Nov 7 23:40 baseline from Nov 8 00:10 point / 01:50 upper. Real dispatcher event harness asserts the new note plus unknown release-gate behavior and absence of delivery probability claims. Existing user-deadline replay tests continue to pass.

Limits: no installation, live session, desktop or private configuration writes. No commits/pushes. Explicit authorized deadline changes/corrections in other owners are outside this slice; event type seams exist, but this does not claim those owners now append them. Durable requirement lineage and accepted-goal events remain the next lane. Scheduler math, full TODO/dispatch suites, composite type-check and DC replay are lead-owned verification.
