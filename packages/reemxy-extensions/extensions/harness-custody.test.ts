import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { admitAssignedResources } from "./agent_router";
import { todoArtifactGitBinding } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { workerToolPreflight } from "./dispatch_preflight";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { BeforeSubagentSpawnEvent } from "@oh-my-pi/pi-coding-agent";

afterEach(() => vi.restoreAllMocks());

function spawnEvent(event: BeforeSubagentSpawnEvent): BeforeSubagentSpawnEvent {
	return event;
}

test("narrowing a writer claim preserves the separately declared exact audit revision", () => {
	const output = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pin-repro-"));
	try {
		const pin = "git:/home/kom/proj/ai_pr/omp-lane-chainloop-20261110@14449d1fa054975c94a65cff52a56a854e327955";
		const row = {
			content: "Capture frozen revision",
			status: "pending" as const,
			schedule: { resources: [output, pin] },
		};
		const before = todoArtifactGitBinding(row);
		const ctx = {
			cwd: output,
			getTodoPhases: () => [{ name: "Proof", tasks: [row] }],
			updateTodoSchedule: (_task: string, patch: object) => {
				Object.assign(row.schedule, patch);
				return true;
			},
		};
		expect(before?.head).toBe("14449d1fa054975c94a65cff52a56a854e327955");
		expect(
			admitAssignedResources(
				spawnEvent({
					type: "before_subagent_spawn",
					agent: "coder",
					invocationKind: "task",
					patterns: [],
					row: row.content,
					spawnKey: "WrongScope",
					readOnly: false,
					resources: [output + "-outside"],
				}),
				ctx as unknown as ExtensionContext,
			),
		).toContain("resources exceed row");
		expect(
			admitAssignedResources(
				spawnEvent({
					type: "before_subagent_spawn",
					agent: "coder",
					invocationKind: "task",
					patterns: [],
					row: row.content,
					spawnKey: "Capture",
					readOnly: false,
					resources: [output],
				}),
				ctx as unknown as ExtensionContext,
			),
		).toBeUndefined();
		expect(todoArtifactGitBinding(row)).toEqual(before);
	} finally {
		fs.rmSync(output, { recursive: true, force: true });
	}
});

test("mkdir mode is not misread as an undeclared output path while real escapes stay blocked", async () => {
	const registry = new AgentRegistry();
	const spy = vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: {
			activeToolExecutionUpdates() {},
			getTodoPhases: () => [
				{
					name: "Evidence",
					tasks: [
						{
							content: "Write evidence",
							status: "in_progress",
							schedule: { owner: "EvidenceWriter", resources: ["/isolated-evidence"] },
						},
					],
				},
			],
		} as unknown as AgentSessionHandle,
	});
	const ctx = { cwd: "/project", agent: { kind: "sub", id: "EvidenceWriter", parentId: "Lead" } } as ExtensionContext;
	try {
		expect(
			(await workerToolPreflight({ toolName: "bash", input: { command: "mkdir -m 700 /outside-evidence" } }, ctx))
				?.block,
		).toBe(true);
		expect(
			await workerToolPreflight({ toolName: "bash", input: { command: "mkdir -p /isolated-evidence" } }, ctx),
		).toBeUndefined();
		expect(
			await workerToolPreflight({ toolName: "bash", input: { command: "mkdir -m 700 /isolated-evidence" } }, ctx),
		).toBeUndefined();
		for (const option of ["-m700", "--mode 700", "--mode=700", "-m 700 --"]) {
			expect(
				await workerToolPreflight(
					{ toolName: "bash", input: { command: `mkdir ${option} /isolated-evidence` } },
					ctx,
				),
			).toBeUndefined();
			expect(
				(
					await workerToolPreflight(
						{ toolName: "bash", input: { command: `mkdir ${option} /outside-evidence` } },
						ctx,
					)
				)?.block,
			).toBe(true);
		}
		expect(
			(await workerToolPreflight({ toolName: "bash", input: { command: "mkdir -- -m700 /isolated-evidence" } }, ctx))
				?.block,
		).toBe(true);
	} finally {
		spy.mockRestore();
	}
});

