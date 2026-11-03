{{#if missing}}Refused: requirement-editing row {{row}} has no linked verbatim user quote. Link its exact original request in the requirements ledger before dispatch. A PRD paraphrase is not authority.{{else}}
Requirement authority for {{row}} (verbatim user quotes):
{{#each quotes}}
{{this}}
{{/each}}
Edit only what these quotes authorize. Compare every requirement diff hunk to them; widening is a defect. Preserve physical infeasibility conflicts even if a model artefact must not block a control. If the quotes conflict or do not settle a choice, return BLOCKED_BY_CONFLICTING_PRODUCT_CONTRACT with the exact clauses and question for the lead. Do not pick a side.
{{/if}}
{{#if conflict}}Refused: unresolved product contract conflict for {{row}}. The lead must record a quote-bound resolution, or use the existing owner-question path, before dispatching again.{{/if}}

{{#if resolution}}Quote-bound lead resolution: {{resolution}}{{/if}}
