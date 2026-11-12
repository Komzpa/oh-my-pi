# omp: the plan critic never runs on the live DC lead

Komzpa/oh-my-pi fork, branch topic/rt-agent-runtime-core (#92, head 77054de61f7). The worktree is on that head
(local branch lane/criticlive). Push to fork:topic/rt-agent-runtime-core with an exact lease and read it back. No
other lane is on #92. A lane is on #93 (topic/rt-restart-queue, restart input redelivery). Do not push there.
Installed build 444c4614 (includes #92 4347f6d1 with packages/reemxy-extensions/extensions/plan_critic.ts) went live on
the DC lead at 12:38 local (08:38Z) via an in-place restart (re-exec plus resume of the same session).
Since then, 35+ min: no plan-critic custom entry, no plan-critic-error entry, no "Plan critic failed" warn, and no
reviewer subagent session. Immediate triggers held the whole time: CHURN 5 on "Facility labels after rotation", a
waits-chain, a slipped deadline, and open rows 7→7 for an hour. The other #92 notes (action demands) did fire.
Live evidence, read-only: ~/.omp/logs/omp.2026-11-07.3453724.log and the session journal
/home/kom/.omp/agent/sessions/-proj-sunbim-datacenter-decision-graph/2026-10-31T13-18-21-335Z_01a1921c-7697-72a8-b4a3-4efdbbf06221.jsonl
Suspects from reading plan_critic.ts: silent early returns. `!main(ctx)` (does a restored/resumed session look like a
child?); `ctx.getTodoPhases?.() ?? []` returning empty; `!ctx.runDeliveryCritic`. Or no session_start/session_switch
event is fired to extensions on the restart/resume path, so start() and its timer never run. Also check that
selectBranchEntries over a 2.5 GB journal is not the full-branch walk that caused freezes earlier today.
Required:
1. Log every early return of tick/start once per reason, bounded (debug, plus one warn the first time).
2. Reproduce on a fixture built from a COPY of the DC journal (cp --reflink=auto into your lane dir), started through
   the real resume path AND through the restart-restore path, with the installed-shape reemxy-extensions package
   loaded. Show the critic reaching runDeliveryCritic (use a stub reviewer) on that copy.
3. Fix the root cause. The critic must run within 1 min of start when triggers hold, and every 45 min otherwise.
   Collect the digest by indexed/iterated entries, not by a full-branch walk on the main thread.
Tests fail on base and pass on head. Run the full extensions and coding-agent todo/session suites plus
tools/omp/stack_check.py. No install, no ~/.omp writes, no live sessions. Report to evidence/result.md.
