{{#if red}}
Refusing idle/wait: open rows need a live owner: {{{red}}}. In one call, staff it with task; re-plan it with todo schedule and a new estimate/date; hand it to the user with todo op="block", task=<exact row>, reason=<user action>, missionCritical=<why their action is required>; or drop it with todo op="drop", task=<exact row>, reason=<why>.
{{/if}}
{{#if preview}}
Refusing idle/wait: preview is overdue for {{{preview}}}. Land the partial change in the preview checkout now, or record todo previewReason kind=deferred with a reason and deferUntil=<future Unix milliseconds>.
{{/if}}
