import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { patchTodoSchedule } from "@oh-my-pi/pi-coding-agent/session/todo-schedule-patch";
import agentRouter, { routeSubagentSpawn } from "./agent_router";
import { liveWorkerRows, workerToolPreflight } from "./dispatch_preflight";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "editgrant-"));
	const assigned = path.join(dir, "AdaptiveBatch");
	await fs.mkdir(assigned);
	let phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{
					content: "Capture screenshots",
					status: "in_progress",
					schedule: { owner: "BragPrScreenshots", resources: [path.join(dir, "old")] },
				},
			],
		},
	];
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	const steer = vi.fn(async (_text: string) => {});
	registry.register({
		id: "Lead",
		kind: "main",
		displayName: "Lead",
		session: {
			getTodoPhases: () => phases,
			steer,
		} as unknown as AgentSessionHandle,
	});
	registry.register({
		id: "BragPrScreenshots",
		kind: "sub",
		parentId: "Lead",
		displayName: "Screenshots",
		session: {
			getTodoPhases: () => [],
		} as unknown as AgentSessionHandle,
	});
	const lead = {
		cwd: dir,
		agent: { kind: "main", id: "Lead" },
		getTodoPhases: () => phases,
		updateTodoSchedule: (task, patch) => {
			const next = patchTodoSchedule(phases, task, patch);
			if (!next) return false;
			phases = next;
			return true;
		},
	} as ExtensionContext;
	const worker = { cwd: dir, agent: { kind: "sub", id: "BragPrScreenshots", parentId: "Lead" } } as ExtensionContext;
	return {
		dir,
		assigned,
		lead,
		worker,
		registry,
		steer,
		phases: () => phases,
		cleanup: () => fs.rm(dir, { recursive: true, force: true }),
	};
}

test("lead task assignment and context paths become durable row scope before the first write; another row still conflicts", async () => {
	const f = await fixture();
	try {
		f.phases()[0]!.tasks[0]!.schedule!.owner = undefined;
		const stateFile = path.join(f.dir, "spawns.jsonl");
		const event = {
			agent: "task",
			spawnKey: "BragPrScreenshots",
			assignment: `Capture screenshots\nWorktree ${f.assigned}`,
			context: `Write evidence in ${f.dir}/proof`,
		};
		expect(routeSubagentSpawn(event, f.lead, undefined, { stateFile })).toBeUndefined();
		expect(
			await workerToolPreflight({ toolName: "edit", input: { path: `${f.assigned}/facilityScene.ts` } }, f.worker),
		).toBeUndefined();
		expect(f.phases()[0]!.tasks[0]!.schedule!.resources).toContain(f.assigned);
		expect(
			await workerToolPreflight({ toolName: "write", input: { path: `${f.dir}/proof/capture.png` } }, f.worker),
		).toBeUndefined();
		f.phases()[0]!.tasks.push({
			content: "Other row",
			status: "pending",
			schedule: { owner: "Other", resources: [f.assigned] },
		});
		expect(routeSubagentSpawn(event, f.lead, undefined, { stateFile })).toMatchObject({ block: true });
		expect(
			await workerToolPreflight({ toolName: "edit", input: { path: `${f.assigned}/facilityScene.ts` } }, f.worker),
		).toMatchObject({ block: true });
	} finally {
		await f.cleanup();
	}
});

test("nested children with no own row inherit live ancestor scope and cannot widen it through assignment, cwd, symlink or revocation", async () => {
	const f = await fixture();
	try {
		f.lead.updateTodoSchedule!("Capture screenshots", { resources: [f.assigned] });
		const child = {
			cwd: f.dir,
			agent: { kind: "sub", id: "BragPrScreenshots.SkillScreens", parentId: "BragPrScreenshots" },
		} as ExtensionContext;
		expect(
			await workerToolPreflight({ toolName: "write", input: { path: `${f.assigned}/image.png` } }, child),
		).toBeUndefined();
		expect(liveWorkerRows(child).map(row => row.content)).toEqual(["Capture screenshots"]);
		expect(
			await workerToolPreflight({ toolName: "write", input: { path: `${f.dir}/other.png` } }, child),
		).toMatchObject({ block: true });
		await fs.symlink(f.dir, `${f.assigned}/escape`);
		expect(
			await workerToolPreflight({ toolName: "write", input: { path: `${f.assigned}/escape/other.png` } }, child),
		).toMatchObject({ block: true });
		expect(
			routeSubagentSpawn({ agent: "task", assignment: `Worktree ${f.dir}/wider` }, f.worker, undefined, {
				stateFile: `${f.dir}/spawns`,
			}),
		).toMatchObject({ block: true });
		f.lead.updateTodoSchedule!("Capture screenshots", { resources: [`${f.dir}/replacement`] });
		expect(
			await workerToolPreflight({ toolName: "write", input: { path: `${f.assigned}/image.png` } }, child),
		).toMatchObject({ block: true });
	} finally {
		await f.cleanup();
	}
});

test("resource scope requests restating assignments grant without lead work; new paths deliver one ready schedule action", async () => {
	const f = await fixture();
	try {
		f.lead.updateTodoSchedule!("Capture screenshots", { resources: [f.assigned] });
		let execute: (
			id: string,
			input: { paths: string[] },
			signal: undefined,
			update: undefined,
			ctx: ExtensionContext,
		) => Promise<{ details: { status: string } }>;
		agentRouter({
			on() {},
			zod: z,
			registerTool(tool: { name: string; execute: typeof execute }) {
				if (tool.name === "resource_scope") execute = tool.execute;
			},
		} as unknown as ExtensionAPI);
		const request = (paths: string[]) => execute("scope", { paths }, undefined, undefined, f.worker);
		expect((await request([`${f.assigned}/capture.png`])).details.status).toBe("granted");
		expect(f.steer).not.toHaveBeenCalled();
		expect((await request([`${f.dir}/new-proof`])).details.status).toBe("pending");
		expect((await request([`${f.dir}/new-proof`])).details.status).toBe("pending");
		expect(f.steer).toHaveBeenCalledTimes(1);
		f.phases()[0]!.tasks.push({
			content: "Other writer",
			status: "in_progress",
			schedule: { owner: "Other", resources: [f.assigned] },
		});
		expect((await request([`${f.assigned}/capture.png`])).details.status).toBe("conflict");
		expect(f.steer.mock.calls[0]![0]).toContain('"op":"schedule"');
		expect(f.steer.mock.calls[0]![0]).toContain(`${f.dir}/new-proof`);
		expect(
			await workerToolPreflight({ toolName: "write", input: { path: `${f.dir}/new-proof/a` } }, f.worker),
		).toMatchObject({ block: true });
	} finally {
		await f.cleanup();
	}
});
