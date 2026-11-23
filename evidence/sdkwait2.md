# sdkCreate boundary gaps — 2026-11-07

Status: diagnostic repair delivered; live latency cause and latency fix remain unproven.

## Request and authority

Continue PR #93 from `e72c6e768ef06543d0ce076dfde69693acb7fae4`: locate sdkCreate time between spans, add offsets/gaps/lag, reproduce concurrent launches under periodic 1–5 s parent CPU work, fix the demonstrated owner, prove base failure/head success, type-check the read-only 77-PR manifest in order in a disposable worktree, and fast-forward only fork `topic/rt-restart-queue`. No installation, updater, desktop, live-session mutation, other topic writes, or writes to `~/.omp` / `~/.config`.

Queue: diagnostics complete; controlled starvation reproduction complete; standalone/composite checks complete with inherited failures below; publication to the authorized fork branch; live blocking-callsite identification remains open. No live cause is inferred from a synthetic fixture. No external provider inference was dispatched.

## Live evidence and discrimination

Input owners: lead-supplied sibling `../live-launch-spans-1510.jsonl` and `../live-loop-blocked-1510.jsonl`, 2026-11-07 15:02–15:11 +04. Recalculated from their records:

| Launch | sdkCreate ms | Child span count | Sum child wall ms | Largest child ms |
| --- | ---: | ---: | ---: | ---: |
| CoolingSizing | 24,108 | 127 | 1,174 | 220 |
| CoolingReference | 24,290 | 125 | 1,736 | 213 |
| CoolingOracleRepair | 34,231 | 129 | 210 | 18 |
| ShowLevelsInfeasibility-8 | 51,091 | 119 | 281 | 21 |

Child wall durations overlap; their sum is not CPU time. The 51-second record leaves at least 50.8 s outside those child spans. The supplied timer warning is 14,169 ms late with 6,119 ms process CPU and unknown phase. This proves late macrotask delivery, not the blocking callsite, nor that this warning accounts for the whole launch.

The SDK entry wrapper uses AsyncLocalStorage.run; no entry semaphore/serialization queue was found there. Settings is an early awaited value, and the top-level Promise.all of discovery results is another gap boundary. An await outside a child span and a delayed continuation can produce the same old summary. Existing logs have neither offsets nor a CPU profile, so they cannot discriminate (a)/(b)/(c) conclusively. No new live measurement was taken, as instructed.

## Changes and boundedness

`packages/utils/src/launch-trace.ts` now emits:

- `startOffsetMs` / `endOffsetMs` relative to launch start. Repeated names retain first start, last end and the existing aggregate wall time/count.
- The 16 largest `boundaryGaps`, with offset, duration and bracketing span name plus start/end edge. Entry and tail are included. `gapCount` and `boundaryGapMs` account for all gaps even when only the largest are retained.
- `leafIntervalMs`: time between a directly matching span start/end boundary. This and `boundaryGapMs` partition elapsed launch wall time without double counting nested spans. A boundary gap can still be inside an inclusive async span; it is not automatically an uninstrumented await.
- A 100 ms unref'ed timer per active trace, retaining only the 16 largest drift samples and a count. Readiness/failure cancels the timer and samples an overdue final probe, so completion before timer delivery cannot hide a terminal stall. No per-step disk logging.

Span/name caps remain 256/160; sample lists stay at 16. The synchronous parent event dispatch and each listener invocation now carry `session.dispatch:<event>` / `session.listener:<event>:<function>` phase labels. Labels end before the first await; these identify synchronous work at those callsites, not arbitrary async continuations or a sampled stack. `unknown` remains possible elsewhere. No speculative yield or queue removal was made.

## Reproduction and regression

`packages/utils/test/launch-starvation.test.ts` runs an isolated child test process to avoid blocking unrelated tests. Four concurrent traces share a parent timer created outside their AsyncLocalStorage scopes. Every 200 ms the parent performs 1,000 ms synchronous work, three times, before releasing child continuations. Six child spans per launch remain fast. The zero-CPU control uses the identical gates.

Representative replay (ms, monotonic wall, all four traces included):

| Parent CPU per burst | Launch range | Boundary gaps, first trace | Largest child | Largest timer drift |
| --- | ---: | ---: | ---: | ---: |
| 0 | 601.28–601.52 | 601.38 | 0.083 | 0.60 |
| 1,000, three bursts | 3,601.53–3,601.56 | 3,601.45 | 0.075 | 1,000.34 |

