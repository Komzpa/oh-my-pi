# Whole-plan history feed

Owned files:
- packages/coding-agent/src/tools/todo.ts
- packages/coding-agent/src/tools/todo-plan-history.ts
- packages/coding-agent/test/todo-plan-history.test.ts

TodoTool.execute captures raw plan predictions at successful mutations, once per session-hour. Each custom entry freezes the original P50, prediction version, fingerprint and phase/content/duplicate-ordinal membership. Later mutations append a terminal observation only when every frozen member is completed with a recorded finish after origin and no later than observation. Removal, abandonment and init reset censor the original set. Rehydration reads indexed custom entries, incrementally caching the branch prefix; rewind rebuilds and removes labels no longer on that branch. No render path persists records. forecastTodoLivePlan only forwards optional as-of history to the scheduler and filters rows. Existing identical-estimate/evidence clock logic is untouched.

Verification:
- `bun test packages/coding-agent/test/todo-plan-history.test.ts`: 4 pass, 14 assertions.
- Targeted break control temporarily changed all-members completion predicate to any-member; first partial-closure assertion failed (exit 1), then original restored and tests passed.
- `bun run --cwd packages/coding-agent check:types`: no errors in 4,922 files.
- `bunx oxlint` on three owned files: exit 0.
- `bunx oxfmt` on three owned files: complete.
- `bun test packages/coding-agent/test/tools/todo.test.ts packages/coding-agent/test/tools/todo-schedule.test.ts packages/coding-agent/test/todo-planfact.test.ts packages/coding-agent/test/todo-plan-history.test.ts`: 135 pass, one legacy expectation failed at todo-planfact.test.ts:83 (old whole-row ratio 10 vs new ratio 1); lead notified because scheduler test contract is theirs.

Limits requiring lead decision:
- Durable feed is current-branch only. It cannot normally meet the five-distinct-session gate. An optional history input accepts a future approved cross-session corpus; no mutable row estimates are reconstructed as historical predictions. Safe insufficient fallback remains active.
- Cold resume scans all branch forecast entries; incremental scans stop at cached prefix. No unvalidated rolling window truncation is introduced. Mutation work scales with retained history/pending origins and membership, outside rendering; no fixed-size corpus cap is asserted.
- No cross-session importer, durable lineage, live installation or external action performed.

State: needs-lead-decision on cross-session corpus; branch-local persistence and tested calibration feed are implemented.
