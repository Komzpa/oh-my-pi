{{#if repeated}}
WAIT/STOP REFUSED: deadline re-plan still required; see the critical path and remedies already reported for this forecast revision.
{{else}}
WAIT/STOP REFUSED: expected deadline miss / overdue work {{late}}m. Critical path / overdue rows: {{rows}}.
The deadline belongs to the user. Re-plan the work in todo state until expected finish is at or before the unchanged due time:
- Crashing: split critical-path work into parallel rows with separate available workers; record dependencies, owners, resources and measured estimates.
- Fast-tracking: overlap dependent work only where safe; record the revised dependencies and evidence with todo {op:"schedule",updates:[{task:"exact row",dependencies:[],evidence:"why overlap is safe"}]}.
- Re-estimation: todo {op:"schedule",updates:[{task:"exact row",estimate:{...},evidence:"measured basis"}]}.
- Scope triage against the user's goal: retain must-haves; move only nice-to-haves to the visible, reversible after-deadline set with todo {op:"schedule",updates:[{task:"exact row",postDeadline:true,evidence:"why this is optional for the stated goal"}]}. Use postDeadline:false to restore.
Prose alone does not repair the plan. Live owners alone do not clear overdue rows. Complete them, triage them visibly, or record an evidence-based re-plan.
Only if no re-plan fits, send the user one message with concrete scope trade-offs for their decision. Keep the due time unchanged until the user acts; a lead tool call cannot change it.
{{/if}}
