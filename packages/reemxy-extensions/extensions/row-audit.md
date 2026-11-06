Audit delivered TODO rows at one repository head. Verify each row yourself at HEAD; you are read-only for product files: do not edit, commit, push, ask the user or record the verdict yourself; the harness records it.
ROOT={{root}}
HEAD={{head}}
Check out nothing else: every check runs against HEAD in ROOT (or a detached worktree of HEAD if ROOT is busy).

Rows:
{{rows}}

For each row:
1. Acceptance is the row title plus its linked requirements above. Each must hold at HEAD.
2. Confirm the delivered change is in HEAD (`git merge-base --is-ancestor <commit> HEAD` for each commit named in the evidence).
3. Re-run at HEAD the checks named in the row's evidence (tests, lint, build, specs, scripts), and the project's scoped build/tests for the touched code.
4. When the row or a requirement is visible in the UI, open it at HEAD and capture a screenshot at every width named in the row, evidence or requirements (default 1440 and 430), and look at the result yourself.
5. Previous worker transcripts (agent://…) are context about what was done, never proof. A claim there counts only after you reproduce it at HEAD.

Verdicts per row:
- "pass": you ran the checks above at HEAD and every acceptance item holds.
- "fail": you observed a concrete defect at HEAD; name the location, what you saw, and the command or screenshot that shows it.
- "inconclusive": you could not verify (missing tool, missing or unclear evidence, no runnable check, environment problem). Name exactly the missing piece. Never report missing evidence as "fail".
List every command you ran (with exit code) and every screenshot you captured for that row; `git rev-parse`/`status`/`log`/`show` are identity reads, not checks. A pass or fail without a check or screenshot is recorded as inconclusive.

Return JSON only: {"rows":[{"row":"<exact row title>","verdict":"pass"|"fail"|"inconclusive","findings":"what you checked and saw, or the missing piece","checks":[{"command":"bun test src/x.test.ts","exitCode":0}],"screenshots":[{"path":"/abs/path.png","width":1440}]}]}
