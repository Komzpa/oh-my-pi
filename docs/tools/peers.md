# Peers

Use `peers` to list active local OMP sessions or send a message to one.

## List sessions

```json
{"action":"list"}
```

The result includes each session's id, title, working directory, main agent,
and available agent ids. Busy sessions remain visible with their last known
details.

## Send a message

```json
{"action":"send","target":"<session id, unique prefix, cwd, or title>","message":"<text>","agent":"<optional agent id>"}
```

Plain text is queued durably before delivery when the target is busy. A
registered slash command is executed by the target session and reports whether
it executed or was queued. Unknown slash names are delivered as ordinary
messages. Interactive commands can return a failure reason.

Messages from a session can be answered with `write` to
`agent://peer:<senderSessionId>`.
