# Subagent peer awareness

Enable in project or user `config.yml`:

```yaml
task:
  peerAwareness: true
  structured: true
```

`peerAwareness` defaults to `false`. `structured: true` enables the yield
tool and its explicit agreement entries; unstructured children can resolve
clashes through messaging or peer completion. Awareness adds task/profile/scope context to the
spawn roster, coalesced sibling join/leave notices, structural clash notices,
and a handover check. Known writer overlap must still be resolved by the lead
before dispatch; peer messages do not release declared ownership.

Pass ownership as `scope` on each task item. Copy these fields from the brief
and todo schedule rather than leaving them only in prose:

```json
{
  "name": "Review",
  "agent": "reviewer",
  "task": "Review the rendering changes",
  "scope": {
    "root": "/work/review",
    "branch": "review-rendering",
    "paths": ["evidence/review"],
    "resources": ["review-checkout"],
    "ports": [43001]
  }
}
```

`root` anchors relative paths; it does not reserve the whole checkout. Use
`paths: ["."]` to declare ownership of the whole root. Isolation replaces root
with the actual child worktree. Task text is capped at 160 characters, profile
at 80, and scope display at 600; the existing roster cap still applies. A
notice displays at most 20 changes. Activity updates alone produce no notice.

Successful write/edit hooks, shell output redirections, Git changes since
startup, and actual listening TCP sockets provide touched resources. In a
shared checkout, Git status only corroborates declared paths; direct tool
writes remain attributable outside that scope. Branch changes are tracked in
exclusive worktrees; shared-checkout HEAD changes cannot be assigned to a
worker from Git state alone. Socket attribution uses Linux `/proc`;
other platforms still support declared ports and path/branch observations.
Commands and task prose are never scanned for ownership or port guesses.

A clash names `agent://<peer>` and its canonical resource, such as
`path:/work/review/evidence/out.png` or `port:43001`. Final yield is refused
while a clash is unresolved. It clears after successful direct messages in
both directions after detection (progress and broadcasts do not count), when
the peer stops running, or with a matching entry in the yield arguments:

```json
{
  "data": {"done": true},
  "deconfliction": [{
    "peer": "Review",
    "resource": "port:43001",
    "agreement": "Review moved its server to 43002"
  }]
}
```

The lead receives these entries in the task result's `deconfliction` field
and rendered result summary. Restored children retain declared scope and
install the monitor only when the current setting is enabled.
