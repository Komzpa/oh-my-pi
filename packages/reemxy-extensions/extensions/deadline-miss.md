{{#if status}}
Overdue {{late}}m · {{rows}}
{{else if runningStop}}
STOP REFUSED: running work still has live executors. Wait for their results before ending the session.
{{else if deliveryFirst}}
DELIVERY FIRST: the fixed deadline is at risk. Name the missing user-visible artifact and its current version; take the shortest safe action that creates or updates it now. Use returned findings to accept completed work, repair the concrete gap or retire a disproved method. Keep independent ready work moving within actual capacity. Preserve the requested scope and fixed deadline; report an infeasible forecast honestly. No automatic paid/model escalation.
{{else if repeated}}
WAIT/STOP REFUSED: reconcile the unfinished critical work using the findings and remedies already reported for this revision. A new estimate alone does not finish it.
{{else}}
WAIT/STOP REFUSED: expected deadline miss / overdue work {{late}}m. Critical path / overdue rows: {{rows}}.
Reconcile the returned worker findings before the next action. Accept valid deliveries, repair the unmet delta or retire a disproved method as failed/superseded with its evidence; carry the still-required outcome into a different viable route.
Use parallel workers only for genuinely independent work and available capacity. Overlap dependencies only with evidence that the consuming work can proceed safely. Update stale estimates from measured remaining work, including acceptance, integration and delivery; retain elapsed history and the fixed due time. If the work cannot fit, report that fact. Do not lower estimates, cut requested scope or move the deadline to make the display look on time.
Optional work may enter the visible, reversible after-deadline set only when it is already optional under the user's goal. Waiting is allowed while every overdue or critical-path row has a live executor with recent activity. Keep other ready work moving; record an exact external blocker for work that cannot proceed. Ask only when missing input or authority changes the next action.
{{/if}}
