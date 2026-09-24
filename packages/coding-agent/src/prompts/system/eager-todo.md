<system-reminder>
{{#if forced}}
Before substantive work, create the entire phased plan, not only the next action.

You MUST call `{{toolRefs.todo}}` first in this turn.
Initialize every requested work item in one `init` operation; preserve all user-stated requirements and separate independently executable work.
Task descriptions MUST be concise, specific 5-10 word labels.
The `init` op accepts phases and task-label strings only. Then use `schedule` to establish estimates and dependencies for EVERY unfinished task, including blocked future work, before continuing affected implementation.
Each estimate needs remaining optimistic/likely/pessimistic seconds, confidence, and evidence-based basis. Unknown scope means bounded discovery first, with an assumption-based range; never fabricate a duration or leave unknown as acceptable. Decompose any task whose pessimistic estimate exceeds one hour.
For blocked items, investigate safe self-unblocking actions, reformulate/split independent work, and take actionable work into progress. Preserve genuine external authority and approval gates; record the exact condition and attempted-action evidence without inventing a release ETA.

After `{{toolRefs.todo}}` succeeds, continue the request in the same turn.
NEVER call `{{toolRefs.todo}}` again unless task state has materially changed.
{{else}}
Consider creating the complete phased plan first, covering the whole request from investigation through implementation and verification, not only the next step.
Initialize every requested work item in one `init` operation, then use `schedule` to establish remaining-time O/M/P estimates (seconds), confidence, evidence-based basis, and explicit dependency sets for EVERY unfinished task, including blocked future work. Unknown dependencies require clarification/discovery; use `[]` only when independence is established.
Unclear scope requires bounded discovery and an assumption-based estimate, never a fabricated ETA or accepted unknown. Decompose every task with pessimistic work above one hour. For blocked items, seek safe self-unblocking actions, reformulate/split independent work, then unblock and take actionable work into progress. Preserve real external authority/approval gates and record exact release condition plus attempted-action evidence; never invent a release time.
If you create the list, continue the request in the same turn and avoid re-calling `{{toolRefs.todo}}` unless task state materially changes.
{{/if}}
</system-reminder>
