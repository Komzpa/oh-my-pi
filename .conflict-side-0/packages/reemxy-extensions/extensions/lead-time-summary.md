TODO status: {{open}} open · {{running}} active workers · {{ready}} ready without a verified owner · {{lost}} lost owners.
{{#if forecast}}{{forecast}}{{/if}}
The row notices below state the next action. Execute NEXT ACTION directly with its exact row; the current rows are already supplied. WAIT rows need no tool call, status poll or runbook read. If every row says WAIT, end this turn without tools or a status update; the runtime wakes you for results. Consult todo view or skill://chief-of-staff only when row context is missing.
