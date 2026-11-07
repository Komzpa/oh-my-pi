0 workers running while {{count}} rows need one: {{{rows}}}.
{{#if conflicts}}{{#each conflicts}}Dispatch blocked for {{jsonStringify row}}: {{{reason}}}
{{/each}}Read and todo view stay allowed. Follow the blocking row's NEXT ACTION before dispatching again.
{{else}}NEXT ACTION: dispatch with task {context:"Staff the listed rows",tasks:[{task:<exact row title above>,solutionSpace:<bounded output and acceptance>}]}. Read and todo view stay allowed.{{/if}}
