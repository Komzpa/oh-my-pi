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

export const gateScenarioIds = [
	"rootclaim",
	"spawnconflict",
	"zeroactive",
	"fixlist",
	"criticstale",
	"harnessrole",
	"compactloop",
	"composite-deadlock",
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
		const blocked = id === "spawnconflict" || id === "composite-deadlock";
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
		const scenario = await capture({
			id,
			row: structuredClone(row),
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
	return output;
}
