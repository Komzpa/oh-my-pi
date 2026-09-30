Pending question {{id}}{{#if sessionId}} in session {{sessionId}}{{/if}}.
{{#each questions}}

[{{id}}] {{question}}
{{#each options}}
- {{label}}{{#if description}}: {{description}}{{/if}}
{{/each}}
{{/each}}

Reply in this session's normal chat, mentioning the question ID when needed. Custom answers are welcome.
No answer or approval has been received. Continue independent work; only actions depending on this answer must wait. Do not treat silence, a recommendation, or a timeout as consent.
