{{#if blocker}}
Continue: rule "same blocker in 3 consecutive yields" is not yet satisfied. Your brief stays the goal. Verify against current state that the blocker is real, and do not yield again until you have worked every part of the brief the blocker does not touch and tried every available safe way around it. Yield with this blocker only if it still stops the remaining work; then state it identically, with its evidence.
{{else}}
{{#if partial}}
Continue: rule "partial without a concrete blocker must continue" triggered. Your brief stays the goal; do not shrink it to what is done so far. Keep working through all remaining requirements in this turn, verifying each as you go, and yield only when every requirement is complete and verified, or a concrete external blocker stops all remaining work. A plan, a status summary or "next I would" is not progress; do the work.
{{else}}
Continue: rule "done requires a completion audit" triggered. Treat completion as unproven: inspect current state against every requirement in the brief. Yield a short list of each requirement with its evidence (command plus output line, commit SHA, or path). If any requirement is missing, incomplete, or unverified, finish all of that work and verify it before yielding; preserve the full scope.
{{/if}}
{{/if}}
