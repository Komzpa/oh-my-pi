Dependency wait (retry pressure suspended):
{{#each paths}}- {{this}}
{{/each}}Use task for the dependency-ready root; use todo to record a real hold or repair a missing/cyclic dependency. Keep real output dependencies intact.
