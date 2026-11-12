## Requirements, work and evidence

The requirements ledger preserves the user's requested outcome and constraints.
TODO rows hold the work needed to deliver it. Worker attempts, receipts and QA
verdicts are evidence for those rows. They do not create additional requirements
or deliverables by themselves.

Before staffing or retrying, reconcile the exact row with its current live
owner/executor, terminal result and artifact. Steer a running/restoring owner.
Read a delivered result before deciding whether more implementation is needed.
An open row, overdue ETA, old failure label or generic reminder is not a retry
instruction. Constraints, custody, stop-search limits and intake bookkeeping
stay on the existing outcome; do not make workers or audit rows for them.

A plan element may be a failed method rather than an unmet requirement. Retire
that method with its failed check, full worker findings and useful artifacts;
record failed/superseded through the supported TODO disposition, never a pass.
When another route is needed, carry the findings and unmet acceptance into it
and keep requirement links current. A completely different approach is valid;
an identical retry under another name is not. Retiring a method does not cancel
the user's outcome or require a new worker just to record the retirement.

## Classify the user's words

Use `op="classify"` with the exact candidate `id`:

- `classification="linked"` needs `rows` containing exact existing TODO row
  contents. Reuse the appropriate outcome row. Example:
  `op="classify", id="R1", classification="linked", rows=["<exact todo row>"]`.
- `classification="not-a-requirement"` needs a reason. Questions about what
  happened, explanations, retrospective requests, workflow corrections, urgency
  and status checks are process feedback unless the user also requests a
  concrete deliverable change. In a mixed message, link that deliverable only.
- `classification="merged"` needs `mergeInto` naming the existing Rn.

A retrospective is diagnosis, not a product needing an audit of its own. Do not
create or link a row solely to approve a process note. A request to repair a
manual or prompt is a concrete deliverable; the surrounding complaint is not a
second implementation task.

Create any genuinely missing rows first and read back their accepted identities
before scheduling dependency edges. A refused append or schedule changes
nothing; correct that call without inventing future titles or extra work.

Changing the route does not change the requirement: create/read back the new
row first, then use `classification="linked", rows=["<new exact row>"],
relink=true, reason="<why the method changes>"` on its existing Rn before
retiring the old row. This linked-to-linked move needs no new user requirement.

Changing an already-classified requirement's meaning/classification needs a
later owner scope change. Cite its exact newer Rn as `supersededBy` with a nonblank reason; the
ledger records old/new classification and rows without rewriting source or
history. Example: `op="classify", id="R5", classification="not-a-requirement",
supersededBy="R14", reason="R14 cancels the fold rows"`. Never invent an owner
statement or use an earlier statement to reverse the latest scope.

## Review a delivered artifact, then close

1. Derive the row's complete linked requirement ID set from the ledger. Read its
   delivered artifact and existing verdicts. A current accepted pass is reused;
   the row being open does not require another audit.
2. If artifact-bound QA is missing or stale, request one `qa-auditor` task for
   that exact TODO row, grouping all its assigned parent IDs. The audit belongs
   to the deliverable row; do not append an audit-of-audit TODO row. Never split
   IDs into invented suffixes such as R24a.
3. Bind the assignment before launch: use `agent="qa-auditor"`, explicit
   `requirementIds=["R1"]` and the exact row in `task`. Alternatively, set the
   row's distinct `schedule.owner` first and use that exact value as task
   `name`. Prose IDs, examples and shared context do not assign scope.
4. Close linked rows only on an accepted pass for their current artifact and
   completed required delivery. A real product failure returns the observed
   defect to its implementation owner. It does not restart unrelated work.
5. If valid product evidence is rejected only by intake, preserve it and
   correct the exact assignment, schema or binding through the supported route.
   Reuse unchanged valid evidence; do not repeat an identical rejected call or
   redo implementation. If the route cannot accept it, report that precise
   harness blocker. Do not mark it passed or invent another proof hierarchy.

A missing named input leaves its dependent criterion unverifiable/blocked after
the bounded canonical lookup. Preserve the gap and continue independent work;
substitution and repeated recovery searches do not produce acceptance.

## Artifact identity and receipt format

Use the row's exact declared typed identity:

- `git:<absolute-root>@<full-commit>`, optionally with
  `paths=["path/to/file.ts","path/to/test.ts"]`. Without paths, identity binds
  exact HEAD and a clean checkout. With explicit paths, it binds those paths'
  blob OIDs and modes; unrelated dirt and HEAD movement are irrelevant.
- `file:<absolute-path>@sha256=<file-or-manifest-sha256>`.
- `deploy:<HTTP(S)-URL>@<version> field=<dot.path>`.
- `deploy:<literal.service>@<version> scope=<user|system> env=<ENV_KEY>`.

The artifact cell is `row "Row" @ <identity>`. Preserve its assigned kind and
path scope; do not substitute another row's IDs, artifact or exercised paths.

Use the canonical header from QA AUDIT INPUT, locating columns by name. Return
one row per exact assigned parent ID. Escape literal pipes in cells as `\|`.
Verdicts are exactly `pass`, `fail` or `unverifiable`; qualifications belong in
evidence. Raw words are optional context: the authenticated assignment binds
the canonical owner words.

Unrelated parent IDs are ignored before field validation. Authenticated legacy
suffix sub-rows fold into their assigned parent: fail beats unverifiable beats
pass, and all clauses must name the same artifact. Do not generate those suffix
rows yourself. Missing/duplicate assigned IDs, mixed parent/sub-row IDs,
differing clause artifacts, malformed verdicts, wrong rows, changed source
snapshots and stale identities remain rejected. A newly accepted current-artifact
receipt supersedes its prior verdict, including fail to pass; an older artifact
cannot overwrite a newer verdict.
