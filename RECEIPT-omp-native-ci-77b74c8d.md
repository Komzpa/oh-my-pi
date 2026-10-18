# Gate receipt — PR88 CI trigger diagnosis (read-only)

Gate: readonly acceptance at /home/kom/proj/ai_pr/sweep-20261018-omp88.
Run window: 2026-10-18 05:47–06:05 Asia/Tbilisi (01:47–02:05 UTC).
No source edits, no builds, no pushes, no CI triggers, no PR metadata changes.

## Artifact identity
- Checkout HEAD: 77b74c8d4f6aa69bf07d52654631d1b6f4a496ed
  ("Build source-matched native addons for pull requests", 2026-10-18T01:32:14Z),
  branch fix/omp-native-process-88, tree clean (git status: clean).
- Remote github = git@github.com:Komzpa/oh-my-pi.git.
- GET /repos/Komzpa/oh-my-pi/pulls/88 → head 77b74c8d4f6aa69bf07d52654631d1b6f4a496ed,
  state open, base main, updated_at 2026-10-18T01:33:09Z. Checkout HEAD == remote PR head.

## First failing proof
- GET .../commits/77b74c8d…/check-runs → total_count 0 (re-checked at end of gate).
- GET .../actions/runs?head_sha=77b74c8d… → total_count 0.
- GET .../actions/runs?branch=topic/natives-process → newest runs are head 858a6718
  (2026-10-17T22:29:02Z, CI failure + OMP Nix success); 77b74c8d absent from all 34 runs.
- Combined status on 77b74c8d: exactly one entry, CodeRabbit: success created
  2026-10-18T01:33:10Z — GitHub processed the push/webhook for this sha; only Actions runs missing.

## Diagnosed cause (live evidence)
PR88 is unmergeable: mergeable false, mergeable_state dirty. Local proof in this checkout:

    git fetch github main          # → dc4a66a84c6144a4d5f57233e3b150cd5e3b49cf
    git merge-tree $(git merge-base FETCH_HEAD 77b74c8d) FETCH_HEAD 77b74c8d
    # CONFLICT (content): Merge conflict in MODULE.bazel.lock  (only conflicted file)

main moved to dc4a66a8 (merge of upstream PR #15574, natives) at 2026-10-17T23:51Z,
after head 858a6718 got its runs (22:29:02Z) and before this push (01:32:14Z).
pull_request runs execute the computed merge commit; GitHub schedules no CI run while
the PR head cannot be merged.

Cross-checks ruling out other causes:
- Workflows CI (ci.yml), OMP Nix, Warm bun store cache all state active.
- Repo Actions settings: enabled true, allowed_actions all; repo not archived/disabled.
- ci.yml at head parses as YAML; pull_request targets main (PR base) and changed files
  (MODULE.bazel.lock, .github/**) match the paths filter → filters not the blocker.
- Events live repo-wide: runs created 01:38–01:57Z for other PRs (685057f9 PR23,
  6deb7d3e PR122, 9ac3c6a6 PR139, 5f820f06, 2510d44d, beef78fa), all from
  mergeable: true PRs.
- Dirty control: PR30 (cb872770, mergeable_state dirty) also has zero check-runs on
  its current head; its branch runs stop at older shas. Pattern: dirty heads get no runs.

Ruled out: branch filters, path filters, disabled/deleted workflows, stale events,
concurrency cancellation (would still create a run), contributor gating (owner's branch).

## Current producer CI (pre-existing)
Run 39075250292 (CI on 858a6718, failure, 2026-10-17T22:29:02Z) failed jobs:
- Check MODULE.bazel.lock freshness — .../runs/39075250292/job/117520963633
- Test coding-agent native/unit (TS) 3/3 — .../job/117521035549
- Test CLI smoke (TS) — .../job/117521035556
- Install method smoke tests — .../job/117521035558
- Test coding-agent singleton/global-state (TS) — .../job/117521035557
Nothing on 77b74c8d exists to own. PR reviews: only stale coderabbitai[bot] COMMENTED
reviews (2026-10-02 … 2026-10-06), predating the new heads.

## Concrete next action (requires the lead, not this gate)
CI for 77b74c8d will not start until PR88 is mergeable:
1. On a branch over 77b74c8d, merge github/main (dc4a66a8) and resolve the single
   MODULE.bazel.lock conflict (regenerate the lock, do not hand-merge; re-run the
   "Check MODULE.bazel.lock freshness" logic locally before pushing).
2. Push the resolved head to refs/heads/topic/natives-process; the pull_request
   synchronize event then creates CI + OMP Nix runs. No manual trigger needed/permitted.
3. Verify producer CI (changed ci.yml native-addons path) on that new head — the prior
   red on 858a6718 proves nothing for it.

Rollback hint: git push github 858a6718b559a3f9e08e445ad57cc10171461288:refs/heads/topic/natives-process --force-with-lease=refs/heads/topic/natives-process:77b74c8d4f6aa69bf07d52654631d1b6f4a496ed
