{{#if red}}
Staff or verify {{{first}}}: ready work lacks a distinct running worker.
{{#each red}}
- {{{content}}}{{#if owner}} (owner={{{owner}}} is not running){{/if}}: {{#if completed}}verify the result and close with todo done, or set review:"user" with a visible reviewPage preview{{else}}restaff with task or reassign in todo schedule ({{outcome}}){{/if}}.
{{/each}}
Re-plan with todo schedule and measured estimates, or visibly drop optional scope with a reason.
{{/if}}
{{#if preview}}
Refusing idle/wait: preview is overdue for {{{preview}}}. Land the partial change in the preview checkout now, or record todo previewReason kind=deferred with a reason and deferUntil=<future Unix milliseconds>.
{{/if}}
