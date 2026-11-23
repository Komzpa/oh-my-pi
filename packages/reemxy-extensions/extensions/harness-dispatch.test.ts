// @ts-nocheck -- runtime integration contract for the extension's registered soft demand.
import { afterEach, expect, test, vi } from "bun:test";
import { z } from "zod";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { sessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { admitAssignedResources } from "./agent_router";
import { workerToolPreflight } from "./dispatch_preflight";
import { planRowAudits } from "./row_audit";
import { todoArtifactGitBinding } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { wakeDemand } from "./dispatch_wake";
import todoDispatch, { leadActionPending } from "./todo_dispatch";
import { readGoalDeadline, STATE_ENTRY } from "./deadlines";

afterEach(() => vi.restoreAllMocks());

async function demandHarness(tasks: unknown[], deadlineAt?: number, autoDeadlineAt?: number, liveRows = false, liveWorkers: string[] = []) {
	const now = Date.now();
	const branch = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { phases: [{ name: "Plan", tasks }] } } }];
	if (deadlineAt !== undefined) branch.push({ type: "custom", customType: STATE_ENTRY, data: { version: 1, goalId: "goal-1", goalStartedAt: Math.floor(now / 1_000), timezone: "UTC", active: true, stages: [{ id: "deliver", label: "Deliver", expectedResult: "Ship the package", deadlineAt: Math.floor(deadlineAt / 1_000) }], baselineDeadlineAt: Math.floor(deadlineAt / 1_000), userConstraint: { messageId: "user-1", quote: "ship by the deadline", recordedAt: Math.floor(now / 1_000) } } });
	if (autoDeadlineAt !== undefined) branch.push({ type: "custom", customType: STATE_ENTRY, data: { version: 1, goalId: "auto-todo-plan", goalStartedAt: Math.floor(now / 1_000), timezone: "UTC", active: true, auto: true, autoPlanKey: "previous-plan", stages: [{ id: "auto-plan-forecast", label: "Finish the TODO plan", expectedResult: "Complete the current TODO plan", deadlineAt: Math.floor(autoDeadlineAt / 1_000) }], baselineDeadlineAt: Math.floor(autoDeadlineAt / 1_000) } });
	if (deadlineAt !== undefined) expect(readGoalDeadline(branch)).toBeDefined();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let provider;
	const api = {
		on: (name, handler) => handlers.set(name, handler),
		getActiveTools: () => ["task", "todo", "read", "wait"],
		pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline, getLatestTodoPhasesFromEntries, agentPauseGate, getActiveTools: () => ["task", "todo", "read", "wait"] },
		zod: z,
		registerSoftToolRequirementProvider: value => { provider = value.demand ?? value; },
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	const wasPaused = agentPauseGate.paused;
	if (wasPaused) agentPauseGate.resume();
	try {
		await todoDispatch(api, { reviewPageProbe: async () => 503 });
		const ctx = {
			// This harness exercises forecasts without a checkout or unpushed-work debt.
			cwd: `${import.meta.dir}/forecast-without-checkout`,
			sessionManager: {
				getHeader: () => ({ id: "forecast-replan-test" }),
				getBranch: () => branch,
				getBranchMatching: predicate => branch.filter(entry => predicate(sessionContextEntryMetadata(entry))),
				getLatestBranchMatching: predicate => branch.findLast(entry => predicate(sessionContextEntryMetadata(entry))),
			},
			getAsyncJobSnapshot: () => ({ running: liveWorkers.map(id => ({ id, agentId: id, type: "task", status: "running", startTime: now - 1000 })), recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 2,
			...(liveRows ? { getTodoPhases: () => [{ name: "Plan", tasks }] } : {}),
            updateTodoSchedule: (title, patch) => { Object.assign(tasks.find(row => row.content === title).schedule, patch); return true; },
            hasPendingMessages: () => false,
			isIdle: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		await handlers.get("context")?.({ messages: [] }, ctx);
		return { branch, ctx, provider, handlers };
	} finally {
		if (wasPaused) agentPauseGate.pause();
	}
}

async function demandFor(tasks: unknown[], deadlineAt?: number, autoDeadlineAt?: number) {
	const h = await demandHarness(tasks, deadlineAt, autoDeadlineAt);
	return h.provider(h.ctx);
}

const estimate = (now: number, likelySeconds: number) => ({ optimisticSeconds: likelySeconds, likelySeconds, pessimisticSeconds: likelySeconds, confidence: "medium", basis: "fixture", updatedAt: now });

test("external approval with a usable conditional estimate does not starve an independent ready row", async () => {
 const now = Date.now();
 const blocked = { content: "Keep protected branch until approval", status: "blocked", blocker: "Awaiting user: original owner approval", schedule: { dependencies: [], resources: ["/tmp/protected-branch"], estimate: estimate(now, 300), review: "user" } };
 const ready = { content: "Repair independent renderer", status: "pending", schedule: { dependencies: [], resources: ["/tmp/independent-renderer"], estimate: estimate(now, 600) } };
 const h = await demandHarness([blocked, ready]);
 const approvalRefusal = await h.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ name: "BlockedCleanup", agent: "coder", row: blocked.content, task: blocked.content }] }, toolCallId: "unapproved-dispatch" }, h.ctx);
 expect(approvalRefusal?.block).toBe(true);
 const refusal = await h.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ name: "IndependentRenderer", agent: "coder", row: ready.content, task: ready.content }] }, toolCallId: "independent-dispatch" }, h.ctx);
 expect(refusal).toBeUndefined();
 expect(blocked.status).toBe("blocked");
 expect(blocked.schedule.review).toBe("user");
});

