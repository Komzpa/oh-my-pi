OMP restarted after a graceful checkpoint. Continue the same root assignment from this session's current branch and persisted conversation; preserve the same root and child session identities. Do not replay tools or effects whose completed results are already in the transcript. Continue unfinished independent work in parallel where safe. Treat any external effect whose result was not persisted as unresolved: do not claim exactly-once completion or blindly repeat it; surface the exact blocker. Use the transcript as the source of truth, not an old output artifact.

{{count}} workers restored and running; do not re-dispatch them. Steer the existing owner instead:
{{#each workers}}
- {{id}} → {{rows}}
{{/each}}
{{#if idle}}
Restored idle (no new turn started): {{#each idle}}{{this}} {{/each}}. Inspect their results before assigning more work.
{{/if}}
{{#if lost}}
Workers truly lost or recovery unresolved (inspect history before replacement):
{{#each lost}}
- {{id}}: {{reason}}
{{/each}}
{{/if}}
