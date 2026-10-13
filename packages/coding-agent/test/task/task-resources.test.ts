/**
 * Task `resources?: string[]` contract: optional field on flat and per-batch
 * task items across static and dynamic wire schemas, retention of absent/[]/
 * declared lists through parse, and rejection of malformed or blank values
 * before launch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type AgentDefinition, getTaskSchema, taskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type } from "@oh-my-pi/omptype";
import { isRecord } from "@oh-my-pi/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
	model: ["anthropic/claude-sonnet-4"],
};

function createSession(options: { settings?: Record<string, unknown>; spawns?: string } = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => null,
	} as unknown as ToolSession;
}

function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [{ ...taskAgent }],
		projectAgentsDir: null,
	});
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function wireProps(tool: { parameters: unknown }): Record<string, unknown> {
	const schema = toolWireSchema(tool as never);
	const properties = (schema as { properties?: unknown }).properties;
	return isRecord(properties) ? properties : {};
}

const EXPECTED_RESOURCES = { type: "array", items: { type: "string" } };

describe("task resources", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("exposes optional resources on every wire shape (flat/batch, isolation on/off, static + dynamic)", async () => {
		mockDiscovery();
		const cases: Array<{ settings: Record<string, unknown>; spawns?: string; batch: boolean }> = [
			{ settings: { "task.batch": true }, batch: true },
			{ settings: { "task.batch": false }, batch: false },
			{
				settings: { "task.batch": true, "task.isolation.enabled": true },
				batch: true,
			},
			{
				settings: { "task.batch": false, "task.isolation.enabled": true },
				batch: false,
			},
			// Non-default defaultAgent forces the createTaskSchema dynamic path.
			{ settings: { "task.batch": true }, spawns: "scout", batch: true },
			{ settings: { "task.batch": false }, spawns: "scout", batch: false },
		];
		cases.push(
			{ settings: { "task.batch": true, "task.isolation.enabled": true }, spawns: "scout", batch: true },
			{ settings: { "task.batch": false, "task.isolation.enabled": true }, spawns: "scout", batch: false },
		);
		for (const c of cases) {
			const tool = await TaskTool.create(createSession(c));
			const props = wireProps(tool);
			const schema = toolWireSchema(tool);
			const required = (schema as { required?: string[] }).required ?? [];
			if (c.batch) {
				const tasks = props.tasks;
				expect(isRecord(tasks), `batch tasks shape (${JSON.stringify(c.settings)} spawns=${c.spawns})`).toBe(true);
				const items = (tasks as { items?: unknown }).items;
				expect(isRecord(items)).toBe(true);
				const itemProps = (items as { properties?: unknown }).properties;
				expect(isRecord(itemProps)).toBe(true);
				expect((itemProps as Record<string, unknown>).resources).toEqual(EXPECTED_RESOURCES);
				const itemRequired = ((items as { required?: unknown }).required as string[] | undefined) ?? [];
				expect(itemRequired).not.toContain("resources");
			} else {
				expect(props.resources).toEqual(EXPECTED_RESOURCES);
				expect(required).not.toContain("resources");
			}
		}
	});

	it("parses: retains absent/[]/non-empty and rejects malformed declarations", () => {
		const flat = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
		const kept = flat({ task: "t", solutionSpace: "s", resources: ["/a", "/b"] }) as Record<string, unknown>;
		expect(kept.resources).toEqual(["/a", "/b"]);
		const empty = flat({ task: "t", solutionSpace: "s", resources: [] }) as Record<string, unknown>;
		expect(empty.resources).toEqual([]);
		const absent = taskSchema({ task: "t", solutionSpace: "s" }) as Record<string, unknown>;
		expect(Object.hasOwn(absent, "resources")).toBe(false);
		for (const bad of ["x", [1], null, [["nested"]]]) {
			expect(
				flat({ task: "t", solutionSpace: "s", resources: bad }) instanceof type.errors,
				`rejects ${JSON.stringify(bad)}`,
			).toBe(true);
		}
		const batch = getTaskSchema({ isolationEnabled: true, batchEnabled: true });
		const bout = batch({
			context: "ctx",
			tasks: [{ task: "t", solutionSpace: "s", resources: ["/x"] }],
		}) as { tasks: Array<Record<string, unknown>> };
		expect(bout.tasks[0]?.resources).toEqual(["/x"]);
		expect(
			batch({ context: "ctx", tasks: [{ task: "t", solutionSpace: "s", resources: "x" }] }) instanceof type.errors,
		).toBe(true);
	});

	it("rejects blank entries before launch with an error naming the task", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const result = await tool.execute("tc-bad", {
			context: "ctx",
			tasks: [{ name: "Scopey", task: "Do it.", solutionSpace: "one fix", resources: [""] }],
		} as unknown as TaskParams);
		expect(JSON.stringify(result.content)).toContain("Scopey");
		const text =
			result.content.find(p => p.type === "text")?.type === "text"
				? (result.content.find(p => p.type === "text") as { text: string }).text
				: "";
		expect(text).toContain("Scopey");
		expect(text).toContain("resources");
	});
});
