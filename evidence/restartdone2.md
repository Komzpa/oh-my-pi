# Restart completion provider proof (#93)

Baseline: `c81f5644b1c8c6e8a0ef427102e5b2d0f2a4d15d`. Candidate: the commit containing this report.
Local observation and fixture times: UTC+04, 2026-11-08.

## Cause and correction to the initial premise

A bounded seek of the last 200 MB of the named DC journal (never a whole-file load) found:

- `49bf92a6`: completed transition, successor instance `3f525c70`, 03:29:45.708.
- `e89a1aa1`: continuation-claimed, 03:29:46.558.
- `f1ca5907`: restart-root-continuation, 03:29:46.923, naming build `92feb15cca219dbd1e4212b45dfaf3ade57efde9460201215cf772f8993d36e6`.
- `a4e69960`: continuation-delivered, 03:29:46.936.
- Later file-order entry `4ba075a2`: restored queued notice, retaining its original 03:28:56.397 timestamp.

Thus journal parsing, instance comparison, successor handoff and child recovery ran. The missing-receipt premise resulted from inspecting too small a tail. Durable delivery did not prove provider delivery. The fixture proves the actual gap: saved next-turn input can auto-start a provider request before interactive restore; the SDK main-loop transform bypassed the restart filter used by side requests. Live terminal notices were nextTurn/asides, which a steering-only text loop does not poll.

## Fix

Hold restored queue auto-drain while the handoff awaits terminal continuation. Use the same restart filter in the SDK main loop and side requests. Persist terminal notices immediately and reconcile old hold messages; include a terminal notice in already-captured provider snapshots. Publish the short continuation before goal restoration can launch work. Failures also notify the root and children.

## Isolated fixture

`test/fixtures/restart-completion-provider.py` creates a private HOME, agent directory, XDG directories and `XDG_RUNTIME_DIR`, plus a unique `tmux -L restartdone2-<pid>` server. It copies a synthetic seed session directory to `copy`, opens that copy through the real SDK and InteractiveMode, then calls the source CLI `restart request --instance <exact-fixture-id> --request-id fixture-pending-N --json`. No live restart endpoint is discovered or contacted. The real exec preserves PID and session UUID and changes instance ID. Only the provider transport is mocked, with exact provider context captured at streamFn. The test hooks resolveCliEntryCmd back to the fixture host and inserts pending input at beginRestartDrain. No installed binary is changed. The fixture server is killed in finally.

Control: idle root, no pending input. Regression: pending input, a running root with saved user steering (`rootWasRunning:true`). Both are covered after the fix. The original idle+pending reproduction is retained too. This is a synthetic copied directory, not a copy of the private 3.7 GB DC history.

The complete ordered provider contexts and control snapshots are in [restartdone2-provider.json](restartdone2-provider.json). Below is the exact first-request role/content order (timestamps and non-content metadata remain in JSON).

### base_pending_idle

PID 3972667; rootWasRunning=false; final state=completed.

```json
[
	{
		"role": "user",
		"content": "<system-reminder>\nToday: 2026-11-08; current working directory: '/tmp/restartdone2-base-3'. Do not repeat this information in your reply.\n</system-reminder>\n\nContinue fixture plan"
	},
	{
		"role": "user",
		"content": [
			{
				"type": "text",
				"text": "Harness (not Darafei): Restart fixture-pending-1 is queued. The visible text of each restart-queue notice states its requestId and state; follow the visible state. If the state is queued, draining, checkpointed, or restarting, finish the provider call and tool batch already in progress, then checkpoint this session's current assignment in its durable transcript. Do not start another model turn, emit new tools, spawn or wake agents, or claim the whole goal is complete. Report unresolved external effects or missing receipts as explicit blockers; never infer completion when an effect result was not persisted. The controller will restart the process after the current work is safe. If the state is completed, cancelled, or failed, the earlier restriction for that requestId no longer applies: resume normal work without preparing or issuing a restart."
			}
		]
	},
	{
		"role": "developer",
		"content": [
			{
				"type": "text",
				"text": "Pending fixture context"
			}
		]
	}
]
```

### fixed_pending_running

PID 4043690; rootWasRunning=true; final state=completed.

