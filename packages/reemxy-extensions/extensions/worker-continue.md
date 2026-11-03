{{#if blocker}}
Continue: rule "same blocker in 3 consecutive yields" is not yet satisfied. Verify the blocker is real and try one concrete alternative; if it persists, yield again with the same blocker and its evidence.
{{else}}
{{#if partial}}
Continue: rule "partial without a concrete blocker must continue" triggered. Take the next concrete step toward the full brief, run the relevant checks, and finish the requested deliverables before yielding.
{{else}}
Continue: rule "done requires a completion audit" triggered. Treat completion as unproven: inspect current state against every requirement in the brief. Yield a short list of each requirement with its evidence (command plus output line, commit SHA, or path). If any requirement is missing, incomplete, or unverified, do that work and verify it before yielding; preserve the full scope.
{{/if}}
{{/if}}
