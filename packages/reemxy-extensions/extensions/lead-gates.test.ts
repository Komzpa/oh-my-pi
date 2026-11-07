import { expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { capture } from "./lead-instructions.scenarios";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { type } from "@oh-my-pi/omptype";
import { leadGateScenarios, gateScenarioIds } from "./lead-gates.scenarios";
import { decideGateCall } from "./todo_dispatch";
import { zeroActiveGate } from "./zero-active";
import { admitAssignedResources } from "./agent_router";

const session = {} as ToolSession;
const schemas = {
	todo: new TodoTool(session).parameters,
	read: new ReadTool(session).parameters,
	write: new WriteTool(session).parameters,
	task: getTaskSchema({ batchEnabled: true, isolationEnabled: false, effortEnabled: true }),
};

test("every rendered gate remedy and inspection stays executable after repeated refused dispatch (no telepathy)", async () => {
	const scenarios = await leadGateScenarios();
	expect(scenarios.map(item => item.id)).toEqual(gateScenarioIds);
	for (const scenario of scenarios) {
		const gates = [zeroActiveGate(scenario.context)];
		for (const decision of scenario.decisions ?? []) {
			expect(decision.allowed, `${scenario.id}: ${JSON.stringify(decision.call)}: ${decision.reason}`).toBe(true);
			expect(decideGateCall(decision.call, gates).allowed).toBe(true);
			const schema = schemas[decision.call.name as keyof typeof schemas];
			expect(
				schema(decision.call.arguments) instanceof type.errors,
				`${scenario.id}: invalid ${decision.call.name} remedy`,
			).toBe(false);
		}
		// Negative control: a non-remedy write still cannot bypass staffing.
		expect(
			decideGateCall({ name: "write", arguments: { path: "/fixture/other.ts", content: "x" } }, gates).allowed,
		).toBe(false);
	}
});

test("ROOT read-only auditor does not block restoration; legacy writer claim has an executable release", async () => {
	for (const scenario of (await leadGateScenarios()).filter(item =>
		["rootclaim", "spawnconflict", "composite-deadlock"].includes(item.id),
	)) {
		const phases = structuredClone(scenario.phases);
		const ctx = {
			cwd: "/fixture",
			getTodoPhases: () => phases,
			updateTodoSchedule: () => true,
		} as unknown as ExtensionContext;
		const attempt = () =>
			admitAssignedResources(
				{ row: phases[0]!.tasks[0]!.content, resources: ["/fixture/preview.ts"], spawnKey: "RestorePreview" },
				ctx,
			);
		if (scenario.id === "rootclaim") expect(attempt()).toBeUndefined();
		else {
			expect(attempt()).toContain("owner AuditPower");
			const manager = SessionManager.inMemory();
			try {
				const tool = new TodoTool({
					cwd: "/tmp",
					hasUI: false,
					getSessionSpawns: () => "*",
					settings: Settings.isolated(),
					sessionManager: manager,
					getSessionFile: () => null,
					getTodoPhases: () => phases,
					setTodoPhases: next => {
						phases.splice(0, phases.length, ...next);
					},
				} as ToolSession);
				await tool.execute("release", {
					op: "schedule",
					updates: [{ task: phases[0]!.tasks[1]!.content, readOnly: true }],
				});
				expect(attempt()).toBeUndefined();
			} finally {
				await manager.close();
			}
		}
	}
});

test("zero-active refusals stop after three non-remedy attempts while inspection stays open", async () => {
	const fixture = (await leadGateScenarios()).find(item => item.id === "zeroactive")!;
	const result = await capture({
		id: "bounded-zeroactive",
		row: fixture.phases[0]!.tasks[0]!,
		state: "needs worker",
		expected: null,
		probeCalls: Array.from({ length: 10 }, () => ({ name: "eval", arguments: { code: "1 + 1" } })),
	});
	expect(result.decisions!.filter(decision => !decision.allowed).length).toBeLessThanOrEqual(3);
	expect(result.decisions!.at(-1)!.allowed).toBe(true);
});

test("a skipped wait names its advisory, executable demand and exact retry (no telepathy)", async () => {
	const scenario = (await leadGateScenarios()).find(item => item.id === "advisoryskip")!;
	expect(scenario.context).toContain("Pending requirements-gate-notice:");
	expect(scenario.context).toContain('op="classify", id="R1"');
	expect(scenario.context).toContain("Handle requirements-gate-notice, then retry wait");
});
