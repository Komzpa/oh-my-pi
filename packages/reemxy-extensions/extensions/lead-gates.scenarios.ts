import infraBreakerTemplate from "../../coding-agent/src/prompts/tools/task-infra-breaker.md" with { type: "text" };
import { createSkippedToolResult, steeringQueueState } from "../../agent/src/agent-loop";
import type { AgentMessage } from "../../agent/src/types";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import planCritic, { chiefCriticFixes } from "./plan_critic";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { capture, type LeadInstructionScenario } from "./lead-instructions.scenarios";
import { admitAssignedResources } from "./agent_router";
import { formatSpawnRefusal } from "../../coding-agent/src/task/spawn-refusal";
import { chiefFixNow } from "./fix_now";
import { prompt } from "@oh-my-pi/pi-utils";
import backoff from "../../coding-agent/src/prompts/steering/compaction-backoff.md" with { type: "text" };
import todoDispatch, { SPRINT_STATE_ENTRY_TYPE } from "./todo_dispatch";
import * as schedule from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries, TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

/** Registered-hook oracle: no shell or worker is executed by these probes. */
export async function gateLocalityScenarios(only?: string) {
	const receipts: Array<{ label: string; allowed: boolean; reason?: string }> = [];
	for (const variant of ["forecast", "forecast:escalated", "missed-eta", "todo-plan-doctor", "todo-replan", "todo-link", "unread-receipts", "unread-receipts:rebind", "unread-receipts:reconcile", "unread-receipts:reconcile:raw", "todo-plan-doctor:known", "todo-replan:known", "todo-link:known"]) {
		if (only && only !== variant) continue;
		const demand = variant.split(":")[0]!;
		const known = variant.endsWith(":known");
		const now = Date.now();
		const estimate = { optimisticSeconds: 600, likelySeconds: 1200, pessimisticSeconds: 2400, confidence: "medium" as const, basis: "Measured fixture", updatedAt: now };
		let phases: TodoPhase[] = [{ name: "Work", tasks: ["Locality X", "Locality Y", "Locality Z"].map(content => ({ content, status: "pending", schedule: { dependencies: [], ...(demand !== "forecast" || content === "Locality Z" ? { estimate } : {}), ...(content === "Locality X" ? { owner: "OwnerX" } : {}) } })) }];
		if (demand === "missed-eta") {
			phases[0]!.tasks[0]!.status = "in_progress";
			Object.assign(phases[0]!.tasks[0]!.schedule!, { startedAt: now - 3_600_000, estimate: { ...estimate, updatedAt: now - 3_600_000 } });
		}
		if (known && demand !== "todo-link") phases[0]!.tasks[0]!.schedule!.estimate = { ...estimate, pessimisticSeconds: 7200 };
		if (demand === "unread-receipts") phases[0]!.tasks[1]!.schedule!.owner = "OwnerXExtra";
		if (variant.startsWith("unread-receipts:reconcile")) phases[0]!.tasks.push({ content: "Independent work", status: "in_progress", schedule: { dependencies: [], estimate, owner: "Independent" } });
		const journal: Array<Record<string, unknown>> = [{ type: "custom", customType: SPRINT_STATE_ENTRY_TYPE, data: { version: 1, ignoredDemands: demand === "forecast" ? (variant.endsWith(":escalated") ? { "todo-replan": 9 } : {}) : { [demand]: 9 } } }];
		const hooks = new Map<string, (event: never, ctx: never) => unknown>();
		const api = { on: (name: string, hook: (event: never, ctx: never) => unknown) => hooks.set(name, hook), getActiveTools: () => ["todo", "task", "read"], appendEntry: (customType: string, data: unknown) => journal.push({ type: "custom", customType, data }), sendMessage: () => {}, registerSoftToolRequirementProvider: () => {}, pi: { ...schedule, getLatestTodoPhasesFromEntries, agentPauseGate: { paused: false } } } as unknown as ExtensionAPI;
		await todoDispatch(api);
		// An independent worker fills the one available slot; chief staffing policy is not under test.
		const jobs = { running: [{ id: "Independent", agentId: "Independent", label: known && demand === "todo-link" ? "Locality X" : "Independent work", type: "task", status: "running", startTime: now }], recent: demand === "unread-receipts" ? [{ id: "OwnerX", agentId: "OwnerX", type: "task", status: "completed" }] : [], nonJobAgents: [] };
		const ctx = { cwd: "/tmp", agent: { kind: "main" }, getTodoPhases: () => phases, sessionManager: { getHeader: () => ({ id: `locality-${variant}` }), getBranch: () => journal, getBranchMatching: (predicate: (entry: unknown) => boolean) => journal.filter(predicate), getLatestBranchMatching: (predicate: (entry: unknown) => boolean) => journal.findLast(predicate), getSessionFile: () => undefined }, getAsyncJobSnapshot: () => jobs, getTaskMaxConcurrency: () => 1, isIdle: () => false, hasPendingMessages: () => false, setTimeout: () => ({}), setInterval: () => ({}), clearTimer: () => {}, getTodoPreviewConfig: () => ({ enabled: false }) } as unknown as ExtensionContext;
		await hooks.get("session_branch")!({} as never, ctx as never);
		const probe = async (label: string, name: string, args: Record<string, unknown>, allowed: boolean, remedy?: string) => {
			const result = await hooks.get("tool_call")!({ toolName: name, toolCallId: label, input: args } as never, ctx as never) as { block?: boolean; reason?: string } | undefined;
			const receipt = { label: `${variant}: ${label}`, allowed: !result?.block, reason: result?.reason };
			receipts.push(receipt);
			if (receipt.allowed !== allowed || (remedy && !receipt.reason?.includes(remedy))) throw new Error(JSON.stringify(receipt));
		};
		const task = (row: string) => ({ tasks: [{ name: row === "Locality X" ? "OwnerX" : "ReadyZ", agent: "coder", task: row }] });
		try {
			await probe("compound shell", "bash", { command: "git -C R fetch && git -C R worktree add W SHA && git -C W rev-parse HEAD" }, true);
			await probe("file write", "write", { path: "/tmp/locality-result", content: "result" }, true);
			await probe("ready task", "task", task("Locality Z"), known || demand === "forecast" || demand === "missed-eta" || demand === "unread-receipts");
			await probe("held task", "task", task("Locality X"), false, demand === "forecast" ? "estimate" : "todo");
			await probe("ordinary todo", "todo", { op: "start", task: "Locality X" }, demand === "forecast" || (!known && ["todo-plan-doctor", "todo-replan", "todo-link"].includes(demand)));
			await probe("independent todo", "todo", { op: "start", task: "Locality Z" }, true);
			await probe("schedule remedy", "todo", { op: "schedule", updates: [{ task: "Locality X", estimate, evidence: "Measured remaining work" }] }, true);
			if (demand !== "forecast") await probe("mixed batch", "task", { tasks: [...task("Locality Z").tasks, ...task("Locality X").tasks] }, false);
			if (demand === "unread-receipts") await probe("different exact owner", "task", task("Locality Y"), true);
			for (const [name, args] of [["read", { path: "agent://OwnerX" }], ["write", { path: "agent://OwnerX", content: "receipt" }], ["write", { path: "proc://123/kill" }], ["goal_deadline", { action: "view" }]] as Array<[string, Record<string, unknown>]>) await probe(`exempt ${name} ${args.path ?? ""}`, name, args, true);
			if (variant === "unread-receipts:rebind") await probe("explicit unread owner rebound", "task", { tasks: [{ name: "OwnerX", row: "Locality Z", task: "Locality Z", agent: "coder" }] }, false, "OwnerX");
			if (variant.startsWith("unread-receipts:reconcile")) {
				const read = { toolName: "read", toolCallId: "receipt-read", input: { path: `agent://OwnerX${variant.endsWith(":raw") ? ":raw" : ""}` }, content: [{ type: "text", text: "Worker returned a partial result; remaining work is recorded on Locality X." }] };
				await probe("receipt read admitted", "read", read.input, true);
				await hooks.get("tool_result")!({ ...read, isError: true } as never, ctx as never);
				await probe("failed read does not release owner", "task", task("Locality X"), false);
				const args = { op: "schedule" as const, updates: [{ task: "Locality X", estimate, evidence: "Receipt reviewed; continue only the recorded missing output" }] };
				const tool = new TodoTool({ cwd: "/tmp", settings: Settings.isolated(), getSessionFile: () => null, getTodoPhases: () => phases, setTodoPhases: (next: TodoPhase[]) => { phases = next; } } as unknown as ToolSession);
				const beforeRead = await tool.execute("too-early-reconcile", args);
				await hooks.get("tool_result")!({ toolName: "todo", toolCallId: "too-early-reconcile", input: args, ...beforeRead } as never, ctx as never);
				await probe("todo without read does not release owner", "task", task("Locality X"), false);
				for (const path of ["agent://OwnerX/data", "agent://OwnerX:1-5", "agent://OwnerX:1-5:raw"]) {
					await probe(`partial receipt read admitted ${path}`, "read", { path }, true);
					await hooks.get("tool_result")!({ ...read, input: { path }, isError: false } as never, ctx as never);
					const partial = await tool.execute("partial-reconcile", args);
					if (partial.isError) throw new Error(JSON.stringify(partial));
					await hooks.get("tool_result")!({ toolName: "todo", toolCallId: "partial-reconcile", input: args, ...partial } as never, ctx as never);
					await probe(`partial read and reconciliation do not release owner ${path}`, "task", task("Locality X"), false);
				}
				await hooks.get("tool_result")!({ ...read, isError: false } as never, ctx as never);
				await probe("read alone does not release owner", "task", task("Locality X"), false);
				await hooks.get("tool_result")!({ toolName: "todo", toolCallId: "failed-reconcile", input: args, isError: true, content: [] } as never, ctx as never);
				await probe("failed reconciliation does not release owner", "task", task("Locality X"), false);
				await probe("receipt reconciliation admitted", "todo", args, true);
				const result = await tool.execute("receipt-reconcile", args);
				if (result.isError) throw new Error(JSON.stringify(result));
				await hooks.get("tool_result")!({ toolName: "todo", toolCallId: "receipt-reconcile", input: args, ...result } as never, ctx as never);
				await probe("read and reconciled owner restaff", "task", task("Locality X"), true);
				await hooks.get("session_branch")!({} as never, ctx as never);
				await probe("reconciled receipt survives reload", "task", task("Locality X"), true);
			}
			if (demand === "forecast") {
				await probe("mixed batch", "task", { tasks: [...task("Locality Z").tasks, ...task("Locality X").tasks] }, false, "Locality X");
				await probe("plan completion", "todo", { op: "done", phase: "Work" }, false, "estimate");
				await probe("independent completion", "todo", { op: "done", task: "Locality Z" }, true);
				const args = { op: "schedule" as const, updates: [{ task: "Locality X", estimate }] };
				await probe("estimate remedy", "todo", args, true);
				const tool = new TodoTool({ cwd: "/tmp", settings: Settings.isolated(), getSessionFile: () => null, getTodoPhases: () => phases, setTodoPhases: (next: TodoPhase[]) => { phases = next; } } as unknown as ToolSession);
				const result = await tool.execute("estimate-remedy", args);
				if (result.isError) throw new Error(JSON.stringify(result));
				await probe("repaired X while Y missing", "task", task("Locality X"), true);
				await probe("Y still held", "task", task("Locality Y"), false, "estimate");
			}
		} finally { await hooks.get("session_shutdown")?.({} as never, ctx as never); }
	}
	return receipts;
}

