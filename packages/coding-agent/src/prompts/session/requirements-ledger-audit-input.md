QA AUDIT INPUT (original user words; merged sources retain their own Rn):
{{#each sources}}
{{this}}
{{/each}}
{{#if imageLines.length}}
Referenced images (Rn, sha256, source):
{{#each imageLines}}
{{this}}
{{/each}}
{{/if}}
Linked-row exact typed identities (git:/file:/deploy: resolve by own kind before owner lookup):
{{#each rowHeads}}
{{this}}
{{/each}}
Return one complete Markdown table with columns {{receiptHeader}}. Cover every linked Rn above with exactly one row using its exact assigned ID; NEVER append letter suffixes or invent split IDs. Verdict: pass, fail or unverifiable. Copy raw words character for character from the audit input. Escape every literal pipe inside a cell as \|. Name the exact audited TODO row in artifact identity and audit the exact declared typed identity (git:/file:/deploy:) from its linked-row line; typed identities resolve by own kind before owner lookup. For legacy rows without a declared typed identity, name the observed artifact; freshness uses saved TODO row history. Evidence MUST name what was actually exercised or observed; no partial table or truncated preview is accepted. Rows for unrelated parent IDs are ignored; additional IDs are recorded only when assigned to this same TODO row. A newly accepted receipt for the current artifact supersedes the prior verdict for that row, including fail → pass. When the task states a number or count to verify, add columns claimed | measured with the task's figure and your own recount in the same units; a differing pair is recorded as fail.