Each blocked trace reports three approximately 1,200 ms `before:end` → `after:start` gaps. The synchronous attribution names `fixture.parent.cpu`. This demonstrates that (b) can produce large sdkCreate-shaped inclusive wall time with tiny children. It is a launch-trace fixture, not a replay of the real SDK/2.7 GB parent journal, and does not establish the live blocker or fix its latency.

Base proof: detached sibling `gap-base-proof`, exact `e72c6e768ef06543d0ce076dfde69693acb7fae4`, current test files, local workspace dependency links. Command: `bun test ../gap-base-proof/packages/utils/test/launch-trace.test.ts ../gap-base-proof/packages/utils/test/launch-starvation.test.ts`: 9 pass, 2 expected failures (missing offset/gap accounting; starvation summary cannot account for elapsed time).

Candidate source: `a5edb45623a` (descends from `b016649369c`). Same two test files: 11 pass, 0 fail. Full utils: `bun test packages/utils/test`: 966 pass, 5 skip, 0 fail, 93 files. Focused SDK launch instrumentation plus optional usage wait: 4 pass, 0 fail.

Full `bun test packages/coding-agent/test/sdk-*.test.ts`: 327 pass, 2 fail across 46 files. Both failures reproduce unchanged on base: `sdk-move-cwd.test.ts:134` (destination Hindsight recall) and `sdk-context-file-refresh.test.ts:155` (active repository context). Base command for these two files: 9 pass, same 2 fail. No SDK regression observed; the SDK suite is not green. These inherited tests originate in upstream commits `61e14b86f737` and `237aa46faf06`, not this diagnostic change.

Native artifact for standalone/base SDK tests: supplied lane addon SHA256 `2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b`; native source trees and Cargo/toolchain files match standalone/base. No rebuild. Disposable composites reused it solely to run the rules generator; their native tree differs, so no composite native-runtime proof is claimed. Initial generator attempts failed due to the missing addon. Before retrying, inspected Bun 1.4.4 `bun run --help` (package script runner; https://bun.com/docs/cli/run) and `packages/natives/native/loader-state.js:901` (enumerates missing addon candidates).

## Composite and checks

Canonical manifest `~/.config/tasks-loop/omp-live-stack.json` was read only and compared equal to `../evidence/manifest.json`. Resolved 77-row snapshot: `../evidence/resolved-stack.json`, base `9370e7bfe26e948d72f53f918e681b402e600383`. Final disposable `../gap-composite-final` merges all rows in manifest order, substituting source `a5edb45623a` at row 24, then verifies all 77 selected heads are ancestors. Result: `271eb82f16ba72735269fca5cd53dbd66a337279`.

As in the previous lane, row 26 PR #95 conflicts only in generated `packages/catalog/src/compat/rules.json`; regenerated with `bun run gen:compat` from merged KDL in the disposable worktree. No source conflict was hand-resolved. This is a regenerated-composite type proof, not clean raw-stack assembly proof.

`bun run --filter './packages/*' --sequential --if-present check:types`: exit 0 on that final composite. Subsequent publication changes are this evidence and a changelog entry only; source/test tree is unchanged.

Standalone `bun check`: exit 1 on inherited Rust formatting, `crates/pi-shell/src/bash/trace/viz/printer.rs:1216` and `runtime_tests.rs:93`. Owned TypeScript formatting/lint and all package type checks pass. Those Rust files are unchanged. No broader native acceptance is claimed.

Raw command logs, replay JSON, assembly scripts/transcripts and the read-only manifest snapshot remain in sibling `../evidence/sdkwait2-*`.

## Publication and remaining work

Authorized target: fork `topic/rt-restart-queue`, PR #93. Exact old lease / rollback target: `e72c6e768ef06543d0ce076dfde69693acb7fae4`. Preserve all existing commits and authorship; publish only a descendant with the requested explicit lease. Read back the remote branch and PR head after push.

Risk/open acceptance: diagnostics do not reduce the live 17–51 s launches. Blocking-callsite attribution is improved at parent event callsites, but no new live slow record exists and no live blocking owner can be named from old unknown-phase warnings. A new slow record with boundary/lag data, and if still unknown a CPU profile from the installation owner, is needed before a justified hot-path fix. Do not infer ownership of the blocker from journal size or another PR's title. No other topic was changed, and no install/updater/live-session/config mutation occurred.
