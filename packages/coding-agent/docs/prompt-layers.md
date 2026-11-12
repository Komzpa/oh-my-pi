# Prompt layers

The bundled renderer returns `layers` with the end offsets of `global`, `agent`, and
`project` in `systemPrompt.join("\n\n")`. The project end is the start of dynamic
conversation context. These offsets are recorded during assembly, without parsing
rendered text. Custom SYSTEM templates and caller replacements own their ordering
and are reported as unindexed.

- Global: common coding policy.
- Agent: tool-dependent harness policy, personality, prelude guidance, static memory
  guidance, and the task-agent role.
- Project: instruction closure, skills/rules, task-agent catalog, cwd/repo facts.
- Dynamic: persisted memory/startup messages, spawn context, peer IDs and roster,
  workspace tree, MCP instructions, and the date/cwd reminder.
- Turns: user prompt and subsequent conversation.

Run `OMP_PROMPT_LAYERS=1 omp …` to log one `OMP_PROMPT_LAYERS` record per outgoing
payload in the normal omp log. The flag is off by default; hashing and diagnostic
serialization only run when enabled. No prompt content is logged. Each layer has an
end offset in UTF-16 characters, length, SHA-256, and `ceil(chars / 4)` token estimate.
The log names its coordinate system: system text, JSON of pre-user messages, the
recorded reminder prefix, and JSON of the remaining turns. Tools are a separate
channel with their own length, estimate and hash. These are diagnostics, not native
tokenizer positions or cache-hit measurements. The outgoing payload also gets a hash.
Extension replacements that change the generated system blocks are unindexed.

Anthropic caches tools → system → messages. The final project block gets a cache
breakpoint as well as the preceding cross-project head; the remaining message
breakpoint budget respects the four-breakpoint limit. Different tool sets can
invalidate the prefix before the common system policy. Claude Code OAuth additionally
requires its existing request-dependent billing/attestation block before system
policy; this transport envelope prevents an identical raw system prefix on that path.

Responses uses ordered developer input messages for configured reasoning endpoints,
and joined `instructions` for other endpoints including compatible proxies. Chat
completions preserves ordered system/developer messages or joins them for endpoints
whose templates require one system message (including local Qwen configurations).
Tools remain a separate API field: local chat templates decide whether to place them
before or after system text. Different tool sets and output contracts therefore
limit sharing; the layer index does not pretend to describe a server's hidden template.