test("journal plan still blocks held work when optional plan snapshots are absent", async () => {
 const now = Date.now();
 const held = { content: "Wait for signed approval", status: "blocked", blocker: "Awaiting user: signed approval", schedule: { dependencies: [], resources: ["approval"], estimate: estimate(now, 300), review: "user" } };
 const h = await demandHarness([held], undefined, undefined, false, ["IndependentWorker"]);
 const refusal = await h.handlers.get("tool_call")({
  toolName: "task",
  input: { tasks: [{ name: "ApprovalWork", agent: "coder", row: held.content, task: held.content }] },
  toolCallId: "journal-only-held-row",
 }, h.ctx);
 expect(refusal?.block).toBe(true);
 expect(refusal?.reason).toContain(held.content);
});


test("review debt does not admit dependent, unknown, or mixed held dispatches", async () => {
 const now = Date.now();
 const held = { content: "Approval", status: "blocked", blocker: "Awaiting user: approval", schedule: { review: "user", estimate: estimate(now, 60), dependencies: [] } };
 const dependent = { content: "Publish", status: "pending", schedule: { dependencies: [held.content], estimate: estimate(now, 60) } };
 const ready = { content: "Render", status: "pending", schedule: { dependencies: [], estimate: estimate(now, 60) } };
 const h = await demandHarness([held, dependent, ready]);
 const dispatch = async rows => h.handlers.get("tool_call")({ toolName: "task", input: { tasks: rows.map(row => ({ name: row, row, task: row, agent: "coder" })) } }, h.ctx);
 expect((await dispatch([dependent.content]))?.block).toBe(true);
 expect((await dispatch(["Unknown"]))?.block).toBe(true);
 expect((await dispatch([ready.content, held.content]))?.block).toBe(true);
 expect((await dispatch([ready.content]))?.block).not.toBe(true);
});

test("live executor identity prevents lost churn even when owner metadata differs", () => {
 const now = Date.now();
 const row = { content: "Proof", status: "in_progress", schedule: { owner: "Alias", cumulativeReestimateCount: 3, dependencies: [], executor: { workerId: "Proof-7", startedAt: now - 1000 } } };
 const phases = [{ name: "Delivery", tasks: [row] }];
 expect(wakeDemand(phases, new Set(), now)?.churn).toBe(true);
 expect(wakeDemand(phases, new Set(["Proof-7"]), now)).toBeUndefined();
 expect(wakeDemand(phases, new Set(["Alias"]), now)).toBeUndefined();
 row.status = "blocked";
 row.blocker = "Missing original approval quote";
 row.schedule.review = "user";
 row.schedule.reviewPagePending = true;
 expect(wakeDemand(phases, new Set(), now)).toBeUndefined();
 expect(wakeDemand(phases, new Set(), now + 60000)).toBeUndefined();
});

