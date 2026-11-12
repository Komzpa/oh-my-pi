# Forecast implementation, PR #92

Source candidate `0e7fb1bc47dce704fa945abff1b00c80f4554530`; base/exact lease `ec0383dff989391eaa51761dd655ba53d58e7416`. Fork main `9370e7bfe26e948d72f53f918e681b402e600383` is already an ancestor; fetch + rebase was a no-op. Push target is only `fork/topic/rt-agent-runtime-core`; rollback is this original head, subject to a fresh exact lease.

## Contract and implementation

Research contract: `/home/kom/proj/ai_pr/forecast-research-20261107/report.md`, precise implementation specification. The rejected throughput floor and all completed-row multipliers/age floors are removed from selected forecasts. `forecastTodoPlan` remains the only scheduler: 256 deterministic beta-PERT draws use its existing dependency/resource scheduler. Running residuals subtract elapsed since the accepted estimate/start once. Confidence/basis/evidence-only edits preserve the numerical estimate clock. Raw P50/P80 are exposed independently; point stays raw P50. Empirical upper is max(point, point + inverse-session weighted Q80(actualFinish - rawP50Finish)); first origin per session-hour, strictly earlier observed labels, same prediction version, at least 20 origins/5 sessions. No tail cap or imported row-risk telemetry. Worker-attempt risk remains diagnostic.

Immutable hourly predictions and append-only outcome/censor observations persist in the session branch at TODO mutation, including frozen membership and provenance/capacity. Render fallback disables sampling. Resets/removal/abandonment censor original targets rather than certify completion. Stable original goal anchors survive re-estimation, reordered/split/disappearing labels and restored inactive checkpoints. Explicit different goal identity is the new-anchor seam. User deadline priority remains.

## Exact saved DC replays

Fixture SHA256 `be9c107051c1c50dddaf93b9658e9cbdef7a2f2b9cca226e84d62c2b9594af9a`. Exact frozen input from journal lines **125478** and **132057**; both original targets remain censored. No claimed actual finish or research corpus injected as production telemetry. All local dates below use Asia/Tbilisi (+04).

| State | Before selected finish | After raw point | After raw model P80 |
|---|---|---|---|
| 11:12 | 2026-11-08 12:27:22 | 2026-11-07T13:37:02+04:00 | 2026-11-07T13:48:29+04:00 |
| 18:11 | 2026-11-08 01:48:33 | 2026-11-07T19:06:43+04:00 | 2026-11-07T19:14:08+04:00 |

Before source notes are preserved in `forecast-base-control.log` (host default clock was UTC; numeric timestamps are authoritative). The old morning selected bound was calibrated PERT; evening was throughput. After notes below use the recorded 13:57:08 baseline from DC forensics; scope lineage is deliberately unknown, not reconstructed from renamed labels.

### 11:12

> Current set: point 2026-11-07 13:37:02 Asia/Tbilisi; empirical upper unavailable (insufficient calibration; 0 origins, 0 sessions). Driver: 11 MW Adaptive: Level 2/3 buttons still draw Level 1 floor → Levels that cannot fit show as conflict/risk, not silent revert → Collateral for "Maksim: Building layout broken, model incomplete": After applying two levels, the camera loses the building overview: the enlarged model extends beyond the viewport and dense communication pipes obscure the racks. Before, the building footprint and surrounding equipment were visible together. → Collateral for "Maksim: Building layout broken, model incomplete": After applying two levels, the camera loses the building overview: the building extends beyond the narrow viewport, leaving only part of the floor visible and communication pipes covering much of the rack area. Before, the whole building footprint was visible. (owner FitCameraAfterLevels); empirical allowance unknown. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 0m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

### 18:11

> Current set: point 2026-11-07 19:06:43 Asia/Tbilisi; empirical upper unavailable (insufficient calibration; 0 origins, 0 sessions). Driver: Cooling: PR 114 pipeline on bfbabf30d read back → PR 115 folded into PR 114, 114 mergeable onto main (owner FoldPr115IntoPr114); empirical allowance unknown. Original initial forecast 2026-11-07 13:57:08 Asia/Tbilisi, now 255m late. Scope since anchor: genuine additions unknown; 0 labels with unknown split/addition lineage. External gate: none recorded.

## Verification

- Identical DC selected-finish assertions: **0 pass/2 fail on base, 2 pass/0 fail on head**. Logs `forecast-base-control.log`, `forecast-head-control.log`; negative controls reproduce next-day 12:27/01:48 values. New raw/empirical formula tests independently check quantiles, counts, version rejection, delayed/future-label invariance and inverse-session weighting.
- TODO/dispatch suites: **709 pass, 0 fail, 9527 assertions, 53 files** at first implementation head; after confidence-only refinement the affected schedule suite passes **30/30**, 176 assertions. Clock preservation includes evidence-only and identical numerical resubmission with changed confidence. Existing suites cover contention, cycles, capacity and retained first-requirement history.
- Anchor break-code control: restoring old active-only guard fails the retained original deadline, restored code green; see `forecastimpl-deadline.md`. History break control and persisted outcome/restart/fork tests in `forecastimpl-history.md`.
- 77-PR composite assembled in manifest order; all 77 pinned heads checked as ancestors. Source candidate is merged into composite `ab42dda606fe2497c6e5fdb17c873bcffe67b223`. Workspace package dependency links resolve into that throwaway checkout, not this source checkout. Full workspace `bun run --filter './packages/*' --sequential --if-present check:types` uses `bun check --no-script`; complete log `forecastimpl-verified-composite-types.log` in sibling evidence directory. No composite branch or source package was edited to fix a check.
- Focused source type checks and lint passed. No install/updater, desktop, live-session or private-config mutation.

## Decisions and explicit gaps

`lane_ask.py` approved worktree-local Git after GitButler refused linked worktrees, preserving the requested PR route. It approved stable inactive anchors plus optional explicit goalId seam. It also accepted branch-local history plus optional multi-session input as truthful partial collection: see `forecastimpl-history-decision.txt`. A normal single-session branch cannot meet five sessions; it reports insufficient counts and raw quantiles. Canonical offline cross-session collection is a later gap, not a claimed deployed calibrated predictor. Lineage/workId and canonical exporter identity repair stay out of scope, as requested. Unknown scope labels are not counted as genuine additions; absent attempt outcomes are not asserted to be failures.

The source probe uses no empirical calibration corpus, so these DC replays correctly have 0 origins/0 sessions and no experimental upper. Supported-coverage delivery probabilities remain withheld. No real goal completion or deployment is claimed.
