WORKER ASK — answer before any dispatcher wake or time note.
{{#each questions}}
Worker: {{worker}}
Question: {{question}}
Proposed default: {{proposedDefault}}
Write agent://{{worker}} with `Answer to {{id}} [{{questionId}}]: <answer>` (an explicit reject is also an answer). Prose, unrelated tools, and re-dispatch do not answer this ask.
{{/each}}
