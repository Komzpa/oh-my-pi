Isolated workers need re-dispatch after restart. Their work was saved before teardown:
{{#each workers}}
- {{name}} (worker {{id}}; {{row}}): {{snapshotPath}}. Original workspace: {{cwd}}.
{{/each}}
Restore the snapshot into an isolated workspace and re-dispatch the assignment from its persisted transcript. Do not silently drop these rows.
