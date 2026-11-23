These synthetic journals exercise frozen TODO membership, archive/removal,
explicit init reset, chronological suffix isolation, and calibration-store reread.
They contain no private journal text.

Run `bun test packages/coding-agent/test/todo-plan-replay.test.ts`.

Offline collection: `bun scripts/seed-todo-calibration.ts --root /path/to/sessions --output /scratch/calibration.jsonl --report /scratch/report.json`.
Omitting `--output` intentionally selects the installed runtime's versioned
calibration path via `getTodoPlanCalibrationPath()`. Do that only when seeding
that runtime is authorized. No source checkout or default path is seeded by tests.

`--manifest /path/to/scan-manifest.json` accepts the research scan file inventory
(`files` entries with `path`, `upper_byte`, and optional `excluded_fixture` or
`recommended_fixture_exclusion`). It freezes read boundaries and preserves its
explicit fixture exclusions, without importing any research prediction. Without
a manifest, the collector inventories JSONL byte boundaries first and excludes
explicit harness markers in temporary or .claude/jobs working directories.
Temporary worktree naming alone is retained.

The replay streams each journal and keeps current TODO state plus frozen hourly
targets, never the complete journal. It uses the shipped TODO reconstruction and
resource scheduler. Exact phase/content/duplicate ordinal is the identity;
semantic renames and splits are not inferred. Init, disappearance, abandonment,
invalid backdated closure, and unresolved end-of-prefix censor the target. Earlier
completed members survive later archival. Recorded closure is not user acceptance.
Missing capacity uses 32 and is labeled assumed in provenance.

Coverage uses the chronological final 20 percent of hourly origins. Calibration
admits labels only when their observation time strictly precedes the origin and
uses the shipped inverse-session weighted empirical residual quantile. The report
shows settled/scored denominators, censor count, origin and session coverage.
This retrospective slice is exploratory and supplies no 80 percent delivery guarantee.
