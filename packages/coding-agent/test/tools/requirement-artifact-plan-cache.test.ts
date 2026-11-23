import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { SessionManager } from "../../src/session/session-manager";
import type { SessionEntry } from "../../src/session/session-entries";
import type { RequirementEntryMetadata } from "../../src/session/requirements-branch-selection";
import {
	bindRequirementRowArtifact,
	getRequirementRowArtifact,
	getRequirementArtifactTodoPhases,
	type RequirementRowArtifact,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../src/tools/todo";

afterEach(() => mock.restore());

it("shares selected artifact plans across row lookups and invalidates appends, rewrites and branches", async () => {
	const phases: TodoPhase[] = [
		{ name: "Plan", tasks: Array.from({ length: 250 }, (_, i) => ({ content: `Row ${i}`, status: "pending" })) },
	];
	let leaf = "one";
	let revision = 0;
	let count = 1;
	let selections = 0;
	const snapshot = (cwd: string): SessionEntry => ({
		type: "custom",
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		id: leaf,
		parentId: null,
		timestamp: "2026-11-06T00:00:00Z",
		data: {
			phases: phases.map(phase => ({
				...phase,
				tasks: phase.tasks.map(task => ({ ...task, artifactCwd: cwd, artifactOwner: "main" })),
			})),
		},
	});
	let entries = [snapshot("/missing-artifact-one")];
	const manager = {
		getBranch(): SessionEntry[] {
			throw new Error("full journal materialization forbidden");
		},
		getLeafId: () => leaf,
		getEntryCount: () => count,
		get bodyRevision() {
			return revision;
		},
		getCachedBranchMatching(predicate: (metadata: RequirementEntryMetadata) => boolean) {
			selections++;
			expect(predicate({ type: "custom", customType: "unrelated" })).toBe(false);
			expect(predicate({ type: "custom", customType: USER_TODO_EDIT_CUSTOM_TYPE })).toBe(true);
			return entries;
		},
	};
	const context = { cwd: "/missing-session", sessionManager: manager };
	const checkouts = new Map<string, Promise<RequirementRowArtifact>>();
	const clone = spyOn(globalThis, "structuredClone");
	expect((await getRequirementRowArtifact(context, "Row 0", phases, checkouts)).cwd).toBe("/missing-artifact-one");
	const firstClones = clone.mock.calls.length;
	for (let row = 1; row < 250; row++)
		expect((await getRequirementRowArtifact(context, `Row ${row}`, phases, checkouts)).cwd).toBe(
			"/missing-artifact-one",
		);
	expect(selections).toBe(1);
	expect(clone.mock.calls.length).toBe(firstClones);
	leaf = "unrelated-message";
	count++;
	expect((await getRequirementRowArtifact(context, "Row 0", phases, checkouts)).cwd).toBe("/missing-artifact-one");
	expect(clone.mock.calls.length).toBe(firstClones);
	leaf = "two";
	count++;
	entries = [...entries, snapshot("/missing-artifact-two")];
	expect((await getRequirementRowArtifact(context, "Row 0", phases, checkouts)).cwd).toBe("/missing-artifact-two");
	revision++;
	entries = [snapshot("/missing-artifact-rewritten")];
	expect((await getRequirementRowArtifact(context, "Row 0", phases, checkouts)).cwd).toBe(
		"/missing-artifact-rewritten",
	);
	leaf = "branch";
	entries = [snapshot("/missing-artifact-branch")];
	expect((await getRequirementRowArtifact(context, "Row 0", phases, checkouts)).cwd).toBe("/missing-artifact-branch");
	expect(selections).toBe(5);
});

it("does not retain stale artifact bindings for a compatibility manager without revision stamps", async () => {
	let cwd = "/missing-compat-one";
	const phases: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "Ship", status: "pending" }] }];
	const manager = {
		getBranch: (): SessionEntry[] => [
			{
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				id: "same",
				parentId: null,
				timestamp: "2026-11-06T00:00:00Z",
				data: {
					phases: [
						{
							name: "Plan",
							tasks: [{ content: "Ship", status: "pending", artifactCwd: cwd, artifactOwner: "main" }],
						},
					],
				},
			},
		],
	};
	expect(
		(await getRequirementRowArtifact({ cwd: "/missing-session", sessionManager: manager }, "Ship", phases)).cwd,
	).toBe(cwd);
	cwd = "/missing-compat-two";
	expect(
		(await getRequirementRowArtifact({ cwd: "/missing-session", sessionManager: manager }, "Ship", phases)).cwd,
	).toBe(cwd);
});

it("shares TODO snapshots without full branch reads and refreshes after a plan append", () => {
	let selectedEntries: SessionEntry[] = [];
	const manager = Object.assign(SessionManager.inMemory("/tmp"), { getCachedBranchMatching: () => selectedEntries });
	const firstId = manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Plan", tasks: [{ content: "Ship", status: "pending" }] }],
	});
	selectedEntries = [manager.getEntry(firstId)!];
	spyOn(manager, "getBranch").mockImplementation(() => {
		throw new Error("full branch read forbidden");
	});
	const selected = spyOn(manager, "getCachedBranchMatching");
	const clone = spyOn(globalThis, "structuredClone");
	const first = getRequirementArtifactTodoPhases(manager);
	expect(first[0]?.tasks[0]?.status).toBe("pending");
	const firstClones = clone.mock.calls.length;
	getRequirementArtifactTodoPhases(manager);
	expect(selected).toHaveBeenCalledTimes(1);
	expect(clone.mock.calls.length).toBe(firstClones);
	manager.appendCustomEntry("unrelated", { ignored: true });
	getRequirementArtifactTodoPhases(manager);
	expect(clone.mock.calls.length).toBe(firstClones);
	const nextId = manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Plan", tasks: [{ content: "Ship", status: "completed" }] }],
	});
	selectedEntries = [...selectedEntries, manager.getEntry(nextId)!];
	expect(getRequirementArtifactTodoPhases(manager)[0]?.tasks[0]?.status).toBe("completed");
	expect(first[0]?.tasks[0]?.status).toBe("pending");
});

it("persists a worker checkout without mutating the shared selected plan or reading the full branch", async () => {
	let selectedEntries: SessionEntry[] = [];
	const manager = Object.assign(SessionManager.inMemory("/tmp"), { getCachedBranchMatching: () => selectedEntries });
	const id = manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Plan", tasks: [{ content: "Ship", status: "pending", schedule: { owner: "Worker" } }] }],
	});
	selectedEntries = [manager.getEntry(id)!];
	spyOn(manager, "getBranch").mockImplementation(() => {
		throw new Error("full branch read forbidden");
	});
	const phases = getRequirementArtifactTodoPhases(manager);
	await bindRequirementRowArtifact(
		{
			cwd: "/tmp",
			sessionManager: manager,
			executionCheckout: { owner: "Worker", cwd: "/missing-worker-checkout" },
		},
		"Ship",
		phases,
		{
			appendEntry(type, data) {
				const appended = manager.appendCustomEntry(type, data);
				selectedEntries = [...selectedEntries, manager.getEntry(appended)!];
			},
		},
	);
	expect(phases[0]?.tasks[0]?.artifactCwd).toBeUndefined();
	expect(getRequirementArtifactTodoPhases(manager)[0]?.tasks[0]).toMatchObject({
		artifactCwd: "/missing-worker-checkout",
		artifactOwner: "Worker",
	});
});
