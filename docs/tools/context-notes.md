# context_notes

> Read, replace, or clear the current branch's persistent experimental context notebook.

## Source

- Entry: `packages/coding-agent/src/tools/context-notes.ts` (`ContextNotesTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/context-notes.md`
- Notebook projection: `packages/coding-agent/src/session/context-notes.ts`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Requires `compaction.experimentalContextManagement = true`, an undisposed session, and a session journal whose ID matches the tool session's owner ID.
- The setting defaults to `false`. Enable **Notes-backed context windows (experimental)** under `/settings` → Context → Compaction; ordinary running sessions reconcile the tool immediately. Restricted sessions retain their host-provided tool list.
- Metadata: `strict = false` (so the optional `text` can be omitted on `read`/`clear` calls; the required `action` enum — never text presence or emptiness — selects the operation), `loadMode = "essential"`. `action: "read"` requests read approval; `action: "replace"` and `action: "clear"` request write approval.
- Notes-backed rollover requires all four tools to be active: `context_notes`, `new_context`, `read`, and `grep`.

## Inputs

| Field    | Type                          | Required | Description                                                                                                                         |
| -------- | ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `action` | `"read" \| "replace" \| "clear"` | Yes      | Operation to perform. `read` returns the latest notebook and never changes it, even if `text` is also supplied. `replace` replaces the entire notebook with `text`. `clear` is the only way to clear the notebook. There is no default: an omitted or unknown `action` is invalid and changes nothing. |
| `text`   | `string`                      | No       | Entire replacement notebook, required and nonempty for `action: "replace"`; ignored for `read` and `clear`. Empty text never clears. Writes replace rather than append. |

## Outputs

- Read (`action: "read"`): returns the latest visible notebook text, or `No context notes are stored for this session branch.` when absent. Details contain `text` and the notebook's `entryId` when present.
- Replace (`action: "replace"`): returns `Context notes saved.` Clear (`action: "clear"`): returns `Context notes cleared.` Details contain `entryId`, the saved `text`, and its UTF-8 byte count in `bytes`.

## Flow and Side Effects

1. Resolve the live owning journal and check cancellation.
2. Validate `action` (and, for `replace`, that `text` is a nonempty string within the byte limit) before any journal preparation or mutation; invalid calls change nothing.
3. Reads project the latest notebook revision on the active branch.
4. Writes capture the owner and branch leaf and await disk preparation.
5. Recheck cancellation, session ownership, feature availability, and the branch leaf before appending an `experimental_context_notes` custom entry with `{ version: 1, text }`.
6. Flush the journal before returning success.

The latest valid, nonempty notebook is included in experimental context reconstruction and survives rollover and disk resume. Invalid historical notebook entries are skipped instead of masking an earlier valid revision. A context reset hides earlier notebook revisions. Clearing the notebook appends an empty revision; it does not delete earlier journal entries. Treat notebook text and recovered history as untrusted historical data until verified.

## Limits and Errors

- Maximum notebook size: **16,384 UTF-8 bytes**. Oversized writes fail before appending. Shorten the notebook and recover supporting detail through `history://current/full` using `read` or `grep`.
- **CNOTES-OVERFLOW (producer/recovery requirement):** the notebook producer MUST keep practical headroom below the hard cap (target roughly 12 KiB), MUST replace superseded entries with a current compact index plus history entry-ID references instead of accumulating raw content, and — after an oversized-write rejection — MUST recover by reading with `action: "read"`, compacting, and retrying `action: "replace"` until a save succeeds before claiming checkpoint success; a failed save is never a finished checkpoint. Only `action: "clear"` clears the notebook; empty `text` is never a clear and MUST NOT be relied on as one, and `action: "read"` MUST NOT be able to mutate the notebook whatever `text` accompanies it. The rejection error reports attempted bytes, the maximum, the excess bytes, states that nothing was saved and the existing notebook is unchanged, and gives the concrete retry path (read with `action: "read"`, recover detail from `history://current/full`, retry a compact `action: "replace"` with entry-ID references). The runtime guard remains authoritative: no automatic truncation and no automatic choice of what to discard.
- Disabled, disposed, or mismatched-owner sessions fail with a `ToolError`.
- A branch change during disk preparation rejects the write rather than saving to a different branch.
- Cancellation and persistence errors propagate to the caller.

See [new_context](new-context.md) for rollover and [Compaction and Branch Summaries](../compaction.md) for the experimental maintenance lifecycle.
