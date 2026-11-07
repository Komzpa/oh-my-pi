# No telepathy: gates shipped 2026-11-07 — PR #92

Owner: «где ёбаный запрет телепатии который уже был, как его проебли». Raw objective: `/home/kom/proj/ai_pr/omp-telepathy-20261107/brief.md`; origin: `/home/kom/proj/ai_pr/omp-leadmanual-20261106/brief.md` (both read). Baseline and exact remote lease: `a4991eb837d0cd6196461208a98b31083dab931f`. Carrier: `lane/telepathy` → fork `topic/rt-agent-runtime-core`, PR #92. Rollback is the pinned baseline; no install or live mutation is authorized or performed.

## Cause and repair

Zero-active overrode the central gate decision and eventually refused todo view and agent reads, while staffing notices still demanded dispatch through a known conflicting claim. It now uses GateDecision, keeps reads and todo view/history available, names the blocking row and owner, supplies the holder read plus narrow/confirmed-read-only/kill remedies, and bounds non-remedy refusal to three attempts. Staffing/FIX NOW notices use the same resource admission policy without mutating row ownership. An auditor waiting for an open dependency is not told to DROP its row. PLAN CHECK and the harness wrapper now send the lead to the supplied NEXT ACTION instead of a runbook/status loop.

Canonical owners: `todo_dispatch.ts` / `decideGateCall`, `agent_router.ts` / `admitAssignedResources`, static prompt files, actual harness conversion and compaction notice. Eight fixtures render these paths, use real tool schemas and exercise the actual tool-call hooks. The tests assert decisions, not source text. Negative control: unrelated writes remain refused; a broad legacy writer claim still blocks restore until a real TODO schedule mutation marks the auditor read-only. The ROOT read-only auditor admits restore immediately.

## Before / after

Invariant suite on baseline: **1 pass, 2 fail** (inspection denied; 8 repeated refusals). Candidate: **3 pass, 0 fail**. Final lead coverage: **35 pass, 0 fail**. The repeated baseline error was an intentional regression check, not a provider failure; Bun 1.4.4 `bun test --help` documents its assertion runner and retry flags ([runner documentation](https://bun.com/docs/cli/test)); no retry was used to mask it.

Real model: `codex-lb/gpt-6-luna`. New gates: **0/8 → 8/8**, four unique contexts each, one response per context. Aliases: rootclaim/zeroactive/harnessrole, spawnconflict/composite-deadlock, fixlist/criticstale. Baseline captured at 2026-11-07T20:07:06.378Z; final at 2026-11-07T20:15:32.420Z. The earlier baseline expected todo view for conflict recovery; its returned skill read also fails the final expected holder-read action, so the 0/8 result is unchanged. No returned control or worker call was executed.

| Scenario           | First executable action                                                                | Before | After |
| ------------------ | -------------------------------------------------------------------------------------- | ------ | ----- |
| rootclaim          | task: restore preview; read-only ROOT auditor does not conflict                        | 0/1    | 1/1   |
| zeroactive         | task: restore preview; inspection stays available                                      | 0/1    | 1/1   |
| harnessrole        | task: obey explicit runtime NEXT ACTION delivered through user-role harness wrapper    | 0/1    | 1/1   |
| spawnconflict      | read agent://AuditPower; then narrow the actual claim or kill a confirmed stuck holder | 0/1    | 1/1   |
| composite-deadlock | read agent://AuditPower; claim repair precedes another dispatch                        | 0/1    | 1/1   |
| fixlist            | task: first FIX NOW row                                                                | 0/1    | 1/1   |
| criticstale        | task: stale current critic action becomes FIX NOW #1                                   | 0/1    | 1/1   |
| compactloop        | todo view: inspect pinned plan before reducing resident context                        | 0/1    | 1/1   |

Full existing-plus-new run: **27/38 → 34/38**; existing cases alone **27/30 → 26/30**. The final gate-only rerun changes conflict recovery to holder read and retains 8/8. Existing strict failures: waiting (todo view instead of waiting), audit-fail (missing required solutionSpace), blocked-on-user (ask tool although this contract requires text), estimate-cap (todo view instead of append). These are exposed, with unchanged scorers; this single-response eval is not a reliability estimate. Haiku was **not run**: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` were absent. No credentials were fetched.

## Verification and budget

Focused nine-file suite: **276 pass**, extended TODO/liveness: **58 pass**, final lead suites: **35 pass**. Extension types: **2,820 files pass**; coding-agent types: **4,940 files pass**. Changed small/new TS files pass oxfmt; legacy large files were not reformatted. CI dry-run includes both lead suites. No full-repository suite or installed-runtime proof is claimed.

Whole-run shared budget includes every exploratory, baseline and final request: **136 requests**, **5,261,613 conservative reserved tokens**, **$0.681686 reserved** against **$2**. Provider-reported usage totals **$0.06197812** across 136 unique requests (aliases excluded). Reservations used configured catalog prices, concurrency 1, HTTP attempts 1, no fallback. Final token ceiling was 6,000,000; monetary cap stayed $2. Haiku has zero calls.

`lane_ask.py` final decision (`telepathy-delivery-decision.txt`): “Finish the lane with the 8/8 new gates, report the four unchanged legacy failures, and exact-lease push PR #92.” Here “legacy” means pre-existing scenarios: the exact failures varied between the baseline and final single-response runs. It also required preserving receipts with hashes and reading the holder before narrowing/killing. No splitting of scope or scorer relaxation followed.

Read-only journal evidence: session `01a1921c-7697-72a8-b4a3-4efdbbf06221`, 2026-11-07 19:40–19:42 UTC. Lines 145758/145832 show assigned resource conflicts; 145762/145785/145836 show “0 workers running … Dispatch them now”; 145780 records ROOT held by the auditor and 47ms dispatch failures. Extracts are preserved locally. No session writes occurred.

## Receipts

All raw contexts, complete first tool calls, hashes, usage, failed iterations, logs and decision are preserved outside the fork at `/home/kom/proj/ai_pr/omp-telepathy-20261107/evidence/lead-instructions`; `SHA256SUMS` covers each file. Earlier missing-estimate fixture runs are exploratory and are not used as the final eight-gate baseline.

```text
90ef367f9c5bd2d5e4f6c8d3eb4ec1fb58ed84e29d86595a9b2e418cf0b87e3a  telepathy-before-test-final.log
e7619ffc228b47564502fab5bffa3c41526639ef39511b36c691a33cf198410d  telepathy-delivery-decision.txt
64ade482655bb900959359c45c7458f3a631e368445a7ece6490e29354bd2c13  telepathy-gates-luna-baseline.json
14b925b9bc6a7979776ab9ebf75b277f258a635664e9ff169eee2e4932e6e6bd  telepathy-gates-luna-delivery.json
61bdbed1022590bc0d00f4904b45253065732598fab931db2ad785d3214c1af7  telepathy-luna-final.json
```

Reproduce candidate: `bun test packages/reemxy-extensions/extensions/lead-gates.test.ts packages/reemxy-extensions/extensions/lead-instructions.test.ts`; opt-in model: `bun run eval:lead-instructions --max-usd 2 --budget-file <shared-budget> --output <new-receipt>`. Existing spent budgets must not be reset. No ~/.omp or ~/.config writes, live processes, desktop, updater, source installation, canonical main or can1357 mutation.
