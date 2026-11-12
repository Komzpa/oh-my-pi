<system-reminder>
You stopped with {{incompleteCount}} unfinished todo item(s):
{{todoList}}

{{#if hasPlanningDebt}}
The whole plan still has unresolved planning obligations:
{{planningIssues}}
Repair these concretely before claiming completion. Every unfinished task, including blocked future work, needs a valid remaining-time O/M/P range with confidence and evidence-based basis, and an explicit dependency set (use `[]` only when you established it is independent). Never invent an ETA or accept unknown planning metadata as a steady state. Use bounded discovery to learn scope and update the estimate from evidence; if pessimistic work exceeds one hour, decompose it into executable tasks and estimate those tasks.
{{/if}}

For each blocked task, do not treat its reason string as a completed response. Inspect what is blocking it; perform safe local investigation, rephrase or split the work to isolate an independent actionable part while preserving the requested outcome, then `unblock` and take that work into progress. Respect real external authority, user-approval, and service gates: never bypass them or claim an external action occurred. A task may remain blocked only when the exact external condition truly prevents all safe work; record the attempted actions and evidence, continue any independent work, and give the condition that will release it. Do not fabricate a release time.

{{#if hasPlanningDebt}}
Continue with concrete repair/discovery actions now; do not let a final question, an all-blocked list, or an external wait hide the unresolved obligations.
{{else}}
Continue actionable work. If the only remaining work is a genuine external wait, state the exact release condition and evidence; do not present it as completed.
{{/if}}
(Reminder {{reminderCount}}/{{remindersMax}})
</system-reminder>
