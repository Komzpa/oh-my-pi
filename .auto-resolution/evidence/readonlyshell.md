# Read-only command workers — PR #92 lane

Raw objective: ../brief.md. Base/rollback: cb6b60bd0b20eec30064f91b4f516e608195200c.
Only lane/readonlyshell is changed; no push, installation, updater, main mutation,
live DC execution, desktop action, or writes to ~/.omp / ~/.config authorized.

## Change

Explicit readOnly and read-only row/role dispatch preserve declared tools while
removing edit/write/ast_edit/task and nested spawns/prewalk. Default task workers
use the existing built-in registry filtered the same way. Named readers retain
their declared lists. readOnly remains an explicit effective-agent fact, so shell
capabilities do not turn readers into resource owners; the existing admission and
scope guards continue to classify them as nonexclusive readers. Cold revival
retains this fact. Browser/puppeteer already available from the parent are bridged
as explicitly selected tools through the existing restricted-custom-tool seam;
other custom tools and ambient MCP discovery stay disabled.

Existing checkout_scope / agent_router guards inspect file-tool targets, not
opaque shell writes. The new executor guard fingerprints HEAD, tracked status,
staged and unstaged binary diffs via the existing native VCS API. It runs before
result publication and before isolation capture/merge, also on driven follow-ups
and monitored wake turns. Changed trees fail even after a successful yield, with
one line pointing the chief to git diff/status. It does not revert anyone's work.
Untracked build output is allowed. Outside Git there is no tracked-tree check.
Concurrent writes conservatively fail a reader; edits restored before the end
are outside this pre/post check. This is detection, not a shell sandbox.

Decision: ../decision.txt, lane_ask.py with ../brief.md, returned
"DECISION: Yes, this is acceptable minimal scope." It explicitly approved the
conservative concurrent-writer behavior, skipping non-Git checks, and the brief's
lane-only manual-build exception with isolated copied configuration.

## Verification

- ../base-repro.log: original executor/policy/dispatch restored temporarily from
  the pinned base, new tests retained: 0 pass / 3 fail. Saved candidate bytes
  restored in finally. Failures: QA shell tool disappears; default task loses
  bash / scout list changes; tracked mutation is incorrectly accepted.
- ../focused-final.log: 184 pass / 0 fail / 631 assertions across structured
  dispatch, executor, persisted revival, tracked-tree guard and spawn admission.
  ROOT reader plus four writers remain admitted; qa-auditor keeps its original
  bash while tool-defined observer is not widened. Browser bridge is exercised
  with a fake preview tool, without touching a real browser. Actual shell write
  plus successful yield is reported failed. Read-only status and untracked output
  pass; edits to an already-dirty tracked file are detected.
- lead-instructions.ts only replays chief TODO/tool decisions and never runs
  worker tool sets; focused effective-tool and executor regressions cover this
  lane instead, as requested.
- ../check-final.log: bun check exit 0, including Rust. Existing warnings remain.
- Test fixture registry reset prevents old tests reusing live agent ids across
  test cases; no production registry semantics changed.
- Native addon reused from the supplied checkout, no Rust source changes:
  SHA256 20f767b0fb5e5a14af16fae9d1593b7fb2153c82d1d351553811893f8b5529f6.
  Its original build provenance is not established by this lane.

## Offline SpawnProbe

Original session copied read-only into ../spawnproof8-original; its exact user
prompt is ../spawnprobe-prompt.txt. DC clone copied with cp -a into ../dc-fixture.
The fixture uses only lane-local config/data/cache/state/session directories.
The provider extension is loaded from this checkout; parent and task role
both select codex-lb/gpt-6-luna (initial attempts also had a project task override). No live router or desktop/browser is used.

**INCOMPLETE: no worker was launched, and no pwd/HEAD output was produced.**

- ../build-final.log: `bun packages/coding-agent/scripts/build-binary.ts` exit 0.
  Binary SHA256 bc0d848bdefdb3b7660009451418a03a540c7dee77d696691cc22cbc4413cfce.
- Exact original prompt, `-p --model codex-lb/gpt-6-luna --session-dir ...
  --max-cost 1`, built binary, cwd ../dc-fixture: ../fixture-command.json,
  ../fixture.log, ../spawnproof-fixed. Every task call was rejected because Luna
  included `model: []` / empty string while task.perCallModel was off.
- ../fixture-decision.txt approved a fixture-only Responses route override.
  Same prompt/model/binary, max-cost 0.99 (remaining aggregate budget):
  ../fixture-responses-command.json, ../fixture-responses.log,
  ../spawnproof-responses. It failed at the same pre-spawn model gate.
- ../fixture-final-decision.txt approved one final config-only retry advertising
  exactly the approved Luna model and removing the conflicting override. Enable
  and allowlist were set in the isolated global agent config (project settings
  cannot grant this); modelRoles.task remained pinned to Luna. Receipt:
  ../fixture-approved-command.json, ../fixture-approved.log,
  ../spawnproof-approved/2026-11-07T21-59-13-921Z_01a1b805-db01-7039-abed-593a28b1ac57.jsonl.
  Line 11 selects codex-lb/gpt-6-luna; lines 13,16,19,22,25 reject
  `sourceSession: ""` because only seance accepts that field. This is task
  argument validation before worker dispatch, not evidence about worker tools.
- Total reported usage across all three parent sessions: $0.0099686; two retries
  each capped at $0.99, sequential, first two settled before retry. No child
  usage exists. Parent process exit 0 is not acceptance: all reported failure.
- Independent readback of the copy's expected HEAD: 7f604c636. This was obtained
  by the lane shell, **not SpawnProbe**, and is not counted as fixture proof.
- Further fixture work awaits the separate task schema/optional-field repair.
  Final lane_ask ../stop-decision.txt: "DECISION: Yes - stop fixture work and
  commit the proven minimal readOnly patch, with offline acceptance explicitly
  marked incomplete." No live build acceptance is
  claimed; the babysitter must rerun SpawnProbe after that blocker is repaired.

GitButler `but status`, `but diff` and `but commit` all refused this linked
worktree with `non-main worktrees are not supported`. The but skill's explicit
worktree-local Git fallback is used for the requested local commit. No push.
