Pending question {{id}}{{#if sessionId}} in session {{sessionId}}{{/if}}.
{{#each questions}}

[{{id}}] {{question}}
{{#each options}}
- {{label}}{{#if description}}: {{description}}{{/if}}
{{/each}}
{{/each}}

Interactive TUI sessions also open a keyboard selector for each question; choosing an option (or typing a custom answer with “Other”) sends a normal user-chat reply. You may instead reply in this session's normal chat, mentioning the question ID when needed. Custom answers are welcome.
No answer or approval has been received. Continue independent work; only actions depending on this answer must wait. Do not treat silence, a recommendation, or a timeout as consent.
