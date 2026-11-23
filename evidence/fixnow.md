# FIX NOW delivery and reply wait recovery — 2026-11-08

Raw objective: `../brief.md`. Sole writer of fork PR #92. Starting and rollback head
`66c38306f7d7a69729152ca9b1a2c1c9c9e820f9`; source commit
`e5b2add56ed99db1b08b6a4890469732bef64fad`. Whole existing history preserved.
Target: Komzpa/oh-my-pi `topic/rt-agent-runtime-core`. No install, updater,
protected config/session writes, live process changes, desktop, DC checkout,
upstream or main mutation. `but status` refused the linked worktree; used the
skill's worktree-local Git exception. No PR body/comment changes.

## What reaches the provider

Read-only source journal: DC session `01a1921c-7697-72a8-b4a3-4efdbbf06221`.
`../dc-window.json` freezes entries timestamped 2026-11-07 21:01–21:40:59 UTC.
`../measure.ts` builds its selected branch with the real `buildSessionContext`,
using the last message leaf `f95599ce` (21:40:28.561Z), then calls the actual
extension context hook, `convertWithHarnessNotices(..., "user", convertToLlm)`
and Responses `buildParams` for bundled gpt-6.1-terra. The catalog's
`resolveHarnessNoticeRole` returns user for this model; the read-only installed
config has only a Haiku override, so it does not change this default.

This is a request reconstruction, not a capture of an HTTP request sent in the
old session: its missing prefix precedes the frozen window, live worker state is
an empty disposable snapshot, tools/system scaffolding are omitted, and the
baseline hook uses today's copied plan/time. The full 3.5 GB archive exceeded
Bun's string limit; no archive was changed. Explicitly selecting the message leaf
avoids an unrelated appended custom entry selecting an empty branch.

Counts below are literal occurrences of `FIX NOW:` in one request body; wire
roles are OpenAI Responses message role or function_call_output. The archived
context is separately measured so the source-hook replay cannot masquerade as
an original captured provider request.

| Input | function_call_output | user | Total | Compact JSON UTF-8 bytes |
| --- | ---: | ---: | ---: | ---: |
| Archived copied branch, before today's source hook | 38 | 0 | 38 | 832716 |
| Baseline source hook on that copy | 80 | 77 | 157 | 879444 |
| Fixed source hook on that copy | 0 | 1 | 1 | 820358 |

The archived 38 are separate, unmarked legacy text parts, so structural
harnessNotice-only removal missed them. The source-hook replay also appended
FIX NOW to custom notices; their legacy conversion creates further tool outputs.
The candidate removes tagged FIX NOW and the exact old standalone numbered
late-plan list; ordinary external content mentioning FIX NOW survives.

Exact request bytes (pretty JSON, including whitespace) are retained in
`../request-archived.json`, `../request-before.json`, `../request-after.json`;
`../SHA256SUMS` records byte sizes and SHA256. Reproducer and counts:
`../measure.ts`, `../measurement-final.log`. No reconstructed request was sent.

## Repair and limits

The context hook appends one final user-role `Harness (not Darafei)` message only
when the defect identity set changes. Delivery identities are append-only custom
entries, surviving extension recreation. Minute values are absent from both the
identity and the executable call. Tool-result hooks no longer append FIX NOW;
old custom tails and supervisor copies are removed at the request boundary.

Late deadline and churn each name a complete `ask` call, including the owning row
in the churn question and schema-valid choices. The chief cannot rewrite the
user deadline via todo; asking the owner is the existing executable remedy.
A successful matching ask acknowledges those defects durably (batched questions
and argument key order are supported); failed calls do not. A changed baseline
creates a new late identity. Other previous FIX NOW labels (Staff/Push/Audit/
critic/Estimate/Close/Deliver) lacked concrete calls and are dropped from this
list; their existing dedicated notices/gates remain. No new tool or invented
rebaseline/split operation was added. Generated ask calls are checked against the
real AskTool schema in tests and GateDecision admits ask under an unrelated gate.
If ask is unavailable, the runtime drops the item.

The renderer retains full arguments and row identifiers rather than truncating
an action into an unusable command. It caps the list at five actions; the exact
notice size depends on row titles, not a fixed 400-character cap.

## Reply gate incident

SpawnProof8 session `01a1b7f5-7e35-735d-b7f7-2fa931b71c83` lines 34–39 show
wait refusal, then visible text “SpawnProbe is running…” alongside the second
wait, then the identical refusal. The model **did emit text**. The caller reset
inFlightAssistantHasText on message_end before tool admission, while canonical
history had not yet incorporated that assistant message. It was not telepathy
or proof that Terra ignored the demand.

