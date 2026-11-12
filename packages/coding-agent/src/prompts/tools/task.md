{{#unless catalogOnly}}
{{#if asyncEnabled}}
{{#if batchEnabled}}
Spawn `tasks[]` concurrently; IDs return immediately.
{{else}}
Spawn one agent; ID returns immediately.
{{/if}}
{{#if hasBlockingAgents}}
BLOCKING agents return inline.
{{/if}}
{{else}}
{{#if batchEnabled}}
Run `tasks[]` synchronously.
{{else}}
Run one agent synchronously.
{{/if}}
{{/if}}
{{#if asyncEnabled}}
{{#ifAny structured hasStructuredAgents}}

# Results
{{#if structured}}`outputSchema`{{else}}STRUCTURED agents'{{/if}} parsed payload, even invalid: agent://<id> (field /<field>, nested /reports/0/data); invalid preview inline.
{{/ifAny}}

{{asyncGuidance}}
{{/if}}

{{#if projectAgentsMd}}Workers receive their own repository's AGENTS.md chain; do not repeat that repository's rules in assignments.{{else}}Workers have NO AGENTS.md; include relevant repository rules in each assignment.{{/if}} Per-agent policy is listed below and overrides this default.

# Inputs
- `agent`: most specific{{#if batchEnabled}}, inside each `tasks[]` item, NEVER at the top level{{/if}}.
  - Omit only for the default (`{{defaultAgent}}`); NEVER name it.
  - The selected role description defines its authority: put only permitted actions in its brief. Keep implementation and verification with the code role; route push/merge to a role that permits publication. Never infer publication authority from bash access.
{{#if scoutAvailable}}
  - Read-only research MUST use `scout` only when files unknown.
{{/if}}
  - Prefer one agent to investigate + edit.
{{#if batchEnabled}}
- `context`: shared (`# Goal`, `# Constraints`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}
{{#if steps}}
- `steps`: ordered stages for one agent; each is sent only after it finishes the previous one, and the last stage's result is returned.
  - First step carries `# Target` files/non-goals{{#if batchEnabled}} beyond `context`{{/if}}.
  - Each step: one `# Change` stage.
  - Last step adds `# Acceptance` observable result.
  - Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via local://<path>, NEVER inline.
  - Independent work → separate tasks.
{{else}}
- `task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).
  - Children start blank;{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via local://<path>, NEVER inline.
{{/if}}
{{#if peerAwareness}}
- `scope`: structured ownership from the task brief and todo schedule: `{root, branch, paths, resources, ports}`. Use the real ROOT/worktree, branch, owned paths, resource identifiers and reserved port numbers. Do not put these only in prose. The worker sees sibling scopes and must deconflict unexpected overlap before handover.
{{/if}}
- `requirementIds`: for requirement audits, the linked requirements to audit (for example `["R5"]`). This explicit scope survives a retry with a different worker name. If omitted, `name` must exactly match the TODO row's `schedule.owner`. Scope never comes from IDs or row names quoted in task prose or shared context.
- `name`: CamelCase ≤32, auto-generated if omitted; address agent by name.{{#if structured}} `outputSchema` overrides agent/session schemas.{{/if}}
- `solutionSpace`: how open-ended the child's problem is: fix or design given, or which causes or designs remain open.
  - Volume of work does not widen it; NEVER mention sibling agents or coordination.
  - Examples: `one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`;
    `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`
- `row`: exact open todo content. Pass it for every planned worker; runtime links ownership at launch. Unknown, ambiguous or closed rows are refused. Several workers may share a row.
- `rework`: explicitly reject a completed result using its `name` and a one-line rejection reason. Completed preparation, implementation-to-QA handoff, and ordinary continuation are not rejection: omit `rework` and use ordinary routing. Omit it for first dispatches and infrastructure retries (failed, aborted, timeout, provider error). An already exhausted row never runs again and needs no approval: split it with todo op=append into 2-4 smaller rows, then dispatch the new rows.
{{#if evalToolsEnabled}}
- `tools`: eval-defined, run in your kernel.
{{/if}}
{{#if effortEnabled}}
- `effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is, matching `solutionSpace`. Default `lo` for lookups, mechanical edits, and known fixes; `med` for ordinary implementation. Use `hi` only when `solutionSpace` names genuinely open choices (design or cause unknown, several competing approaches): on a given fix a high-effort implementer tends to over-engineer and widen scope.
{{/if}}
{{#if perCallModelEnabled}}
- `model`: one exact `provider/model-id[@upstream][:level]` string for this spawn only{{#if batchEnabled}}; per `tasks[]` item{{/if}}.
  - `@upstream` pins an aggregator route and is part of the model identity.
  - Only operator-approved models; no roles, arrays, globs or partial IDs.
  - Approved:
{{#each perCallModelAdvertisement.roles}}
    - {{#list patterns join=", "}}`{{this}}`{{/list}} ({{role}})
{{/each}}
{{#unless perCallModelAdvertisement.parentModelWithheld}}
    - your own current model
{{/unless}}
    - the selected bundled/user agent's own configured model
  - A listed glob approves matching exact IDs; write the exact ID, NEVER the glob.
{{#if perCallModelAdvertisement.allowlist.length}}
  - Allowlist: {{#list perCallModelAdvertisement.allowlist join=", "}}`{{this}}`{{/list}} (must also be approved).
{{/if}}
  - An agent's `task.agentModelOverrides` entry or user-chosen effort conflicts with `model`.
  - Omit unless needed.
  - Requested model unavailable → stop and report; NEVER substitute another.
  - Every request requires an approved model; retry fallback, context promotion and prewalk are off.
{{/if}}
{{#if structured}}
- `schemaMode`: default permissive warns after retries; strict fails.
{{/if}}
- `resources`: optional `string[]` of absolute write paths for the child; when present it alone defines write scope; `[]` means no writes; omitted → scope resolves in order: workspace cwd → explicit scheduled row resources → the checkout containing the child's actual cwd.
- `workspace`: optional `{repo, base, path?}` checkout contract. `repo`: absolute Git repository path, NEVER inferred from task prose. `base`: a commit available in `repo`, resolved to an exact SHA before admission (run `git fetch` first if missing). `path`: an existing absolute checkout of the same repository at exactly `base`; omit `path` to prepare a private checkout at `base`.
- `reads`: optional `string[]` of absolute existing files or directories; admission checks every path exists before any worker starts; reads grant no writes.
- Before-worker failures name `field`, `expected`, `actual`, `action`: fix the named field and retry; NEVER substitute a missing value.
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`: worktree; successful changes apply to parent.
{{else}}
- `isolated`: worktree; changes retained, not applied.
{{/if}}
{{/if}}

{{#if seanceGuidance}}{{seanceGuidance}}{{/if}}Shared edits need one integration owner; give each task its files{{#unless batchEnabled}} and interfaces{{/unless}}.
Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

A `provider unavailable (class)` result is an infrastructure failure. Keep model preferences unchanged and let OMP handle recovery. Never count it against model quality or ask the user to fix billing, quota, subscriptions or authentication.

{{#if batchEnabled}}
Example — valid `task` input (batch), assuming `/work/project` is an existing checkout and `/work/evidence/report.txt` exists:

```json
{
  "context": "# Goal\nFix the input handling issue described in the report.\n# Constraints\nKeep changes within /work/project/src; no checks mid-flight.",
  "tasks": [
    {
      "name": "InputFix",
      "task": "# Target\n/work/project/src; read /work/evidence/report.txt.\n# Change\nApply the bounded input handling fix described in the report.\n# Acceptance\nThe reported input produces the expected result; unrelated behavior stays unchanged.",
      "solutionSpace": "one fix: input handling, change specified in report",
      "workspace": {
        "repo": "/work/project",
        "base": "HEAD",
        "path": "/work/project"
      },
      "reads": ["/work/evidence/report.txt"],
      "resources": ["/work/project/src"]
    }
  ]
}
```
{{/if}}

{{/unless}}
{{#if catalogOnly}}{{#if seanceGuidance}}{{seanceGuidance}}{{/if}}{{/if}}
# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (read-only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}{{#if structured}} (STRUCTURED; schema result){{/if}}: {{description}} ({{#if projectAgentsMd}}project AGENTS.md; do not repeat its rules{{else}}NO AGENTS.md; supply relevant rules{{/if}})
{{/list}}{{/if}}

Resource scope: set `resources` per item to absolute file/subtree paths within its row resources. Write scope resolves first-present-wins: `resources` → workspace cwd → explicit scheduled row resources → the checkout containing the child's actual cwd (legacy, subject to live leases); `[]` means no writes, and clearing a running row to `[]` revokes its previous scope. Scope is verified before any worker starts; the child's prompt and the tool result report that verified grant, and task prose grants no rights. Declare `resources` for every path a shell script writes. Use `readOnly: true` for audit/verify-only work: it preserves the agent’s command execution and browser/puppeteer tools when available, removes edit/write/ast_edit and nested task spawns, and claims no exclusive resources. Commands may inspect git, run tests/builds into worker-owned temp directories, and QA an existing preview; they must not mutate tracked checkout files. A pre/post Git tracked-tree check fails the worker if the checkout changes (including concurrent writers); outside Git no tracked-tree check is available. Named read-only agents retain their own tool lists. Readers do not block writers and see each file at read time. Conflicts name the holder/path: narrow `tasks[].resources` or wait for that writer.
