Pending question {{id}}{{#if sessionId}} in session {{sessionId}}{{/if}}.
{{#each questions}}

[{{id}}] {{question}}
{{#each options}}
- {{label}}{{#if description}}: {{description}}{{/if}}
{{/each}}
{{/each}}

Interactive hosts open the HTML form without blocking independent work. Explicit submission sends normal user-chat replies as `Answer to <tool-call-id> [<field-name>]: <answer>`. You may instead reply in this session's normal chat, mentioning the field name when needed. Custom answers are welcome.
No answer or approval has been received. Continue independent work; only actions depending on this answer must wait. Do not treat silence, a recommendation, or a timeout as consent.

For a worker: remain parked until the lead answers; do not report this as a terminal blocker or restart the assignment. Supply a recommended option as your proposed default. If your original brief explicitly contains `[worker-ask-defaults]`, state "I will do <recommended option> unless told otherwise"; the driver applies it after OMP_WORKER_ASK_DEFAULT_WAIT_MS (default 10 minutes) and records the application. Without that authorization there is no automatic default.
