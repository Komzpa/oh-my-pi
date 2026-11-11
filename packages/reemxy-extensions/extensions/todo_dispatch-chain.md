WAIT-CHAIN REVIEW: {{head}} is CHURN or AUDIT-FAIL and blocks these logical edges:
{{#each edges}}
- {{dependency}} -> {{task}}
{{/each}}
Re-check every edge: does the dependent consume an output it logically needs? A shared file, checkout or browser slot alone is not a dependency. Remove slot-only edges and dispatch independent rows in parallel isolated worktrees (task isolated:true). Preserve real output dependencies.
The next turns must remove a reviewed waits edge or dispatch an independent dependent. Retrying the head, owner changes, estimates, reads and prose do not satisfy this demand. To reject the proposed parallelization, use todo op:schedule on the head with evidence starting "Dependency review {{key}}:" and a separate line "dependent <- prerequisite: concrete logical output needed" explanation for every edge above. A slot-only explanation must instead remove the edge. Rejection is retained with the exact graph; a changed graph requires fresh review.
