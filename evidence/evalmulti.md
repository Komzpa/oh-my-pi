# Bounded multi-step lead eval — 2026-11-08

Raw objective: `../brief.md`. Sole writer of PR #92; starting and rollback head
`cb6b60bd0b20eec30064f91b4f516e608195200c`. Source commit
`abab5cf01c1175abc389c7ee17ab47a331062bcf`, additive over the whole #92 history.
Target: Komzpa/oh-my-pi `topic/rt-agent-runtime-core`; exact authorized lease is
the starting head. No install, updater, protected config writes, live OMP,
desktop, DC checkout, upstream or main mutation. Test dependencies are links to
existing lane artifacts, with workspace package links pointing into this checkout.

## Repair and source ownership

The evaluator previously compared only the first tool call. It now permits three
schema-valid read-tier calls before the expected action, simulates each result
from the frozen scenario context/phases, and feeds the assistant/tool-result
conversation back through the provider. A fourth read, invalid schema, wrong
mutation or wrong explicitly required inspection fails. Full returned call order,
per-response usage, failure cause and all response text are retained. No returned
tool executes. Existing TODO round-trip and schema validation remain enabled.

Live `~/.omp/agent/models.yml` configures codex-lb with `openai-responses` and
`openai-models-list` discovery. The old evaluator copied that file, then overwrote
it with the stale extension provider. It now refreshes only the selected configured
provider through ModelRegistry, using disposable auth/cache databases. No roster
ids were added. Read-only `ops/models.env` confirms the upstream Terra/Sol names.
The static provider file was not made a second roster owner.

A separate harness defect explained advisoryskip: standalone #92's TodoTool
schema has no `classify`; #41 owns that operation. `--tool-schemas` accepts the
real wire schema exported from the frozen union's TodoTool, without importing or
copying #41 implementation into #92. Schema source/hash are recorded. The schema
export from retryname union `484faa0f40fe85a5c3fc3eea4687eae33bf3d0f5` is byte-identical
to the final rehearsal union export. Both models now classify immediately;
no advisory or GateDecision policy change was needed.

Discovery omits prices. `--pricing-model` explicitly selects existing catalog
prices for accounting without changing discovered model identity or transport.
Used `openai/gpt-6.1-terra` and `openai/gpt-6-luna`; receipt rates are respectively
input/output $1/$5 and $0.1/$0.5 per million tokens, with cache rates preserved.
Whole-run initial-call preflight plus persisted reservations before every actual
request enforce the shared cap, including continuations. One runner lock,
concurrency one, HTTP attempts one, no retry/fallback or budget reset. Unknown
prices still fail before paid requests. First discovery attempt stopped for
unknown pricing and spent zero; its log is preserved.

`lane_ask.py` decisions in `../decision-source.txt`, `../decision-schema.txt` and
`../decision-budget.txt` approve configured discovery without fallback, real union
schemas without copying #41, frozen-union proof and explicit catalog accounting.
The local-source-patches skill was subsequently located in tasks-loop/skills and
read; its initial absence from installed skill roots did not change the carrier.

## Results and checks

Original ten scenarios from retryname `telepathy-contexts.json`, unchanged:
Terra **10/10**, Luna **10/10**; six unique contexts per model, aliases excluded
from request and usage totals. Both use discovered `openai-responses`.
`advisoryskip` calls `todo classify R1 not-a-requirement` with the supplied reason.
All ten original cases reach the expected action immediately with the real schema.
These are single-run behavior receipts, not a reliability estimate.

A separate continuation control adds an explicit instruction to inspect the plan
once before handling the same advisory. On Terra it records **todo view → todo
classify R1**, across two real provider requests and one simulated tool result.
It is not counted as an eleventh original scenario. The local boundary tests prove
three reads succeed, four fail, a mutation before the target fails even within a
batch, malformed calls fail, and the required holder inspection cannot be replaced.