test("admission and first write agree about an unchanged settled owner's retained scope", async () => {
	const target = "/tmp/omp-custody-contract-fixture/doc/requirements.md";
	const old = {
		content: "Existing package owner",
		status: "in_progress" as const,
		schedule: {
			owner: "OldWriter",
			resources: ["/tmp/omp-custody-contract-fixture"],
			executor: { workerId: "OldWriter", startedAt: 10 },
		},
	};
	const incoming = {
		content: "Write source-bound requirements",
		status: "pending" as const,
		schedule: { owner: "NewWriter", resources: [target] },
	};
	const phases: TodoPhase[] = [{ name: "Work", tasks: [old, incoming] }];
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: { activeToolExecutionUpdates() {}, getTodoPhases: () => phases } as unknown as AgentSessionHandle,
	});
	const lead = { cwd: "/tmp", getTodoPhases: () => phases } as ExtensionContext;
	const worker = { cwd: "/tmp", agent: { kind: "sub", id: "NewWriter", parentId: "Lead" } } as ExtensionContext;
	const assignment: BeforeSubagentSpawnEvent = {
		type: "before_subagent_spawn",
		agent: "coder",
		invocationKind: "task",
		patterns: [],
		row: incoming.content,
		spawnKey: "NewWriter",
		readOnly: false,
		resources: [target],
	};
	const write = { toolName: "edit", input: { path: target } };
	// A live holder is not silently released by the new writer's requested scope.
	expect(admitAssignedResources(assignment, lead, false)).toBeDefined();
	expect((await workerToolPreflight(write, worker))?.block).toBe(true);
	// Explicitly removing the old claim permits the new owner in both phases.
	old.schedule.resources = [];
	expect(admitAssignedResources(assignment, lead, false)).toBeUndefined();
	expect(await workerToolPreflight(write, worker)).toBeUndefined();
	// Restore retained scope and settle the old executor. No intervening plan
	// change is allowed to make admission and the first write disagree.
	old.schedule.resources = ["/tmp/omp-custody-contract-fixture"];
	Object.assign(old.schedule.executor, { outcome: "completed", finishedAt: 20 });
	const admitted = admitAssignedResources(assignment, lead, false) === undefined;
	const writeAllowed = (await workerToolPreflight(write, worker))?.block !== true;
	// The owner may choose to retain or release settled custody, but the two
	// policy phases must make the same choice. This does not demand a bypass.
	expect(admitted).toBe(true);
	expect(writeAllowed).toBe(true);
	old.schedule.owner = "RetainedWriter";
	expect(admitAssignedResources(assignment, lead, false)).toBeDefined();
	expect((await workerToolPreflight(write, worker))?.block).toBe(true);
	old.schedule.resources = [];
	expect(admitAssignedResources(assignment, lead, false)).toBeUndefined();
	expect(await workerToolPreflight(write, worker)).toBeUndefined();
});

test("clearing an explicit worker scope must not grant writes to its inherited checkout root", async () => {
	const root = "/tmp/omp-empty-scope-contract-fixture";
	const target = `${root}/src/owned.ts`;
	const row = {
		content: "Narrow writer",
		status: "in_progress" as const,
		schedule: { owner: "Writer", resources: [target] },
	};
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: {
			activeToolExecutionUpdates() {},
			getTodoPhases: () => [{ name: "Plan", tasks: [row] }],
		} as unknown as AgentSessionHandle,
	});
	const worker = { cwd: root, agent: { kind: "sub", id: "Writer", parentId: "Lead" } } as ExtensionContext;
	// Only evaluate policy decisions. No edit or shell command is executed.
	expect(await workerToolPreflight({ toolName: "edit", input: { path: target } }, worker)).toBeUndefined();
	expect(
		(await workerToolPreflight({ toolName: "edit", input: { path: `${root}/src/unowned.ts` } }, worker))?.block,
	).toBe(true);
	// TaskItem documents [] as "owns nothing"; a native live scope change must
	// revoke the grant, not reinterpret the empty array as an entire cwd grant.
	row.schedule.resources = [];
	expect(
		(await workerToolPreflight({ toolName: "edit", input: { path: `${root}/src/unowned.ts` } }, worker))?.block,
	).toBe(true);
});

test("explicit release revokes an acquired target claim while retained live custody still blocks", async () => {
	const target = "/tmp/omp-retained-claim-fixture/owned.ts";
	const old = { content: "Old", status: "in_progress" as const, schedule: { owner: "Old", resources: [target] } };
	const next = { content: "Next", status: "pending" as const, schedule: { owner: "Next", resources: [target] } };
	const phases: TodoPhase[] = [{ name: "Work", tasks: [old, next] }];
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: { activeToolExecutionUpdates() {}, getTodoPhases: () => phases } as unknown as AgentSessionHandle,
	});
	const worker = (id: string) => ({ cwd: "/tmp", agent: { kind: "sub", id, parentId: "Lead" } }) as ExtensionContext;
	const edit = { toolName: "edit", input: { path: target } };
	next.schedule.resources = [];
	expect(await workerToolPreflight(edit, worker("Old"))).toBeUndefined();
	next.schedule.resources = [target];
	expect((await workerToolPreflight(edit, worker("Next")))?.block).toBe(true);
	old.schedule.resources = [];
	expect(await workerToolPreflight(edit, worker("Next"))).toBeUndefined();
	expect((await workerToolPreflight(edit, worker("Old")))?.block).toBe(true);
});

