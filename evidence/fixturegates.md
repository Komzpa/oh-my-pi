# Fixture gates — PR #92, 2026-11-07

Objective (raw brief): “a session must not adopt, stage or be gated on unpushed-work / Push rows for commits owned by another live session”; preserve the owner-session Push reminder, lead refused task output with no-spawn outcome, unify calibration, prove base/head and 77-PR types, publish only topic/rt-agent-runtime-core.

Source candidate: `6f7eb91a94cdee5cfeff9596d45b9b3ebc0a56d4`. Base/remote lease: `1b322d0cc4a9ce43aef909675f25696aa2f7aec6`. Fork main: `9370e7bfe26e948d72f53f918e681b402e600383`. Fetch plus `but pull` found no new base commits; no rewrite needed. Range-diff preserves every old PR commit and adds one fix. Real author/committer: Darafei Praliaskouski <me@komzpa.net>.

## Cause and change

`refreshPush` previously treated any registered main session in the checkout as the owner, then created an actionable row from repository age alone. It now requires session-local TODO checkout resources (absolute checkout or contained path), or that session's existing Push obligation on resume. The same predicate guards notices, row insertion, synchronous push demand and integration facts. No cwd fallback establishes ownership. This is explicit plan ownership, not a Git commit-author inference. Empty fresh sessions stay empty and can dispatch SpawnProbe. Existing owner resources retain the reminder and remote-publication completion check.

ExtensionRunner's common task-block return now starts `REFUSED: no worker was spawned.` before advisory/error details. Both an explicit staffing block and a throwing extension exercise this public runtime boundary. Gate/refusal wording was searched for authorized/explicitly authorized. The existing user-wait text refers to existing authority; runtime staffing and unpushed reminders now explicitly say they grant no authorization and preserve the user's action limits.

The time-note dispatch path called the normal SDK forecast without `history`; todo's reader already supplied `TodoPlanCalibrationStore.snapshot(now)`. It was not a version/path mismatch. Dispatch now uses that same store reader, refreshes before note emission, and invalidates its cached decision when the as-of history changes. The SDK forecast remains intact (including host overrides). A seeded store with 20 origins from five sessions, including scored upper finishes, yields identical coverage on both surfaces.

## Behavioral proof

Commands run with isolated `PI_CODING_AGENT_DIR=/tmp/fixturegates-agent` for final suites; no provider or live omp session.

- Base: copy only the changed test files into a detached temporary worktree at `1b322d0c`; run `bun test packages/reemxy-extensions/extensions/todo_dispatch.push.test.ts packages/reemxy-extensions/extensions/todo_dispatch.planfact.test.ts packages/coding-agent/test/extension-task-hook-error.test.ts`. **2 pass, 4 expected failures**: foreign Push row; calibration coverage mismatch; throwing task and staffing task missing the refusal prefix. Receipt: `/home/kom/proj/ai_pr/omp-fixturegates-20261107/base-final.log`.
- Head: those tests plus `packages/coding-agent/test/todo-plan-calibration.test.ts`: **9 pass, 0 fail**, 72 assertions, `/home/kom/proj/ai_pr/omp-fixturegates-20261107/regressions-head.log`.
- All extension suites: `bun test --timeout 120000 packages/reemxy-extensions/extensions/*.test.ts`: **751 pass, 0 fail**, 10,331 assertions, 71 files; `/home/kom/proj/ai_pr/omp-fixturegates-20261107/extensions-head2.log`.
- Host extension runner consumers: `bun test --timeout 120000 packages/coding-agent/test/extensions-runner.test.ts packages/coding-agent/test/extension-task-hook-error.test.ts`: **115 pass, 0 fail**, 321 assertions; `/home/kom/proj/ai_pr/omp-fixturegates-20261107/runner-head.log`.
- `bun check`: TS lint, format and all package types pass. Overall **exit 1**, exclusively unchanged Rust formatting comments at `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`; no Rust patch in this lane. `/home/kom/proj/ai_pr/omp-fixturegates-20261107/head-check3.log`. Normal and whitespace-ignored diff stats agree; `git diff --check` passes.

