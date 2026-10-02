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

---

# Gate receipt — compiled runtime acceptance at 6594984f (append, 2026-10-18 07:32–08:07 +04:00)

Gate: OmpNativeCompiledRuntimeAcceptance attempt 2. ROOT=/home/kom/proj/ai_pr/sweep-20261018-omp88.
Identity frozen before and after: HEAD=6594984f12c83861ce2452a0a721b042e04afd01, working tree clean,
branch fix/omp-native-process-88-merge (remote topic/natives-process head, per OmpNativeLockMerge receipt).
No source edits, no Git mutations, no pushes, no installs, no CI triggers, no public writes.

## CI run 39089988400 (exact accepted head, read once)
- headSha 6594984f12c8…, conclusion=failure, 2026-10-18T02:24:49Z. artifacts total_count=0 (no usable artifact).
- Failed job 117564560210 "Build native addons (bazel)", step "Build linux-x64 native addons":
  ERROR crates/pi-vcs/BUILD.bazel:8 rust_library //crates/pi-vcs:pi-vcs: E0432 unresolved import
  `brush_core` at crates/pi-vcs/src/process_limit.rs:27 (deps from all_crate_deps() do not resolve
  the vendored path crate brush-core). Smoke/stage/upload steps skipped. This is the first failing
  proof for the CI bazel native path on the accepted head; not fixed here (source edits out of scope).

## Source-matched compiled build (owned, no host install)
- Method: canonical candidate build per root package.json build:native —
  `bun --cwd=packages/natives run build` → scripts/bazel-natives.ts host → scripts/build-bindings.ts
  (cargo bindings path). START 07:56:21, EXIT=0, END 07:58:09 (1m42s compile).
  Log: memory/omp-patch-evidence/latency-resume-20261018/profile-new/omp88-candidate-build-native-6594984.log
  (compiled crates/pi-* + brush-core v0.5.0 from ROOT paths only; no other root in the log).
- Replaced stale in-tree addon: packages/natives/native/pi_natives.linux-x64-modern.node
  old sha256 7bc932d38b2194ab77d5c5eec21e7361ac0ab2deac8e7dfdf39cbc7919861e79 (stale, pre-build)
  new sha256 35882ec54a953c3fec288fb728bd431f008dccb4bc9b1b524e113ff88d3c9911 (built 07:58 at HEAD).
- Addon identity: `bun scripts/install-tests/native-version.ts <fresh addon>` → 18.12.1 (== package.json).
- Exact CI smoke script (verbatim from ci.yml "Smoke native addons", script-file form) on fresh addon:
  exit=0. On truncated 4 KiB corrupt fixture: exit=135 (SIGBUS during load — hard fail, not swallowed);
  `bun -e require(...)` on the same fixture also crashed exit=135, i.e. no JS wording fallback exists.
- Cross-root non-reuse: lock-refresh root (…/omp-pr88-lock-refresh-20261018, HEAD d9600066) addon
  sha256 5ee4be471c… built 06:14 there; its native trees (crates, Cargo.toml/lock, packages/natives)
  MATCH ROOT but MODULE.bazel.lock differs — not copied or reused; only smoke-tested in place (exit=0).

## Compiled (not cli.ts) consumer
- `bun scripts/ci-release-build-binaries.ts --targets linux-x64` START 08:00:03 EXIT=0 END 08:01:01.
  Log: …/omp88-candidate-compile-linux-x64-6594984.log.
- Binary packages/coding-agent/binaries/omp-linux-x64 sha256 6103a50d05f14139004cfbdc433e810b48b07d633ec508715c547262288dc618
  (embeds the fresh 35882ec5 addon via embed-native; version stamp enforced at compile).
- Isolated HOME/XDG_DATA_HOME consumer: `--version` → omp/18.12.1 exit=0; `stats --summary` exit=0;
  `--smoke-test` → "smoke-test: ok" exit=0.

## Install-method proof
- `OMP_INSTALL_TEST_SKIP_NATIVE_BUILD=1 bash scripts/install-tests/run-ci.sh`
  START 08:03:38 EXIT=0 END 08:05:12. Log: …/omp88-candidate-install-methods-6594984.log.
- Covers binary install smoke (compiled dist), source install smoke (isolated BUN_INSTALL link),
  tarball install smoke (published topology: core loader + per-platform leaf optionalDependency,
  leaf asserted installed, COLLAB_PROTO=3 probe), plus settings/session isolation smoke:
  "All install method smoke tests passed".