test("an admitted read-only owner cannot use retained bash to write its artifact path", async () => {
	const target = "/tmp/omp-readonly-owner-contract-fixture/source.ts";
	const row = {
		content: "Inspect frozen artifact",
		status: "in_progress" as const,
		schedule: {
			owner: "Reader",
			resources: [target],
			ownerReadOnly: { owner: "PreviousReader", readOnly: true },
		},
	};
	const phases = [{ name: "Proof", tasks: [row] }];
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: { activeToolExecutionUpdates() {}, getTodoPhases: () => phases } as unknown as AgentSessionHandle,
	});
	const lead = {
		cwd: "/tmp",
		getTodoPhases: () => phases,
		updateTodoSchedule: (_task: string, patch: object) => {
			Object.assign(row.schedule, patch);
			return true;
		},
	} as ExtensionContext;
	const worker = { cwd: "/tmp", agent: { kind: "sub", id: "Reader", parentId: "Lead" } } as ExtensionContext;
	const shellWrite = { toolName: "bash", input: { command: `touch ${target}` } };
	// A stale different owner's read-only marker must not revoke this writer.
	expect(await workerToolPreflight(shellWrite, worker)).toBeUndefined();
	expect(
		admitAssignedResources(
			spawnEvent({
				type: "before_subagent_spawn",
				agent: "reviewer",
				invocationKind: "task",
				patterns: [],
				row: row.content,
				spawnKey: "Reader",
				readOnly: true,
				resources: [],
			}),
			lead,
		),
	).toBeUndefined();
	expect(row.schedule.ownerReadOnly).toEqual({ owner: "Reader", readOnly: true });
	// Read commands still work; only the policy is evaluated, never the shell.
	expect(await workerToolPreflight({ toolName: "bash", input: { command: `cat ${target}` } }, worker)).toBeUndefined();
	expect((await workerToolPreflight(shellWrite, worker))?.block).toBe(true);
	for (const toolName of ["edit", "write"]) {
		expect((await workerToolPreflight({ toolName, input: { path: target } }, worker))?.block).toBe(true);
	}
	expect(
		(await workerToolPreflight({ toolName: "bash", input: { command: `printf x > ${target}` } }, worker))?.block,
	).toBe(true);
});

test("undeclared scope keeps cwd writes subject to live leases; explicit empty scope revokes them", async () => {
	const root = "/tmp/omp-absent-scope-contract-fixture";
	const owned = `${root}/owned.ts`;
	const leased = `${root}/leased.ts`;
	const row: TodoPhase["tasks"][number] = { content: "Writer", status: "in_progress", schedule: { owner: "Writer" } };
	const holder = {
		content: "Live holder",
		status: "in_progress" as const,
		schedule: { owner: "Holder", resources: [leased], executor: { workerId: "Holder", startedAt: 10 } },
	};
	const phases: TodoPhase[] = [{ name: "Work", tasks: [row, holder] }];
	const registry = new AgentRegistry();
	vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
	registry.register({
		id: "Lead",
		displayName: "Lead",
		kind: "main",
		session: { activeToolExecutionUpdates() {}, getTodoPhases: () => phases } as unknown as AgentSessionHandle,
	});
	const worker = { cwd: root, agent: { kind: "sub", id: "Writer", parentId: "Lead" } } as ExtensionContext;
	const edit = (target: string) => workerToolPreflight({ toolName: "edit", input: { path: target } }, worker);
	// Absent is undeclared: legacy cwd permission still obeys other writers' leases.
	expect(await edit(owned)).toBeUndefined();
	expect((await edit(`${root}-outside/owned.ts`))?.block).toBe(true);
	expect((await edit(leased))?.block).toBe(true);
	row.schedule!.resources = [owned];
	expect(await edit(owned)).toBeUndefined();
	expect((await edit(leased))?.block).toBe(true);
	row.schedule!.resources = [];
	expect((await edit(owned))?.block).toBe(true);
	expect((await edit(leased))?.block).toBe(true);
	for (const toolName of ["write", "ast_edit"]) {
		expect((await workerToolPreflight({ toolName, input: { path: owned } }, worker))?.block).toBe(true);
	}
	for (const command of [`touch ${owned}`, `mkdir -m 700 ${root}/proof`]) {
		expect((await workerToolPreflight({ toolName: "bash", input: { command } }, worker))?.block).toBe(true);
	}
});
