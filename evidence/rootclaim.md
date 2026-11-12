# ROOT reader claims — PR #92

Raw objective and authorization: ../brief.md. Starting HEAD and rollback point:
`0f33e728d0324ee45b62ccf87fea9cbecefeae4e`. Only lane/rootclaim writes;
publication only to fork `topic/rt-agent-runtime-core` with the exact supplied lease.
No installation, desktop action, private config change, upstream/main mutation,
or live DC execution. The named session archive was grepped read-only; excerpts
are in ../journal-grep.txt. Existing spawn-admission behavior from
[evidence/spawnconflict.md](spawnconflict.md) is retained.

## Rule and implementation

Read-only workers hold no exclusive write claim. Reads observe individual file
versions at read time, not a consistent filesystem snapshot. The resolved tool
policy supplies readOnly to both admission and runtime hooks. Named read-only
roles (qa-auditor, explore, scout, reviewer, security-reviewer), explicit per-item
readOnly and schedule.readOnly restrict tools and disable unrestricted bash,
MCP/custom extension tools and nested spawns. Tool-defined readers are recognized
without relying on their names. Named row agentProfile also identifies read claims.
Shell review needs a writer role and declared resources.

Task flat and batch schemas now accept resources/readOnly. Explicit absolute
resources are checked for canonical containment in the matched row, then replace
its broad resources. Expansion needs a todo schedule change first. Shared batch
context grants nothing. Otherwise use row resources/absolute assignment paths;
missing scope is unscoped, never implicit ROOT. Pending unowned rows reserve no
paths. Read/write classification and scopes persist through updateTodoSchedule.
REFUSED retains holder, conflicting resource and an actionable tasks[].resources
hint; no job/executor is allocated for refused items.

File mutation preflight skips read claims and rejects writes from read-only rows.
Unscoped workers still check explicit writers, then acquire canonical exact-target
reservations synchronously, without an await between checking/acquiring. These
reservations are local to the canonical lead session and owner and expire when the
row closes, loses ownership or becomes read-only. Existing live scope checks,
nested containment, symlink checks and late admission checks remain.

Decisions: ../decision.txt approves nonexclusive readers, validated narrowing,
unscoped defaults and mutation admission. ../implementation-decision.txt approves
session-keyed synchronous reservations and the deliberate removal of unrestricted
bash from read-only roles. These are lane_ask DECISIONs, not inferred approval.

## Executed proof

- ../base-repro.log: only agent_router.ts restored temporarily to pinned HEAD,
  same new tests and remaining code: **0 pass, 4 fail**. ROOT reader, explicit
  narrowing, named qa-auditor and tool-defined observer all reproduce refusal.
  Saved router bytes restored in finally before final verification.
- ../regressions-final.log: real TaskTool/schema validation, AsyncJobManager,
  router, policy and mutation gates; subprocess execution mocked: **63 pass,
  0 fail, 291 assertions**, four files. ROOT reader + four disjoint/unscoped
  writers admitted; explicit same-file second writer refused before job/spawn;
  out-of-row scope refused; named/tool-derived readers cannot mutate; concurrent
  unscoped writes admit one exact-target owner. Release, narrowing, symlink,
  ancestor scope, late conflict, speculative, mixed and synchronous paths pass.
- ../extensions-final.log: full extensions **784 pass, 0 fail, 10569 assertions,
  75 files**. Final pending-unowned-row consistency change additionally covered
  by the focused rerun above.
- ../host-green.log: task schema, preflight, blocking split, taskFile, extension
  errors and structured subagent consumers: **123 pass, 0 fail, 430 assertions**.
- ../check-final.log: full **bun check exit 0**, including Rust. Final TS-only
  pending-row consistency change: ../types-final.log **check:ts exit 0**.
- Dependencies installed with ignored scripts and no lockfile save; frozen install
  first refused preexisting catalog/lock drift. No lockfile changes. Native addon
  present in checkout: SHA256
  `7282ebdac852f2c29eacda81273a34378df6232eac0ca8258786e00dcfeed57c`.
  No native provenance or installed-build acceptance claimed.

## Limits

Opaque shell scripts retain the existing limitation: internal mutation targets
cannot be inferred; declare resources for shell work. Exact-target reservations
are in-process, not durable cross-process filesystem locks. No metered model,
live user session, installed OMP or physical screenshot acceptance was exercised.
Docs and tool guidance state the chosen semantics. Fork PR head readback and
publication SHA are recorded in ../publication.log after the authorized push.