`../reply-measure.ts` replays the real harness converter on this fixture:
both refusal instructions reach user-role Harness messages (`../reply-context.json`).
The candidate retains finalized assistant text carrying wait; plain unpublished
drafts still cannot discharge session_stop. First refusal also queues an explicit
user-channel recovery note. A repeated identical reply refusal admits wait and
records todo-reply-gate-miss, while other real gates remain effective. A newer
human input and assistant message start reset the draft state.

## Verification

- Baseline `66c38306` with the same new runtime tests: 2 pass / 4 fail;
  `../baseline-regression.log`. Candidate focused five-file suite: **126 pass,
  0 fail, 889 assertions**, `../focused-complete.log`. Includes actual hook
  transitions, +1 minute clock, changed baseline, acknowledgement, legacy-list
  removal, external-text negative control, same-message text + wait through
  message_end, repeated refusal admission and durable miss, plus existing lead
  and gate contracts. No scorer changed.
- Standalone **bun check exit 0**, TypeScript and Rust,
  `../check-complete.log`. Pre-existing warnings retained. Changed small/new TS
  files formatted; todo_dispatch.ts is not formatter-clean at base, so it was
  not globally reformatted. Plain and whitespace-insensitive diffs reviewed.
- Frozen dedup union `81f35a76735241fbe6ce9dd22b609ce7e8daff2d` plus whole #92
  source merged automatically to `a9e764aeefca814743515fb3cd3321a55dff09b4`.
  `../manifest-heads.json`: **79/79 full heads are verified ancestors**, #92
  replaced with the source candidate. Exact dedup TS runner
  `bun -e 'const {collectCheckJobs,runCheckJobs}=await import("./scripts/ci-check-ts.ts"); process.exitCode=await runCheckJobs(await collectCheckJobs(),{concurrency:2});'`:
  **19/19, exit 0**, `../manifest-ts.log`. Same focused suite on union:
  **126/126**, `../union-focused.log`. No union Rust/full-test claim.
- Canonical stack_check candidate source: **79 PRs clean**, `../stack-final.log`.
  Initial no-fetch failed for missing FETCH_HEAD; explicit read-only fork/main
  fetch fixed the setup. No upstream fetch/write.
- Standalone native test artifact reused from evalmulti, SHA256
  `20f767b0fb5e5a14af16fae9d1593b7fb2153c82d1d351553811893f8b5529f6`;
  union artifact is the frozen evalmulti union artifact. No native source changed
  or installed binary copied. The baseline initially lacked its test addon;
  linked the same local candidate test artifact and reran the failed setup.

## Model evidence and budget

New scenarios are part of eval/lead-instructions.ts via fix-now.scenarios.ts:
late plan, churn row, three identical old FIX NOW results passed through the
real context hook, and reply text alongside wait. Final contexts and receipts:
`../contexts-final.json`, `../terra-publish.json`, `../luna-publish.json`.
Both **codex-lb/gpt-6.1-terra and codex-lb/gpt-6-luna pass 4/4** with unchanged
multi-step scorer, schema validation, at most three simulated read-tier calls.
Final actions arrive immediately. Returned control calls are never executed.
These single runs are behavior evidence, not a reliability estimate.

Early Terra runs failed late-plan (plain text rather than ask) and churn (changed
question after an unnecessary plan read). Preserved in terra.json/terra-final.json.
An explicit tool instruction and nonempty meaningful choices fixed this without
changing the scorer or relaxing expected arguments. Final options distinguish
cut/new deadline for late and split/block for churn.

All exploratory and final calls share `../budget.json`: **27 provider requests,
822318 conservatively reserved tokens, $0.833165625 reserved of $2**. Provider
usage totals 138725 tokens; calculated cost at the recorded catalog rates is
**$0.05580672** (not a billing receipt), `../cost-summary.json`. Concurrency one,
HTTP attempts one, no retries/fallback or budget resets. Aliases excluded from
usage totals. Prior intermediate receipts remain alongside final ones.

lane_ask decisions are retained in `../decision.txt`, `../decision-eval.txt`,
`../decision-legacy.txt`: approve bounded executable-action filtering, frozen
manifest proof, exact-call instruction and narrow legacy migration. No pending
judgment was replaced by a guess.

Publication uses the owner's exact lease from 66c38306; readback receipts are
`../publish.log`, `../remote-after.txt`, `../pr-after.json`. Evidence-only commit
follows source; no installed-runtime acceptance is claimed.
