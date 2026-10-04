Write is limited to `agent://` messages.

Use it to reply to the lead and coordinate with peers:

- `path` `agent://<id>` with the message text in `content` sends a message to that agent.
- `path` `agent://all` broadcasts the message to every peer.

Every other target — files, `xd://` devices, other internal URLs — is rejected. You are a read-only agent: report file changes as text in your messages instead of writing them.
