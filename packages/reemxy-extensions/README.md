# Reemxy extensions

## Presence settings

`goal_deadlines` derives the user’s timezone from persisted goal state (`state.timezone`), then falls back to the process `Intl` timezone.

Optional `reemxyPresence` is the package’s single settings key. Put it in OMP user or project settings; project fields override user fields:

```yaml
reemxyPresence:
  activeMinutes: 15
  awayMinutes: 30
  quietStartHour: 23
  quietEndHour: 9
  atRiskMinutes: 60
```

Hours are normalized to `0..23`; absent or invalid fields retain defaults.

## Bounded worker supervision

Every row-executing profile must target about 15 minutes of work. If an assignment clearly will not fit or context approaches compaction, the worker stops at the next checkable result, reports completed work with a receipt, and proposes a split of what remains.

`todo_dispatch` must issue a non-blocking PLAN CHECK once per active worker when its child session compacts or its run exceeds 15 minutes. The notice identifies the worker and condition, asks the lead to request done/left through `write agent://<id>`, then split the remainder. A ten-minute worker without compaction must not be named; the silent-15-minute notice remains independent. The oracles are `agent_router.test.ts` and `todo_dispatch.gates.test.ts`.