test("refused review publication preserves the pending handoff and permits an honest prerequisite block", async () => {
 const now = Date.now();
 const row = { content: "Recover original source", status: "in_progress", schedule: { dependencies: [], estimate: estimate(now, 60), executor: { workerId: "Research", startedAt: now-2000, finishedAt: now-1000, outcome: "completed" } } };
 const h = await demandHarness([row], undefined, undefined, true);
 const call = input => h.handlers.get("tool_call")({ toolName: "todo", input }, h.ctx);
 expect(leadActionPending(row)).toBe(true);
 expect((await call({ op: "block", task: row.content, reason: "Missing source" }))?.block).toBe(true);
 expect((await call({ op: "schedule", updates: [{ task: row.content, review: "user" }] }))?.block).toBe(true);
 expect(row.schedule.reviewPagePending).toBe(true);
 expect(row.schedule.review).toBe("user");
 expect(leadActionPending(row)).toBe(false);
 expect((await call({ op: "block", task: row.content, reason: "Missing original source; no authority to invent it" }))?.reason ?? "").not.toContain("Refusing block");
 expect(row.schedule.reviewPagePending).toBe(true);
});

test("reconciled accepted receipt cannot restart churn without a new event", () => {
 const now = Date.now();
 const phases = [{ name: "Delivery", tasks: [{ content: "Accepted proof", status: "in_progress", schedule: { review: "accepted", cumulativeReestimateCount: 3, owner: "Proof", dependencies: [], executor: { workerId: "Proof", startedAt: now - 2000, finishedAt: now - 1000, outcome: "completed" } } }] }];
 expect(wakeDemand(phases, new Set(), now)).toBeUndefined();
 expect(wakeDemand(phases, new Set(), now + 60000)).toBeUndefined();
 expect(wakeDemand(phases, new Set(), now + 60000, undefined, undefined, [{ worker: "Proof", question: "New actual question" }])?.action).toContain("New actual question");
});

