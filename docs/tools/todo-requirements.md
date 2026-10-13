# todo requirement ledger

The requirement ledger extends the [todo tool](todo.md) with classification, authenticated audit receipts, and user-owned pending checks.

## Source

- Tool: `packages/coding-agent/src/tools/todo.ts`
- Runtime gates: `packages/coding-agent/src/session/requirements-ledger-runtime.ts`
- Ledger: `packages/coding-agent/src/tools/requirements-ledger.ts`
- Model-facing requirement supplement: `packages/coding-agent/src/prompts/tools/todo-requirements.md`, appended to the shared `packages/coding-agent/src/prompts/tools/todo.md` description.

## Same-turn requirement classification

Every new main-session user message that creates an unclassified requirement candidate gates mutating tool calls in that same turn; the `todo` tool remains available to classify it. Bare approval replies are exempt: a message that is only `go`, `ok`, `да`, or `продолжай` (whitespace-normalized) with no images is ignored, creating no requirement or gate and allocating no requirement ID.

## Requirement completion gate

Native `todo done`, `/todo done`, and assistant publication share `evaluateRequirementDoneGate` in `requirements-ledger.ts`. A row needs a fresh authenticated `qa-auditor` pass for every requirement linked to that row, not passes for unrelated linked rows. Receipts are saved per row with their receive time; a later receipt for another row cannot replace them. Legacy all-row receipts remain readable and are projected onto their corresponding artifacts.

Receipts use exactly one row per assigned requirement ID; letter-suffixed sub-IDs are rejected rather than aggregated. An explicit row label binds the receipt to that row. Clean checkouts require the audited commit identity; rows without a clean checkout use the receive time and the last saved todo-row change. Completion itself does not invalidate its approving receipt, but reopening or changing the row does. A blocked completion offers one audit retry per row, with that row's exact linked IDs and current artifact identity.

An explicit resource checkout takes precedence over the auditor's session cwd. Without a resource path, a saved artifact checkout for the current row owner takes precedence over that owner's cwd. This keeps a clean worktree auditable even when the auditor runs from a different, dirty checkout. A multi-row artifact cell such as `Row @ sha; Other row @ sha` is scoped to each named row before its receipt is saved or compared. Markdown `<br>` line breaks in the raw-words cell are decoded as newlines; changing the user's words still invalidates the receipt.

Artifact freshness refusals include the resolved checkout's cwd, HEAD and dirty state, or the reason its checkout identity is unavailable. A file resource such as an installed executable is identified by its current streamed SHA-256 instead. Moving the resource worktree or changing the binary after receipt invalidates the old pass.

Freshness uses `getRequirementVerdictStaleness` (`null` when fresh); receipt intake, completion refusals, and hidden publication notices name the exact failing check rather than a generic artifact mismatch. Reasons distinguish unresolved artifact/cwd mapping, row scope or duplicates, missing/non-pass verdicts, unauthenticated auditors, file SHA-256 ambiguity/mismatch or dirty file artifacts, invalid/stale HEAD, missing/uncited/older saved TODO changes, and missing/invalid receipt or invalid saved-change timestamps. Clean checkout receipts must cite exactly the current row HEAD, never an obsolete dispatch-time HEAD. Dirty/headless rows retain saved-row-history freshness only after artifact resolution succeeds. Raw words are compared before artifact identity against the whitespace-normalized complete immutable ask; diagnostics give the requirement ID, normalized lengths, and zero-based first differing character without quoting source text. A dropped `[Image #N]` prefix reports raw words at character 0 even when the file SHA matches.

When a merge target is missing, self, unknown, or inactive, the diagnostic lists only available linked targets as `Available active merge targets: ["Rn"]` beside a non-executable merged placeholder without choosing one; with no linked target it offers source linking or not-a-requirement with row creation instead.

## User-owned pending checks

`block` additionally accepts `awaitingUser: { action: string; ids?: string[] }`. The action must not be blank; omit this field for agent-owned blockers. It is saved as row metadata without verifying completion. `unblock` clears both the blocker note and pending user check.

For a check only the user can perform, record `todo` with `op="block", task="<exact row>", awaitingUser={"action":"Press Archive on both cards","ids":["card-a","card-b"]}`. The publication gate shows that action once, then stays quiet on agent turns until the next user message. The notice is saved on the session branch, so resuming does not repeat it. New user messages re-evaluate the current check; changed checks are announced again. Ordinary agent-owned unverified rows still block on every attempt, including when another row awaits the user.

An awaiting-user check is never evidence of completion: native and slash `todo done` stay blocked. After the user explicitly confirms the action, use `unblock` to clear the check; the row still needs a fresh authenticated audit. Alternatively, a fresh `qa-auditor` pass received after the check was recorded can satisfy it if its artifact is current. Do not infer confirmation merely from a new message or from recording `awaitingUser`.

## Read-only amendment history

Read-only views append relink amendment history from that tool instance's session manager only (requirement id, timestamp, old/new rows, and reason), without writing a ledger snapshot.
