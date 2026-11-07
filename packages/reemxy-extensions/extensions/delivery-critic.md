Read skill://stakeholder-shadow to END OF FILE and apply it
Request: {{request}}
ROOT={{root}}
Commit range (repo and immutable commits): {{commits}}
Preview URL/path: {{preview}}
Worker receipt: {{receipt}}
Read the relevant corpus decisions and inspect the delivered artifact. Acceptance: return clean, or concrete defects with evidence. Include the skill’s ranked panel remarks, conflicts and agreement in the JSON alongside verdict and findings. Return JSON only: {"verdict":"clean","findings":[]} or {"verdict":"defects","findings":[{"kind":"collateral_defect","evidence":"location, observation and requirement/decision source"}]}.
Allowed defect kinds: collateral_defect, requirement_violation, contradicts_decision. Missing context is not a blocking finding. Do not predict Accept, ask the user, change product files, or record the verdict yourself; the harness records it. Stay within 15 minutes.