test("one dispatch plan preserves external gates, live custody and exact audit input while admitting independent narrowed work", async () => {
 const now = Date.now();
 const root = "/tmp/omp-combined-dispatch-fixture";
 const repo = path.resolve(import.meta.dir, "../../..");
 const sha = "14449d1fa054975c94a65cff52a56a854e327955";
 const target = `${root}/delivery/proof.md`;
 const foreignTarget = `${root}/delivery/live.ts`;
 const pin = `git:${repo}@${sha}`;
 const schedule = (resources, extra = {}) => ({ dependencies: [], estimate: estimate(now, 60), resources, ...extra });
 const held = { content: "Wait for original owner approval", status: "blocked", blocker: "Awaiting user: original approval quote", schedule: schedule([`${root}/protected`], { review: "user" }) };
 const dependent = { content: "Publish after approval", status: "pending", schedule: schedule([`${root}/publish`], { dependencies: [held.content] }) };
 const live = { content: "Retain running renderer", status: "in_progress", schedule: schedule([foreignTarget], { owner: "RendererAlias", cumulativeReestimateCount: 3, executor: { workerId: "Renderer-7", startedAt: now - 1000 } }) };
 const previous = { content: "Previous evidence producer", status: "in_progress", schedule: schedule([target], { owner: "PreviousWriter", executor: { workerId: "PreviousWriter", startedAt: now - 2000 } }) };
 const incoming = { content: "Capture independent source proof", status: "pending", schedule: schedule([`${root}/delivery`, pin]) };
 const sibling = { content: "Inspect independent documentation", status: "pending", schedule: schedule([`${root}/docs`]) };
 const rows = [held, dependent, live, previous, incoming, sibling];
 const h = await demandHarness(rows, undefined, undefined, true, ["Renderer-7"]);
 h.ctx.cwd = root;
 const phases = h.ctx.getTodoPhases();
 const registry = new AgentRegistry();
 vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
 registry.register({ id: "CombinedLead", displayName: "CombinedLead", kind: "main", session: { activeToolExecutionUpdates() {}, getTodoPhases: () => phases } });
 const dispatch = (row, resources) => h.handlers.get("tool_call")({ toolName: "task", input: { tasks: [{ name: "EvidenceWriter", agent: "coder", row: row.content, task: row.content, resources }] } }, h.ctx);
 const assignment = resources => ({ type: "before_subagent_spawn", agent: "coder", invocationKind: "task", patterns: [], row: incoming.content, spawnKey: "EvidenceWriter", readOnly: false, resources });
 const worker = { cwd: root, agent: { kind: "sub", id: "EvidenceWriter", parentId: "CombinedLead" } };
 const edit = resource => workerToolPreflight({ toolName: "edit", input: { path: resource } }, worker);
 // A ready row cannot steal either live lease. These calls only evaluate policy.
 expect(admitAssignedResources(assignment([target]), h.ctx)).toContain(previous.content);
 expect(admitAssignedResources(assignment([foreignTarget]), h.ctx)).toContain(live.content);
 expect((await dispatch(held, held.schedule.resources))?.block).toBe(true);
 const forecast = forecastTodoPlan(phases, { now, capacity: 2 });
 expect(forecast.rows.find(row => row.content === dependent.content)?.ready).toBe(false);
 const dependentAdmission = await dispatch(dependent, dependent.schedule.resources);
 // An old speculation marker is not the missing approval quote or a delivered artifact.
 dependent.schedule.speculativeOn = held.content;
 expect((await dispatch(dependent, dependent.schedule.resources))?.block).toBe(true);

 // Settling the actual producer releases its lease; the other live executor remains owned.
 Object.assign(previous.schedule.executor, { finishedAt: now, outcome: "completed" });
 expect(await dispatch(incoming, [target])).toBeUndefined();
 expect(await dispatch(sibling, sibling.schedule.resources)).toBeUndefined();
 const binding = todoArtifactGitBinding(incoming);
 expect(binding).toEqual({ repoPath: repo, head: sha });
 expect(admitAssignedResources(assignment([foreignTarget]), h.ctx)).toContain(live.content);
 expect(admitAssignedResources(assignment([target]), h.ctx)).toBeUndefined();
 expect(incoming.schedule.owner).toBe("EvidenceWriter");
 expect(incoming.schedule.resources).toEqual([target, pin]);
 expect(todoArtifactGitBinding(incoming)).toEqual(binding);
 expect(await edit(target)).toBeUndefined();
 expect((await edit(foreignTarget))?.block).toBe(true);
 expect((await edit(`${root}/delivery/undeclared.md`))?.block).toBe(true);
 expect(wakeDemand(phases, new Set(["Renderer-7"]), now)?.churn).not.toBe(true);
 expect(wakeDemand(phases, new Set(), now)?.churn).toBe(true);
 expect(live.schedule.executor).toEqual({ workerId: "Renderer-7", startedAt: now - 1000 });
 expect(live.schedule.owner).toBe("RendererAlias");
 // Complete only the simulated producer receipt: planning uses the same narrowed row.
 incoming.status = "in_progress";
 incoming.schedule.executor = { workerId: "EvidenceWriter", startedAt: now, finishedAt: now + 1, outcome: "completed" };
 const audits = heads => planRowAudits(rows, heads, root, row => row === live, () => false);
 expect(audits(new Map([[repo, "b".repeat(40)]]))).toEqual([]);
 const batches = audits(new Map([[repo, sha], [root, "b".repeat(40)]]));
 expect(batches).toHaveLength(1);
 expect(batches[0].repoPath).toBe(repo);
 expect(batches[0].head).toBe(sha);
 expect(batches[0].rows.map(row => row.content)).toEqual([incoming.content]);
 expect(held.status).toBe("blocked");
 expect(held.schedule.review).toBe("user");
 expect(dependent.schedule.dependencies).toEqual([held.content]);
 expect(dependentAdmission?.block).toBe(true);
});
