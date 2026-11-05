# Instruction refresh

OMP tracks the content hash and loaded text of prompt context files, invoked skills,
including files expanded through `@file` imports, and `SKILL.md`, `AGENTS.md`, or `AGENTS.override.md` files opened by `read` or the
embedded shell filesystem. Catalog descriptions alone do not count as loading a skill.
External programs that open files themselves bypass the embedded shell filesystem.

Before every model request, OMP compares modification time and size, hashing only
changed files. A changed version adds a system instruction that supersedes the old
copy. Up to 16 KiB is sent as expanded full text; larger files receive a short
notice requiring a complete re-read. Only the latest notice per file is retained.
This remains usable after compaction without an earlier diff baseline.
Unchanged content produces no new notice. The journal stores hashes and
secret-obfuscated notices, never raw loaded bodies, across restart/resume.

The feature is enabled by default. Configuration in `config.yml`:

```yaml
instructionRefresh:
  enabled: true
  maxBytes: 16384
  subagentMinAgeMs: 300000
```

Set `instructionRefresh.enabled: false` to disable it. Main sessions refresh from
their first request; child sessions wait until five minutes old by default. Missing
files retain their loaded version and are checked again on later requests.
