# Advisory skip / SpawnProbe regression — 2026-11-08

Raw objective: `/home/kom/proj/ai_pr/omp-advisoryskip-20261108/brief.md`. The supplied fixture-new.jsonl/out (59b1731e) loses SpawnProbe after two anonymous advisory skips; fixture-old.jsonl (5cb50336) prints its result. Preserve the exact one-shot prompt, exactly one read-only worker, no edits, and deliver pwd/HEAD. No installation, live process mutation, canonical main or can1357 publication is authorized.

Owners and rollback: #92 `topic/rt-agent-runtime-core`, baseline/lease `73d7978ab69b0286aa9e7c961ecb773573566460`; #41 `feat/requirements-ledger`, baseline/lease `d6ab1abcf2f9c9732b74ae634da694579900fd38`. Existing commits and authorship are preserved. Only fork heads will be pushed with exact leases; rollback is each pinned baseline.

## Cause and changes

The core steering peek retained only the category `system`, discarding the actual queued customType and demand. It now carries the selected advisory identity and collapsed one-line content through both pre-start and in-flight skip results. The static skipped-tool template names the advisory and says to handle it, then retry the actual tool. User-over-agent-over-system precedence remains; passive `interruptWait:false` messages do not preempt tools. A real blocking advisory still skips interruptible tools and is delivered at the boundary. The new telepathy invariant/scenario exercises the rendered advisory remedy.

Separately, #41 queued classification flow notices as `steer`. They now use passive `nextTurn`, triggerTurn:false. The task's additionalContext reminder and completion gate remain: classification cannot interrupt receipt of an already-spawned worker result, while unclassified requirements still gate final publication. This changes the producer, without a text-prefix exception or a dependency between the two topics.

Judgments, preserved in the lane directory: ownership-decision.txt approved #92; requirements-decision.txt approved independent #41 nextTurn delivery. fixture-setup-decision.txt approved matching the old probe's shell-capable dispatch without runtime readOnly:true. All were obtained via the requested lane_ask.py with the raw brief as context.

## Executed verification

- Runtime baseline 73d7978: `bun test packages/agent/test/agent-loop.test.ts --test-name-pattern 'system advisory wording|passive reminder'`: 0 pass, 2 fail. Candidate runtime/Agent/lead-gates/lead-instructions suites: 255 pass, 0 fail. Real batch assertions cover executed result vs skipped result, named demand, exact retry, delivered advisory, and passive reminder. Existing real-user steering tests are the negative control.
- Requirements baseline d6ab1ab: `bun test packages/coding-agent/test/agent-session-interrupt-queued-messages.test.ts --test-name-pattern 'owned probe'`: 0 pass, 1 fail (wait never executes). Candidate same file plus session/requirements-ledger-flow.test.ts: 12 pass, 0 fail. The new test runs the real session candidate-capture, before-tool and queue paths; it asserts the wait output reaches the next model request. Existing classification/refusal/freshness tests remain active.
- Full `bun check` passed on each standalone topic, including Rust checks. Final source-import repair was checked again. No full test-suite claim.
- Stack check initially exposed a shared barrel-import conflict with another pinned topic. Using the prompt utility subpath removed the conflict without modifying that peer. Each final candidate reports `OK: 79 PRs merge cleanly onto upstream 8c8a620b8d`.
- Luna telepathy: 9/9 scenario verdicts, five unique provider requests, no retries/fallback, same aggregate budget file. Reserved 194948 tokens / $0.0262885 against $1; reported actual cost $0.0034143 excluding aliases. The new advisoryskip chooses todo classify; no generated control/worker calls were executed by the eval. Receipt telepathy-luna.json includes contexts, hashes, first calls and usage.

## Composite fixture

Built only in this lane's `composite` worktree from the read-only source snapshot 7100f1206040212886c39351c76674eb17ab7dbf, plus the two owner deltas. The sole import conflict was resolved by preserving the composite's withLoopPhase import and adding the prompt utility separately. The normal build-binary.ts / compile-binary.ts plugins build cli.ts; no updater or installed binary was touched. Native code is unchanged by this lane; the lane-local addon came from the package setup artifact, copied into disposable worktrees, not a new native-code validation claim.

The fixture repository is a local clone of `/home/kom/proj/ai_pr/omp-dcclone-20261107/repo`, never the live DC checkout. All config/state/sessions are lane-local via PI_CONFIG_DIR, PI_CODING_AGENT_DIR and PI_CODING_AGENT_SESSION_DIR. Provider and runtime extensions come from the composite source package. A disposable project task.agentModelOverrides.task forces codex-lb/gpt-6-luna.

First attempt: requirements no longer preempted wait; another pending goal-deadline-time-note was correctly named, the model retried wait, and the result arrived. The worker had runtime readOnly:true, which intentionally removes shell tools, so it could not execute pwd/HEAD. This attempt is a failed fixture, preserved in fixture-candidate.out and fixture-sessions. The old successful fixture omitted that flag. Per lane_ask, the final setup uses a project-local task profile restricted by instructions to those two read-only commands, and explains that the runtime flag removes shell access. The raw user prompt is unchanged. No read-only runtime policy was weakened.

Final build/run and publication receipts follow below.

## Final acceptance

Final build exited 0. Source changes: #92 53a76abcafbd0998a1c5380c74d2cb67c7c4a3fe, #41 87b8e5eb7adb520d0d133a011a679f3cedda5bd4, on composite base 7100f1206040212886c39351c76674eb17ab7dbf. Final binary SHA-256: 20b7ae4d66bd1f3b0337bfe64bdd7770101c9fdbbe3e99c54288c7d2a8e8bc1e.

Final print-mode run exited 0 and printed:

```text
`pwd`: `/home/kom/proj/ai_pr/omp-advisoryskip-20261108/fixture-repo`  
`git rev-parse --short HEAD`: `7f604c636`
```

Exactly one worker was actually spawned. The first task call was rejected because it named a nonexistent todo row; its retry spawned SpawnProbe once. Parent session `2026-11-07T20-56-11-670Z_01a1b7cc-2496-7236-9c63-8825150e708f.jsonl`: model_change line 4 is codex-lb/gpt-6-luna. Child SpawnProbe.jsonl: model_change line 3 is codex-lb/gpt-6-luna with resolvedModelIsFallback:false; thinking_level_change line 4 is medium. Its only tool call is line 12, bash `pwd && git rev-parse --short HEAD`; result is returned to the parent and printed. fixture-verification.json asserts the actual spawn count, sole child call, model and both printed values. A goal time-note and user-reply extension gate still caused retries; they did not lose this result. No broader removal of unrelated gates is claimed.

The disposable task override/profile were preserved in fixture-setup and removed after proof. No live checkout/config was changed. Raw receipts remain in `/home/kom/proj/ai_pr/omp-advisoryskip-20261108`: *baseline.log, *tests*.log, *check*.log, stackcheck-*.log, both build logs, fixture-final.out/err and fixture-final-sessions, fixture-verification.json, telepathy-luna.json, eval-budget.json and the lane decisions. Eval SHA-256: 0175d19d996e739e790b4db0b41f33a46538dca42fce2a98a10e14d1f06e0294.

#41 was pushed with its baseline exact lease; remote and gh PR head readback is stored in readback-requirements-remote.txt / readback-requirements-pr.json. #92 uses the brief's exact lease; its publication readback is stored in readback-runtime-remote.txt / readback-runtime-pr.json after the push. No PR comments or description edits were posted. The acceptance is a disposable composite build, not an installed-runtime claim.
