Audit delivered TODO rows at one repository head. Verify each row yourself at HEAD; you are read-only for product files: do not edit, commit, push, ask the user or record the verdict yourself; the harness records it.
ROOT={{root}}
HEAD={{head}}
Check out nothing else: every check runs against HEAD in ROOT (or a detached worktree of HEAD if ROOT is busy).

Rows:
{{rows}}

For a row carrying auditOrigin.resolution="retarget": this is its only read-only check of a superseded delivery. The preserved old finding is historical context. Verify on current HEAD; do not look for the old PR/branch, seek old publication receipts, ask the user, change product files or create follow-ups. Check only what still applies in this checkout. Return inconclusive if that cannot be done; the harness accepts and retires the old finding.

For each row:
1. Acceptance is the row title plus its linked requirements above. Each must hold at HEAD.
2. For every requirements-document change, inspect the delivered commits' complete requirement diff against the VERBATIM USER QUOTEs above. Report any widening as a concrete fail to the lead, naming the hunk and quote. A PRD rewrite cannot authorize itself. If quote evidence is missing, return inconclusive. Model artefacts not blocking controls does not authorize suppressing real physical infeasibility conflicts.
3. Confirm the delivered change is in HEAD (`git merge-base --is-ancestor <commit> HEAD` for each commit named in the evidence).
An existing delivered commit outside HEAD MUST await integration, not fail audit or request another implementation worker; the lead's NEXT ACTION MUST name its exact merge or cherry-pick command within existing git authority. The runtime MUST start audit when that commit becomes reachable; nonexistent commits remain failed delivery, reachable defects retain audit findings, and deliveries without commit receipts keep their existing identity.
A `git:<repo>@<delivered commit>` resource MAY remain pinned after integration: audit the descendant HEAD only when that exact pin is a verified delivery receipt in the same repository. NEVER replace the resource pin to start audit; an unrelated pin remains a mismatch.
3. Re-run at HEAD the checks named in the row's evidence (tests, lint, build, specs, scripts), and the project's scoped build/tests for the touched code.
4. When the row or a requirement is visible in the UI, open it at HEAD and capture a screenshot at every width named in the row, evidence or requirements (default 1440 and 430), and look at the result yourself.
5. Previous worker transcripts (agent://…) are context about what was done, never proof. A claim there counts only after you reproduce it at HEAD.

Verdicts per row:
- "pass": you ran the checks above at HEAD and every acceptance item holds.
- "fail": you observed a concrete defect at HEAD; name the location, what you saw, and the command or screenshot that shows it.
- "inconclusive": you could not verify (missing tool, missing or unclear evidence, no runnable check, environment problem). Name exactly the missing piece. Never report missing evidence as "fail".
List every command you ran (with exit code) and every screenshot you captured for that row; `git rev-parse`/`status`/`log`/`show` are identity reads, not checks. A pass or fail without a check or screenshot is recorded as inconclusive.

Return JSON only: {"rows":[{"row":"<exact row title>","verdict":"pass"|"fail"|"inconclusive","findings":"what you checked and saw, or the missing piece","checks":[{"command":"bun test src/x.test.ts","exitCode":0}],"screenshots":[{"path":"/abs/path.png","width":1440}]}]}

For a requirement-document edit also return requirementDiffs, one entry per changed requirement hunk: {"before":"exact old clause","after":"exact new clause","quoteIds":["linked ID"],"widening":false,"reason":"why the exact quote authorizes this diff"}. Read the actual git diff from the delivered commit(s), not just the worker summary. Missing diff/quotes is inconclusive. Any widening is fail, even if tests pass. Solar not blocking levels does not authorize hiding physical infeasibility conflicts.

Classify every finding with severity "blocker" or "later" and an executable action. Blocker means a visible product regression the user would reject on sight, broken build/gates/tests, data loss, or wrong model numbers. Polish, wording, extra evidence/oracles and test-shape nits are later. Only blockers fail delivery; a result with no blockers is clean/pass even with later findings. Missing severity defaults to later except regression/broken-gate kinds. Review only the delta since the recorded audit base, and verify previously reported blockers; do not reopen unchanged accepted scope.
Return structured issues alongside the findings summary: "issues":[{"kind":"product_regression","severity":"blocker","evidence":"observed location and result","action":"repair the failing behavior and rerun its check"}]. Use an empty issues array when there are no findings.
Mark required delivery gates with "gate":true in checks; exploratory failures corrected by a subsequent probe are not failed delivery gates.

Prior observations are retrieval context bound to their recorded input identity, delivery and revision. Reopen their immutable locators and authenticate the bytes against current inputs before use; they confer no source availability, owner approval or audit pass. Administrative progress prose never supplies a new material input.

Material input migration: legacy persisted rows and audits remain readable, but changing only evidence prose or its timestamp cannot reset exhausted attempts. Supply new identity through the real todo tool's schedule operation, for example:
```json
{"op":"schedule","updates":[{"task":"<exact row title>","materialInputs":{"criterion":"<immutable acceptance revision>","receipts":["<immutable check or source receipt locator>"],"prerequisites":["<newly available prerequisite receipt locator>"]},"evidence":"Human-readable explanation"}]}
```
Use the complete current material input set. Keep its identities unchanged for estimate, staffing and handoff administration. Receipt and prerequisite ordering is irrelevant. These fields describe audit inputs; they grant no approval, source availability or passing verdict by themselves.
