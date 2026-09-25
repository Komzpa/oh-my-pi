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

