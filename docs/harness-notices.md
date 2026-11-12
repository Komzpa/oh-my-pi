# Harness notice channel

`harnessNotices.role` selects `user`, `developer`, `tool`, or `off-legacy`.
`off-legacy` preserves existing conversion. External content from files, commands,
web pages, MCP and subagents remains tool output. Harness notices carry the label
`Harness (not Darafei):`.

When unset, catalog KDL selects `user` for `gpt-6.1` and `gpt-6.1-*` on OpenAI
Responses or Codex Responses, including custom codex-lb providers. Other models
retain legacy behavior. Explicit `off-legacy` disables this default.

```yaml
harnessNotices:
  role: off-legacy
  overrides:
    - provider: openai
      class: openai
      family: gpt
      role: user
    - provider: codex-lb
      models: [gpt-6.1-sol]
      role: developer
    - models: [claude-*]
      role: tool
```

Scoped overrides win over the explicit global role, which wins over the catalog
default. Selectors reuse the catalog cascade: exact model IDs outrank globs,
then more constrained dimensions win, then higher integer `priority`. Equal-rank
rules are errors; use `priority` for intentional overlaps. Array order does not
break ties. Provider selectors use `providerType` when present, otherwise the
credential-bearing provider ID. Class and family use catalog taxonomy. Models
accept exact provider-relative IDs or anchored `*` globs and use catalog wire-ID
fallback. These are the runtime selector rules used by the KDL policy engine;
configuration does not introduce a separate matching language.

The role is resolved against each request's model and settings. Model switches,
retry fallbacks and subagent models therefore get their own channel. SDK callers
can change settings through `cfgHarnessNoticeRole` and
`cfgHarnessNoticeOverrides` without restarting the session.
