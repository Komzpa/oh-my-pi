Pending question {{id}}{{#if sessionId}} in session {{sessionId}}{{/if}}.
{{#each questions}}

[{{id}}] {{question}}
{{#each options}}
- {{label}}{{#if description}}: {{description}}{{/if}}
{{/each}}
{{/each}}

Interactive TUI sessions also open a rich ask dialog for the questions; choosing an option (with an optional note) or typing a custom answer sends a normal user-chat reply in the form `Answer to <tool-call-id> [<question-id>]: <answer> — note: <text>`. You may instead reply in this session's normal chat, mentioning the question ID when needed. Custom answers are welcome.
No answer or approval has been received. Continue independent work; only actions depending on this answer must wait. Do not treat silence, a recommendation, or a timeout as consent.
