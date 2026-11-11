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
{{#if baseLines.length}}
Git comparison bases (shared with the rendered-file diff check):
{{#each baseLines}}
{{this}}
{{/each}}
{{/if}}
Return one complete Markdown table with columns {{receiptHeader}}. Cover every exact parent ID assigned by requirementIds with one row. Source words and merged asks above are context bound to those parents, not additional assignments; NEVER append letter suffixes or invent split IDs. Verdict: pass, fail or unverifiable. Do not re-quote raw words or copy any digest into a table cell: the captured source, including a multi-line lane brief, is stored once and bound to the ID by intake. This authenticated assignment binds the immutable owner source, including image tags. Escape every literal pipe inside a cell as \|. Name the exact audited TODO row in artifact identity and audit the exact declared typed identity (git:/file:/deploy:) from its linked-row line; typed identities resolve by own kind before owner lookup. For legacy rows without a declared typed identity, name the observed artifact; freshness uses saved TODO row history. Evidence MUST name what was actually exercised or observed; no partial table or truncated preview is accepted.

If an image appears in your tool results, evidence names an existing screenshot, or the artifact diff touches rendered files, compare the same view, state and width before and after. Use the supplied Git base in a disposable detached worktree (`git worktree add --detach <tmp> <base>`), build and run it on its own port, then remove it (`git worktree remove <tmp>`). Never check out the base in the artifact checkout. Capture default and 420–450 px widths, crop each pair to the changed region including siblings, and judge what got worse plus defects in new elements. After the verdict table and a blank line, return `| before | after | region | defect |`, with existing before/after crop paths and `none` for a clean pair. Identical bytes and after-only receipts are rejected. If the base cannot be built, declare `Base: unbuildable (<reason>)` with the exact failed command and error, and use `before: unavailable (<reason>)` with the same reason in the before cell; retain the existing after path. This limitation remains visible to the lead. Collateral defects block closure until rework and re-audit or explicit follow-up TODO rows.
