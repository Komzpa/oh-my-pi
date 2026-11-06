import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { SessionEntry } from "../../src/session/session-entries";
import type { RequirementEntryMetadata } from "../../src/session/requirements-branch-selection";
import {
	getRequirementRowArtifact,
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
