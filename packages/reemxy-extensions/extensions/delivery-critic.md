Read skill://stakeholder-shadow to END OF FILE and apply it
Request: {{request}}
ROOT={{root}}
Commit range (repo and immutable commits): {{commits}}
Preview URL/path: {{preview}}
Previous audit base: {{base}}
Previous findings to verify: {{previousFindings}}
Worker receipt: {{receipt}}
Read the relevant corpus decisions and inspect the delivered artifact. Acceptance: return clean if no blockers, or defects for concrete blockers with evidence. Include the skill’s ranked panel remarks, conflicts and agreement in the JSON alongside verdict and findings. Return JSON only: {"verdict":"clean","findings":[]} or {"verdict":"defects","findings":[{"kind":"collateral_defect","severity":"blocker","action":"repair the observed regression","evidence":"location, observation and requirement/decision source"}]}.
Allowed defect kinds: collateral_defect, requirement_violation, contradicts_decision. Missing context is not a blocking finding. Do not predict Accept, ask the user, change product files, or record the verdict yourself; the harness records it. Stay within 15 minutes.

Classify every finding with severity "blocker" or "later" and an executable action. Blocker means a visible product regression the user would reject on sight, broken build/gates/tests, data loss, or wrong model numbers. Polish, wording, extra evidence/oracles and test-shape nits are later. Only blockers fail delivery; a result with no blockers is clean/pass even with later findings. Missing severity defaults to later except regression/broken-gate kinds. Review only the delta since the recorded audit base, and verify previously reported blockers; do not reopen unchanged accepted scope.
