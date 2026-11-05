Handoff pending. Publish one batch of delivered-change cards via skill://review-questions-page on :8767 for all named rows, then set each row’s reviewPage URL.
{{#if missingRow}}You are waiting on the user. Record the decision as a todo row with review: user and publish its review page (one card per decision, accept/redo/drop), or keep working.{{else}}Publish a working review page for every user decision, then set its todo schedule.reviewPage URL. Each page needs one card per decision with accept/redo/drop.
{{#each failed}}Row {{row}}: {{status}}{{#if url}} ({{url}}){{/if}}.
{{/each}}{{/if}}