export const gateScenarioIds = [
	"rootclaim",
	"spawnconflict",
	"zeroactive",
	"fixlist",
	"criticstale",
	"harnessrole",
	"compactloop",
	"composite-deadlock",
	"infrabreaker",
	"advisoryskip",
];
export async function leadGateScenarios(): Promise<LeadInstructionScenario[]> {
	const now = Date.now();
	const row: TodoScheduleInputTask = {
		content: "Restore canonical review preview on port 47037",
		status: "pending",
		schedule: {
			dependencies: [],
			resources: ["/fixture/preview.ts"],
			estimate: {
				optimisticSeconds: 60,
				likelySeconds: 120,
				pessimisticSeconds: 240,
				confidence: "medium",
				basis: "Restore failed preview",
				updatedAt: now,
			},
		},
	};
	const holder: TodoScheduleInputTask = {
		content: "Verify levelled power inventory and incomplete inputs",
		status: "blocked",
		blocker: "Waiting for canonical preview",
		schedule: {
			estimate: structuredClone(row.schedule!.estimate),
			owner: "AuditPower",
			resources: ["/fixture"],
			dependencies: [row.content],
		},
	};
	const dispatch = { tool: "task", args: { tasks: [{ task: row.content }] } };
	const narrow = { tool: "todo", args: { op: "schedule", updates: [{ task: holder.content, readOnly: true }] } };
	const output: LeadInstructionScenario[] = [];
	const criticHooks = new Map<string, (event: never, ctx: never) => unknown>();
	const criticContext = {
		agent: { kind: "main" },
		getTodoPhases: () => [{ name: "Delivery", tasks: [row] }],
		sessionManager: { getHeader: () => ({ id: "critic-fixture" }), getBranch: () => [] },
		setInterval: () => 1,
		clearTimer: () => {},
		runDeliveryCritic: async () => ({
			details: {
				results: [
					{
						output: JSON.stringify({
							converging: false,
							criticalPathBlocker: row.content,
							falseDependencies: [],
							split: [],
							cut: [],
							escalate: [],
							actions: [
								{
									id: "staff-preview",
									severity: "blocker",
									kind: "dispatch",
									row: row.content,
									reason: "Preview has no worker",
									next: "Staff preview",
								},
							],
						}),
					},
				],
			},
		}),
	} as unknown as ExtensionContext;
	planCritic({
		typebox: { Type },
		registerTool: () => {},
		on: (name: string, hook: (event: never, ctx: never) => unknown) => criticHooks.set(name, hook),
		appendEntry: () => {},
		sendMessage: () => {},
	} as unknown as ExtensionAPI);
	await criticHooks.get("session_start")!({} as never, criticContext as never);
	await Bun.sleep(0);
	await criticHooks.get("agent_end")!({} as never, criticContext as never);
	await criticHooks.get("agent_end")!({} as never, criticContext as never);
	const criticFixes = chiefCriticFixes(criticContext);
	if (criticFixes[0]?.severity !== -1)
		throw new Error("Unanswered critic action did not become first-priority after two turns");
	for (const id of gateScenarioIds) {
		if (id === "advisoryskip") continue;
		const blocked = id === "spawnconflict" || id === "composite-deadlock" || id === "infrabreaker";
		const auditor = { ...structuredClone(holder), schedule: { ...holder.schedule, readOnly: !blocked } };
		const expected = blocked
			? { tool: "read", args: { path: "agent://AuditPower" } }
			: id === "compactloop"
				? { tool: "todo", args: { op: "view" } }
				: dispatch;
		const call = {
			name: expected.tool,
			arguments:
				expected.tool === "task"
					? {
							context: "Restore preview",
							tasks: [
								{
									name: "RestorePreview",
									task: row.content,
									solutionSpace: "Restore served preview",
									resources: ["/fixture/preview.ts"],
								},
							],
						}
					: expected.args,
		};
		const candidateRow = structuredClone(row);
		if (id === "infrabreaker") {
			candidateRow.status = "blocked";
			candidateRow.blocker = 'Infra breaker: resources held by row "Verify levelled power inventory and incomplete inputs" (owner AuditPower)';
		}
		const scenario = await capture({
			id,
			row: candidateRow,
			extraRows: [auditor],
			harnessRole: true,
			state: "needs worker",
			expected,
			probeCalls: [
				{ name: "read", arguments: { path: "agent://AuditPower" } },
				{ name: "todo", arguments: { op: "view" } },
				{ name: "todo", arguments: { op: "view" } },
				call,
				{ name: narrow.tool, arguments: narrow.args },
				{ name: "write", arguments: { path: "proc://AuditPower/kill", content: "" } },
			],
		});
		const ctx = {
			cwd: "/fixture",
			getTodoPhases: () => scenario.phases,
			updateTodoSchedule: () => true,
		} as unknown as ExtensionContext;
		const conflict = admitAssignedResources(
			{
				agent: "task",
				row: row.content,
				task: row.content,
				resources: ["/fixture/preview.ts"],
				spawnKey: "RestorePreview",
			},
			ctx,
		);
		if (conflict) scenario.context += `\n\n${formatSpawnRefusal(conflict, "RestorePreview")}`;
		if (id === "infrabreaker") scenario.context += `\n\n${prompt.render(infraBreakerTemplate, {row: candidateRow.content, cause: conflict}).trim()}`;
		if (id === "compactloop")
			scenario.context = prompt.render(backoff, {
				model: "fixture",
				window: 16000,
				tokens: 15000,
				fixedTokens: 14000,
			});
		if (id === "fixlist" || id === "criticstale")
			scenario.context += `\n\n${chiefFixNow({ main: true, defects: [{ row: row.content, action: "Staff", severity: 3 }, ...(id === "criticstale" ? criticFixes.map(fix => ({ severity: 2, ...fix })) : [])] }, true)}`;
		output.push(scenario);
	}
	const advisory = steeringQueueState([
		{
			role: "custom",
			customType: "requirements-gate-notice",
			content:
				'Classify R1 with todo op="classify", id="R1", classification="not-a-requirement", reason="one-shot read-only probe".',
			display: false,
			attribution: "agent",
			timestamp: now,
		} as AgentMessage,
	]);
	const skipped = createSkippedToolResult(advisory.source, false, "wait", advisory.advisory);
	const scenario = await capture({
		id: "advisoryskip",
		row: structuredClone(row),
		state: "working",
		workers: [{ id: "SpawnProbe" }],
		expected: { tool: "todo", args: { op: "classify", id: "R1", classification: "not-a-requirement" } },
	});
	scenario.context = `One-shot read-only SpawnProbe is already running. It must return pwd and HEAD. wait returned:\n${skipped.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n")}\nHandle the named advisory, then retry wait for SpawnProbe and print its result.`;
	scenario.notices = [scenario.context];
	output.push(scenario);
	return output;
}
