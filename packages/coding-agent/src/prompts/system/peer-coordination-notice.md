{{#if refusal}}Handover refused: resolve these shared resources before submitting again.{{/if}}
{{#each updates}}
Peer {{kind}}: agent://{{peer}}{{#if task}}; task={{task}}; scope={{scope}}{{/if}}{{#if resource}}; resource={{resource}}. Agree with this peer before handing back. Send a direct message and receive its reply, or include deconfliction: [{peer: "{{peer}}", resource: "{{resource}}", agreement: "what you agreed"}] with your yield.{{/if}}
{{/each}}
{{#if omitted}}{{omitted}} more peer changes omitted.{{/if}}
Peer messages do not release declared writer ownership. The lead must still resolve known overlap before dispatch.