Assertions inspected: the temp bare-remote fixture first proves no auto row, notice or push demand and an admitted exact read-only SpawnProbe; then an explicit checkout-owning lead gets the Push row, remote worker publication closes it, threshold changes reopen it, and missing remote cannot falsely close it. The seeded note test asserts nonzero origins and exact shared coverage, not prompt boilerplate. Refusal prefix is a required consumer contract.

## Composite

Manifest SHA256 `a5a702aecff4faebaf4b0dab84c305dfc45f3a28c6f69701342cc644498f6589`; 77/77 frozen PR heads are ancestors of union `c25dc63fb54ac2921f5d1ce9e95eaa7afb2f2660`. PR92 overridden with the source candidate. Full head ledger: `/home/kom/proj/ai_pr/omp-fixturegates-20261107/evidence/fixturegates-heads.json`; merge ledger `/home/kom/proj/ai_pr/omp-fixturegates-20261107/evidence/fixturegates-merges.json`; assembly script `/home/kom/proj/ai_pr/omp-fixturegates-20261107/assemble.py`. All merge-tree errors fail closed except the known generated `rules.json` overlap; `bun run gen:compat` regenerated it before the final type-check. `bun run --filter './packages/*' --sequential --if-present check:types` **exit 0** on that regenerated union; `/home/kom/proj/ai_pr/omp-fixturegates-20261107/composite-types-final.log`. `stack_check.py --no-fetch --candidate topic/rt-agent-runtime-core=6f7eb91a94cdee5cfeff9596d45b9b3ebc0a56d4` reports **77 clean**.

The first gen:compat attempt lacked a native addon. Before retry, read `packages/natives/README.md`, Architecture/Building: the loader expects a local platform addon under native/. Reused the existing installed-tree addon via a temporary symlink, after verifying identical pi-natives Rust source tree `5db3e527eb469d3033556e02d4b7f6abd109b564` in installed source `bb580c4c804851e052b14489f9cdcbd4b7cb8ffe` and union. No native source changed, no build/install/update. External dependencies reused from the supplied installation; workspace package links resolve to this candidate's sources.

## Judgment and limits

Used `python3 /home/kom/Dropbox/Reemxy/tasks-loop/tools/codex/lane_ask.py` with `--context /home/kom/proj/ai_pr/omp-fixturegates-20261107/brief.md`:
1. Ownership choice: DECISION “Yes—use session-local evidence, and do not require explicit commit attribution”; checkout resources establish work; preserve resumed Push row; fresh empty one-shot receives none.
2. Workflow follow-up: DECISION “Yes—use a lane-owned plain clone to finish the authorized PR #92 topic push.” GitButler refused the supplied linked worktree; commits use `/home/kom/proj/ai_pr/omp-fixturegates-20261107/publish`, preserving the full topic history, with `but`. Initial but setup registers that plain clone; no real omp config is edited.
3. Publication scope: DECISION “YES — publish commit 6f7eb91 on PR #92 with the documented base Rust gap.” That response incorrectly called bun check green and conflated base regression failures with Rust failures; executed receipts above are authoritative: four intentional regression failures on base, two unchanged Rust formatting locations on head.

No install/updater, live omp, desktop, DC-checkout command, upstream/main push, PR comment or body edit. This proves fixture/runtime hooks, not a new provider-backed or installed-session acceptance. Owner identity is explicit session plan scope; Git commit attribution is deliberately not introduced.

Publication target: only `Komzpa/oh-my-pi:topic/rt-agent-runtime-core`, PR92. Require old head ancestry and exact lease. Rollback target is old `1b322d0cc4a9ce43aef909675f25696aa2f7aec6`; any later rollback must lease the then-current head and stay on that same topic (not executed here).

## Input custody

Fixtures were read from the lane's copies, never the DC checkout:
- `fixture-session.jsonl`: 383999 bytes, SHA256 `e29dbcb6a9621e037ecf59a4ea4420a8a25657fa3ecd19261fc15aa8a2d1c3c8`.
- `fixture-pushgates.jsonl`: 171455 bytes, SHA256 `0f728a37bc5f989c1b30bee976eb24b92a55eadebf5103c5e101264eb70c2361`.
- `fixture-output.txt`: 34 bytes, SHA256 `d5f9b735c55816bb77e46deb1acf756da354cd1652e28418005e7bf3fe557a2b`.
