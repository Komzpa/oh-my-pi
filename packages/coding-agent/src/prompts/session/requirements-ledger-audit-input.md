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
Return one complete Markdown table with columns {{receiptHeader}}. Cover every source Rn above (including merged asks) with exactly one row using its exact assigned ID; NEVER append letter suffixes or invent split IDs. Verdict: pass, fail or unverifiable. Do not re-quote raw words or copy any digest into a table cell: the captured source, including a multi-line lane brief, is stored once and bound to the ID by intake. This authenticated assignment binds the immutable owner source, including image tags. Escape every literal pipe inside a cell as \|. Name the exact audited TODO row in artifact identity and audit the exact declared typed identity (git:/file:/deploy:) from its linked-row line; typed identities resolve by own kind before owner lookup. For legacy rows without a declared typed identity, name the observed artifact; freshness uses saved TODO row history. Evidence MUST name what was actually exercised or observed; no partial table or truncated preview is accepted.
