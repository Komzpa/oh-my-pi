import { afterEach, expect, test, vi } from "bun:test";
import type { BeforeSubagentSpawnEvent, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { admitAssignedResources, requestResourceScope } from "./agent_router";
import { workerToolPreflight } from "./dispatch_preflight";

afterEach(() => vi.restoreAllMocks());
const root = "/tmp/omp-scope-transition-policy-fixture";
const owned = `${root}/owned.ts`;
const sibling = `${root}/unowned.ts`;

function fixture() {
	let phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{
					content: "Scoped task",
					status: "in_progress",
					schedule: { owner: "Writer", resources: [owned] },
				},
			],
		},
	];
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: {
			activeToolExecutionUpdates() {},
			getTodoPhases: () => phases,
		} as unknown as AgentSessionHandle,
	});
	const worker = (id = "Writer") => ({ cwd: root, agent: { kind: "sub", id, parentId: "Lead" } }) as ExtensionContext;
	const lead = {
		cwd: root,
		getTodoPhases: () => phases,
		updateTodoSchedule: (_task: string, patch: object) => {
			Object.assign(phases[0]!.tasks[0]!.schedule!, patch);
			return true;
		},
	} as ExtensionContext;
	return {
		worker,
		lead,
		row: phases[0]!.tasks[0]!,
		restore: () => {
			phases = JSON.parse(JSON.stringify(phases));
		},
	};
}

for (const transition of ["completed", "abandoned", "settled", "reassigned", "reassigned-executor"] as const) {
	test(`${transition} revokes the old worker without granting inherited cwd, including restored state`, async () => {
		const { worker, row, restore } = fixture();
		const edit = (target: string, id = "Writer") =>
			workerToolPreflight({ toolName: "edit", input: { path: target } }, worker(id));
		expect(await edit(owned)).toBeUndefined();
		expect((await edit(sibling))?.block).toBe(true);
		if (transition === "completed" || transition === "abandoned") row.status = transition;
		else if (transition === "settled")
			row.schedule!.executor = { workerId: "Writer", startedAt: 1, finishedAt: 2, outcome: "completed" };
		else {
			if (transition === "reassigned-executor") row.schedule!.executor = { workerId: "Writer", startedAt: 1 };
			row.schedule!.owner = "Replacement";
		}
		for (const target of [owned, sibling]) expect((await edit(target))?.block).toBe(true);
		expect(await requestResourceScope(worker(), [owned])).toMatchObject({ status: "unavailable" });
		restore();
		// A fresh context after serialization has no in-memory first-write history.
		for (const target of [owned, sibling]) expect((await edit(target))?.block).toBe(true);
		if (transition.startsWith("reassigned")) expect(await edit(owned, "Replacement")).toBeUndefined();
	});
}

test("missing parent assignment fails closed; an assigned row with omitted resources retains documented cwd access", async () => {
	const { row, worker } = fixture();
	row.schedule!.resources = undefined;
	expect(await workerToolPreflight({ toolName: "edit", input: { path: sibling } }, worker())).toBeUndefined();
	expect(
		(await workerToolPreflight({ toolName: "edit", input: { path: sibling } }, worker("Unassigned")))?.block,
	).toBe(true);
	const orphan = { ...worker(), agent: { ...worker().agent!, parentId: "Missing" } } as ExtensionContext;
	expect((await workerToolPreflight({ toolName: "edit", input: { path: sibling } }, orphan))?.block).toBe(true);
	row.schedule!.resources = [];
	expect((await workerToolPreflight({ toolName: "edit", input: { path: sibling } }, worker()))?.block).toBe(true);
});

test("explicit revocation survives admission, and only a lead schedule update can grant a new path", async () => {
	const { row, lead } = fixture();
	row.schedule!.resources = [];
	const event = {
		type: "before_subagent_spawn",
		agent: "coder",
		invocationKind: "task",
		patterns: [],
		row: row.content,
		spawnKey: "Replacement",
		resources: [sibling],
		readOnly: false,
	} as BeforeSubagentSpawnEvent;
	expect(admitAssignedResources(event, lead)).toContain("resources exceed row");
	expect(row.schedule!.resources).toEqual([]);
	lead.updateTodoSchedule!(row.content, { resources: [sibling] });
	expect(admitAssignedResources(event, lead)).toBeUndefined();
	expect(row.schedule!.resources).toEqual([sibling]);
});

for (const executable of ["cp", "install"]) {
	for (const option of ["-t /outside", "-t/outside", "--target-directory /outside", "--target-directory=/outside"]) {
		test(`${executable} ${option} validates the actual output destination`, async () => {
			const { worker } = fixture();
			expect(
				(
					await workerToolPreflight(
						{ toolName: "bash", input: { command: `${executable} ${option} ${owned}` } },
						worker(),
					)
				)?.block,
			).toBe(true);
		});
	}
	test(`${executable} target-directory allows exactly the permitted destination file`, async () => {
		const { worker } = fixture();
		expect(
			await workerToolPreflight(
				{ toolName: "bash", input: { command: `${executable} -t ${root} /input/owned.ts` } },
				worker(),
			),
		).toBeUndefined();
		expect(
			(
				await workerToolPreflight(
					{ toolName: "bash", input: { command: `${executable} -t ${root} /input/owned.ts /input/unowned.ts` } },
					worker(),
				)
			)?.block,
		).toBe(true);
	});
}

for (const prefix of [
	"mkdir -pm 700",
	"mkdir -pm700",
	"mkdir --mode=700 -p",
	"mkdir -m 700 --",
	"truncate -s 0",
	"truncate -s0",
	"truncate --size=0",
	"truncate -r /input/reference",
	"touch -t 202611101930",
	"touch -at202611101930",
	"touch --date yesterday",
	"touch -r /input/reference",
	"install -dm 700",
]) {
	test(`${prefix} treats option values as values while preserving real path checks`, async () => {
		const { worker } = fixture();
		expect(
			await workerToolPreflight({ toolName: "bash", input: { command: `${prefix} ${owned}` } }, worker()),
		).toBeUndefined();
		expect(
			(await workerToolPreflight({ toolName: "bash", input: { command: `${prefix} ${sibling}` } }, worker()))?.block,
		).toBe(true);
	});
}

test("-- ends option parsing and a live replacement lease stays protected", async () => {
	const { worker, row } = fixture();
	for (const command of [`mkdir -- -m700 ${owned}`, `touch -- -t ${owned}`])
		expect((await workerToolPreflight({ toolName: "bash", input: { command } }, worker()))?.block).toBe(true);
	row.schedule!.owner = "Replacement";
	expect(
		await workerToolPreflight({ toolName: "write", input: { path: owned } }, worker("Replacement")),
	).toBeUndefined();
	expect((await workerToolPreflight({ toolName: "write", input: { path: owned } }, worker()))?.block).toBe(true);
});
