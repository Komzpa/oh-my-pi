{{#each churn}}
CHURN: {{row}} ({{reestimates}} re-estimates, {{failures}} failed attempts). Change approach now: split or cut scope, parallelize independent work, or escalate the acceptance failure. Do not retry the same approach.
{{/each}}
{{#if slipped}}
PLAN SLIPPED by {{slipMinutes}}m against the anchored deadline. Replan now: split/cut/parallelize the remaining rows or escalate.
{{#each questions}}
URGENCY: {{worker}} is blocked on the lead: {{question}}. Answer this question now within existing authority, or escalate the exact permission needed. Waiting alone does not recover the slip.
{{/each}}
{{/if}}
