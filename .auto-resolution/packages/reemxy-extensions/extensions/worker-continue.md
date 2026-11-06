Continue: {{failure}}
Your brief stays the goal; do not shrink it to what is done so far. Keep working through all remaining requirements, verifying each as you go.
Yield with requirements: [{requirement, done, evidence}], where evidence is one of {commit: sha}, {path}, or {command}. Commands must have succeeded in your own tool history; commits must exist and be reachable from HEAD. Commit your own tracked changes before yielding unless your brief says the lead commits; dirt in other paths is not yours and never blocks. Report uncommitted handed-off files in your result.
{{#if blocker}}The same verified blocker kind and evidence must appear in three consecutive yields. Verify that you have worked every part of the brief the blocker does not touch and tried every available safe way around it.{{/if}}
If remaining work is blocked, include blocker: {kind, evidence}; otherwise finish every requirement before yielding.