Original model runs: 12 requests, 90,052 provider-reported tokens; calculated cost
at the recorded catalog rates **$0.0512046**. Including the continuation control:
14 requests total, conservative reserved tokens **590,279**, conservative reserved
USD **$0.47801275 / $2**. `../budget.json` includes all metered work in this lane.
Usage costs are calculated from provider token usage and catalog rates, not an
invoice or a provider billing receipt.

- Final standalone focused suite: **41 pass, 0 fail**, 452 assertions, three files;
  `../focused-final.log`. Extensions types: 2,823 files pass, `../types-final.log`.
- Standalone `bun check`: exit zero, TS and Rust; `../standalone-check.log`.
  One existing unused-dependency warning in pi-builtins. Bun 1.4.4's local
  `bun check --help` (`../bun-check-help.txt`) was consulted after a test fixture's
  inferred argument type rejected a read path; the fixture type was corrected.
- Frozen dedup union `81f35a76735241fbe6ce9dd22b609ce7e8daff2d` plus the whole #92
  source head merged automatically to `0ae5f9f913151265ace722c222b667307b803905`.
  Every full pinned head is verified as an ancestor: **79 = manifest 79**;
  `../manifest-heads.json`. Exact dedup19-job TS runner: **19/19**, exit zero,
  `../manifest-ts.log`. Union focused suite: **41 pass**, `../union-focused.log`.
- Canonical stack_check candidate source head: **79 clean**, exit zero,
  `../stack-final.log`; fork main read-only fetch resolved
  `8c8a620b8d6db784b848d2b019fc132d6dc5b0c3`. Initial --no-fetch lacked FETCH_HEAD;
  after fetching fork/main, the same checker succeeded. No upstream fetch/write.
- GitButler refused linked-worktree commit; its documented worktree-local git
  exception was used. Base eval file passes oxfmt. Changed/new TS files formatted;
  plain and -w diffs were reviewed, no unrelated formatting hunks.

Standalone native test artifact SHA256:
`20f767b0fb5e5a14af16fae9d1593b7fb2153c82d1d351553811893f8b5529f6`;
existing checkout artifact, no native source change or native rebuild claim.
Union artifact reused from retryname/stackgreen:
`8b5852dc4168b2050c651de040f66d87895f06b9df6cd24d3e2f66b56e81479a`.
No installed-runtime acceptance is claimed.

## Receipts and reproduction

Receipts stay in the lane parent, not temporary storage:

- `terra.json` SHA256 `91a8e2ea64822144cf4be16f2940feec70aaf646d9d127127493c8f0384d2f87`
- `luna.json` SHA256 `21fb46572ec73f201a95c2bb80af86411c34812351cd8d2f843adffa8e9caacb`
- `tool-schemas.json` SHA256 `5c31c85678c51f3be4633f70ca765c961de1ee3d7f88ef4931448cb9b2226e73`

Export schema inside the union:
`bun -e 'import {TodoTool} from "./packages/coding-agent/src/tools/todo.ts"; import {toolWireSchema} from "@oh-my-pi/pi-ai/utils/schema/wire"; await Bun.write("../tool-schemas.json",JSON.stringify({todo:toolWireSchema(new TodoTool({} as never))}));'`

Run each model using `bun packages/reemxy-extensions/extensions/eval/lead-instructions.ts
--contexts /home/kom/proj/ai_pr/omp-retryname-20261108/telepathy-contexts.json
--tool-schemas ../tool-schemas.json --model codex-lb/<id>
--pricing-model openai/<same-id> --output <new-receipt>
--budget-file ../budget.json --max-usd 2`. Never overwrite prior receipts or reset
the shared budget. Focused command names lead-sequence.test.ts, lead-gates.test.ts
and lead-instructions.test.ts under packages/reemxy-extensions/extensions.

Publication uses the standing exact lease, with ls-remote and PR #92 readback in
`../publish.log`, `../remote-after.txt` and `../pr-after.json`. No PR body/comment edit.