```json
[
	{
		"role": "user",
		"content": "<system-reminder>\nToday: 2026-11-08; current working directory: '/tmp/restartdone2-proof-busy'. Do not repeat this information in your reply.\n</system-reminder>\n\nContinue fixture plan"
	},
	{
		"role": "user",
		"content": [
			{
				"type": "text",
				"text": "Active text-only plan"
			}
		]
	},
	{
		"role": "assistant",
		"content": [
			{
				"type": "text",
				"text": "fixture plan resumed"
			}
		]
	},
	{
		"role": "user",
		"content": "Steering text-only iteration"
	},
	{
		"role": "user",
		"content": [
			{
				"type": "text",
				"text": "Harness (not Darafei): Restart fixture-pending-1 completed at 03:51; build c81f5644b1c8c6e8a0ef427102e5b2d0f2a4d15d; nothing pending — resume your plan."
			}
		]
	}
]
```

### fixed_idle

PID 4044967; rootWasRunning=false; final state=completed.

```json
[
	{
		"role": "user",
		"content": "<system-reminder>\nToday: 2026-11-08; current working directory: '/tmp/restartdone2-proof-idle'. Do not repeat this information in your reply.\n</system-reminder>\n\nContinue fixture plan"
	},
	{
		"role": "user",
		"content": [
			{
				"type": "text",
				"text": "Harness (not Darafei): Restart fixture-pending-0 completed at 03:51; build c81f5644b1c8c6e8a0ef427102e5b2d0f2a4d15d; nothing pending — resume your plan."
			}
		]
	}
]
```

## Regression receipts

- On baseline, `bun test packages/coding-agent/test/restart-completion-provider.test.ts`: 1 pass (idle), 1 fail (running + pending); the first successor request contains the queued hold instead of the short completion.
- On baseline, `bun test packages/coding-agent/test/agent-session-restart-queue-roundtrip.test.ts --test-name-pattern 'next text-only'`: 0 pass, 3 fail. Completed, cancelled and failed terminal notices are absent from the second provider request.
- Candidate: both full exec cases and all three text-only steering cases pass. Tests assert PID/session preservation, changed instance, rootWasRunning, exactly one user-role short completion on the first successor request, absence of queued hold from every successor request, and preservation of pending input. Text-loop tests inspect the immediately following provider call, without tools.
- `bun install --frozen-lockfile`: exit 0. Existing native addon used (not missing), SHA256 `cfe5c35260eb9e1131f1ab4ff0c2137d83d5ba789acb9076470e9fc8023360e3`.
- Final focused suite and `bun check`: see final validation below.

## Judgment receipts

`lane_ask.py` with the authorized brief returned:

1. `DECISION: YES — reproduce the provider ordering/filter race with an isolated fixture, fix that boundary, and retain the exact new facts in the evidence.`
2. `DECISION: YES — proceed with the proposed #93 sites and run the full stack_check.` It explicitly required covering the text-only steering loop from the brief addendum; the three live terminal tests do so.

The owner remains #93; #92 and installed/live state are unchanged. No install was attempted.

A third lane_ask review of the production diff, harness corrections and this report returned: `DECISION: YES — the fix preserves the required provider-boundary behavior, so finish the checks, commit, run stack_check, and push the owned #93 branch as authorized.`

Legacy harness corrections preserve their assertions: roundtrip tests now always use the production AgentSession provider conversion, the main-root continuation test registers its root, and manual-resume recovery mocks implement sendRestartNotice. The interruptible tool test remains an embedded session and still asserts both tools finish, neither is aborted, and the next request contains terminal state.

Fixture build labels are the checkout HEAD at probe time (c81f5644); corrected probes ran the candidate source edits before committing. No installed-build claim is inferred from those labels.

## Publication target and rollback reference

Only `fork` (`Komzpa/oh-my-pi`), `refs/heads/topic/rt-restart-queue`, replacing `c81f5644b1c8c6e8a0ef427102e5b2d0f2a4d15d` with the new descendant under the user-supplied exact lease. The prior head is retained as the rollback reference. No main branch, upstream target, PR comment, installation, or live restart is part of this publication.


## Final validation

- Focused command: `bun test packages/coding-agent/test/restart-completion-provider.test.ts packages/coding-agent/test/agent-session-restart-queue-roundtrip.test.ts packages/coding-agent/test/task/restart-queue.test.ts packages/coding-agent/test/task/restart-recovery.test.ts packages/coding-agent/test/interactive-mode-restart.test.ts`: **109 pass, 0 fail, 567 assertions**, 102.54 seconds.
- After adding the Linux/tmux/python availability guard to the process fixture, repeated that file: **2 pass, 0 fail, 25 assertions**, 9.48 seconds. Neither case was skipped here.
- Final `bun check`: **exit 0**, including Rust checks; only the existing `pi-builtins` unused `tempfile` dependency warning.
- `git diff --check`: **exit 0**.
- Publication is gated separately on the prescribed stack check of the committed candidate and the exact remote lease.