## Lineage: 6594984f vs prior 8e19c91feb
- Delta 21 files; zero native-surface delta (no crates/, packages/natives changes).
- MODULE.bazel.lock lockFileVersion 26 → 28 (canonical regeneration, freshness gate passed per OmpNativeLockMerge).
- RECEIPT-omp-native-ci-77b74c8d.md is tracked and last touched by 6594984f itself (auto-merged with main).

## Host footprint (recorded only, no remediation)
- /home/kom/.local/bin/bazelisk: size 5238784, mode 775, ctime 2026-10-18 06:22:43, sha256 d28b588ac0916…,
  byte-identical to /tmp/bazelisk (ctime 06:22:33). Unapproved copy into ~/.local/bin, left in place.
- /home/kom/.local/bin/bazel is a separate symlink → ~/.local/lib/codex-source-tools/bazel-9.0.0-linux-x86_64
  (ctime 2026-09-15), pre-existing, untouched.

## Retro
- Compiled-runtime acceptance is proven end-to-end for the canonical local paths: source-matched
  addon built at the accepted head, exact CI smoke green, compiled consumer green, all three
  install methods green. The stale in-tree addon is replaced by an identity-frozen source-matched build.
- One defect remains for CI only: the bazel native path (//:natives-linux-x64-*) fails E0432
  brush_core in crates/pi-vcs on the accepted head — Cargo resolves brush-core (workspace path dep),
  the bazel all_crate_deps mapping does not. Owner lane must wire brush-core into the pi-vcs bazel
  deps and regenerate; this gate cannot edit source. Until then CI run 39089988400's red stands
  and no CI-produced .node artifact exists.
- Process note: attempt 1 burned ~37 min on repeated lineage/history reads; attempt 2 executed the
  canonical build within ~10 min of start. The delay was discovery loop, not technical blocker.

---

# Gate receipt — pi-vcs bazel brush-core fix (append, 2026-10-18 08:31–09:05 +04:00)

Gate: OmpNativeBazelDependency. ROOT=/home/kom/proj/ai_pr/sweep-20261018-omp88.
Identity frozen: HEAD=6594984f12c83861ce2452a0a721b042e04afd01, branch
fix/omp-native-process-88-merge. No git commit/push, no CI trigger, no host install,
no JS loader change, no npm substitution. Prior receipt sections above are unchanged.

## Change (minimal canonical fix, exactly one build-wiring line)
- crates/pi-vcs/BUILD.bazel: rust_library deps += "//crates/vendor/brush-core"
  (same existing label pattern as crates/pi-shell/BUILD.bazel:35 and pi-builtins:162).
  sha256 8dd986bb85a60556dada630c2f88589eda82122eb81bf1ed71641709dc0c4637 (was aa1c9613…).
- Declared dependency confirmed: crates/pi-vcs/Cargo.toml:19 `brush-core.workspace = true`
  -> root Cargo.toml:241 `brush-core = { path = "crates/vendor/brush-core" }` (vendored
  path crate, [patch.crates-io] at root Cargo.toml:36). all_crate_deps() covers registry
  crates only, so the vendored path crate was never in pi-vcs bazel deps -> E0432 at
  crates/pi-vcs/src/process_limit.rs:27 `use brush_core::ExternalCommandWrapper`.
- packages/natives/CHANGELOG.md: one line under [Unreleased]/Fixed.
  sha256 6b295d877db84693904620d467215f18172b0540c79abc7a86293d2c191f195f.

## Regeneration: not required (checked, no blind lock churn)
- `bun scripts/gen-bazel-lock.ts --check` EXIT=0 -> "MODULE.bazel.lock is up to date."
  The crate_universe lock keys on Cargo.toml/Cargo.lock/member manifests only; this fix
  touches no Cargo manifest, so no generated contract changed.

## Baseline evidence (first failing proof)
- CI run 39089988400 job 117564560210 "Build native addons (bazel)" step
  "Build linux-x64 native addons": E0432 unresolved `brush_core`, same site as above.
  Read from the prior receipt section at run window 07:32–08:07; NOT re-triggered.

## Commands and exits (exact producer cmd derived from ci.yml)
1. Focused pi-vcs proof:
   `bazelisk build --jobs=8 //crates/pi-vcs:pi-vcs` (host_jvm_args ActiveProcessorCount=2,
   ParallelGCThreads=2, CICompilerCount=2; CARGO_BUILD_JOBS=32) START 08:35:21 EXIT=0 END 08:37:54
   (152.7s, 1199 actions). Log: memory/omp-patch-evidence/latency-resume-20261018/profile-new/omp88-bazel-pivcs-focus.log
2. Producer targets, verbatim loop shape of ci.yml "Build linux-x64 native addons"
   (env NATIVES_X64_TARGETS: natives-linux-x64-baseline natives-linux-x64-modern;
   ci.yml:329-331 `for target in $NATIVES_X64_TARGETS; do bazelisk … build "//:$target"`):
   `bazelisk build --jobs=8 //:natives-linux-x64-baseline` EXIT=0 (546.9s, 3170 actions)
   `bazelisk build --jobs=8 //:natives-linux-x64-modern`  EXIT=0 (376.7s, 1927 actions)
   START 08:39:14 END 08:54:39. Log: …/omp88-bazel-natives-producers.log.
   In-graph compile sequence proves the fix on the producer path:
   brush-core -> pi-builtins -> pi-vcs -> pi-shell -> pi_natives cdylib.
   --jobs=8 + bounded host JVM threads are a local pids budget accommodation only
   (tool call cgroups omp-tool-*-call-* carry pids.max=500); build semantics unchanged.
3. Stage exactly as ci.yml:332-335 (`cp -L bazel-bin/"$target"/*.node "ci-natives/$target/"`),
   then the verbatim ci.yml "Smoke native addons" script-file form (loader=bun, as in
   ci.yml:362-363) on both staged paths: EXIT=0. Log: …/omp88-bazel-smoke-stage.log.

## Source/artifact hashes (fresh bazel artifacts, this root only)
- baseline  ci-natives/natives-linux-x64-baseline/pi_natives.linux-x64-baseline.node
  sha256 aca3a932bd1c4892f874bfe89ff7dbe38a83c96f1ce0e3f4914522f55fc71c52
- modern    ci-natives/natives-linux-x64-modern/pi_natives.linux-x64-modern.node
  sha256 4ffeb18513e99c158e0eabd594e9b52adbe3a89add166847063481e1ce1cc5ef

## Negative controls
- Stale-source-artifact check (prior gate's, recorded not rerun): this pair differs from
  prior-gate stale in-tree addon 7bc932d38b2194… and prior-gate cargo-path addon
  35882ec54a95…; no stale or cross-root artifact was reused. Log: …/omp88-bazel-negative-controls.log.
- Corrupt-SIGBUS fixture (prior gate exit=135) deliberately NOT rerun; counts carry over.
- Smoke fail-closed: same script-file form on a bogus .node -> ERR_DLOPEN_FAILED EXIT=1
  (i.e. a non-loading artifact cannot pass the producer smoke).

## Cutover other branches must do (named for git owner; PR141 not duplicated here)
- CI consumes native addons ONLY from (a) actions/cache exact key
  `natives-linux-x64-v1-$NATIVE_INPUTS_HASH` (ci.yml:294 hashFiles Cargo.toml, Cargo.lock,
  MODULE.bazel, MODULE.bazel.lock, rust-toolchain.toml, rustfmt.toml, .bazelrc,
  .bazelignore, .bazelversion, bazel/**, crates/**, BUILD.bazel), else (b) build-from-this-
  checkout in the same job, and consumers get the same-run `natives-linux-x64` artifact or
  the sha256-keyed in-cluster stash (ci.yml:374-411, .github/actions/native-artifacts).
  CI never consumes npm. Therefore PR141 head 8157d4f (run 39094408132 job 117577845745)
  seeing stale artifact 12124081306 digest e4cd7f40… missing axSelectText is cleared ONLY
  by a source-hash cutover on that branch: land the native source delta carrying
  axSelectText under crates/** (or bump the cache prefix `natives-linux-x64-v1-` at
  ci.yml:296), which forces an exact-key miss and a from-checkout producer rebuild.
  A latest-addon republish cannot clear it and is not a fix. This lane's edit sits under
  crates/** and thus self-invalidates old keys; no further action needed for this family.

## Retro for git owner
- Frozen diff = 3 tracked files (below); untracked local build artifacts (bazel-sweep-20261018-omp88
  symlink, ci-natives/ staging) are build outputs, do NOT commit.
- Acceptance: pi-vcs compiles under bazel (focused proof), the exact CI producer targets
  build the native addons with pi-vcs in-graph, and the same script-load smoke passes on the
  produced artifacts. Nothing here proves PR141's branch or any other branch green.
