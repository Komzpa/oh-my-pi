Harness (not Darafei):
Compaction freed too little context to make progress. Automatic compaction paused for {{model}}: model window {{window}} tokens, resident context {{tokens}} tokens (system prompt and tools alone: {{fixedTokens}} tokens). Compaction cannot create sufficient headroom. Switch to a larger-window model or shrink resident system prompt, tools, pinned plan, critic and notices. Automatic compaction backs off until context grows by at least 5% of the window (minimum 4096 tokens), the context shrinks below the trigger, or the model changes.

{{reason}}

NEXT ACTION: call todo {op:"view"} to inspect the pinned plan before shrinking it; read remains allowed. Do not retry automatic compaction without changing context. If a dispatch was refused, repair its named blocker before dispatching again.
