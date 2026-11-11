import { expect, test } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { SessionEntry } from "../../src/session/session-entries";
import type { RequirementEntryMetadata } from "../../src/session/requirements-branch-selection";
import { createRequirementCandidates } from "../../src/tools/requirements-ledger";
import type { ToolSession } from "../../src/tools";
import { getRequirementArtifactTodoPhases, TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

const phases: TodoPhase[] = [
	{
		name: "Work",
		tasks: [{ content: "Current", status: "pending", artifactCwd: "/tmp/current", artifactOwner: "main" }],
	},
];
const entry = (id: string, customType: string, data: unknown): SessionEntry => ({
	type: "custom",
	id,
	parentId: null,
	timestamp: "2026-11-07T00:00:00Z",
	customType,
	data,
});
const metadata = (value: SessionEntry): RequirementEntryMetadata => ({
	type: value.type,
	customType: value.type === "custom" ? value.customType : undefined,
});

test("50 real TodoTool executions decode current state rather than 300k obsolete edits", async () => {
	const history = Array.from({ length: 300_000 }, (_, i) =>
		entry(String(i), USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] }),
	);
	history.push(entry("current", USER_TODO_EDIT_CUSTOM_TYPE, { phases }));
	history.push(entry("ledger", "requirements_ledger", { version: 1, requirements: [] }));
	let decoded = 0;
	let branch = history;
	const decode = (value: SessionEntry): SessionEntry => {
		decoded++;
		return JSON.parse(JSON.stringify(value));
	};
	const manager = {
		getBranch: () => branch.map(decode),
		appendCustomEntry: (customType: string, data: unknown) =>
			branch.push(entry(`saved-${branch.length}`, customType, data)),
		flush: async () => {},
		getBranchMatching: (predicate: (entry: RequirementEntryMetadata) => boolean) =>
			branch.filter(value => predicate(metadata(value))).map(decode),
		*iterateBranchMatchingNewestFirst(predicate: (entry: RequirementEntryMetadata) => boolean) {
			for (let i = branch.length - 1; i >= 0; i--) if (predicate(metadata(branch[i]!))) yield decode(branch[i]!);
		},
		getLeafId: () => branch.at(-1)?.id ?? null,
		getEntryCount: () => branch.length,
		bodyRevision: 0,
	};
	let live = structuredClone(phases);
	const session = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		sessionManager: manager,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getTodoPhases: () => live,
		setTodoPhases: (next: TodoPhase[]) => {
			live = next;
		},
	} as unknown as ToolSession;
	const tool = new TodoTool(session);
	for (let i = 0; i < 50; i++) {
		const result = await tool.execute(String(i), { op: "view" });
		expect(result.isError).toBeUndefined();
		expect(result.details?.phases[0]?.tasks[0]?.artifactCwd).toBe("/tmp/current");
		expect(getRequirementArtifactTodoPhases(manager)[0]?.tasks[0]?.content).toBe("Current");
	}
	expect(decoded).toBeLessThanOrEqual(50 * 3);
	history.push(
		entry("candidate", "requirements_ledger", {
			version: 1,
			requirements: createRequirementCandidates([], ["Deliver Current"], "2026-11-07T00:00:00Z"),
		}),
	);
	const firstDone = await tool.execute("bootstrap-done", { op: "done", task: "Current" });
	expect(firstDone.isError).toBe(true);
	expect(decoded).toBeLessThanOrEqual(50 * 3 + 8);
	decoded = 0;
	for (let i = 0; i < 50; i++) {
		history.push(entry(`append-${i}`, USER_TODO_EDIT_CUSTOM_TYPE, { phases }));
		const result = await tool.execute(`done-${i}`, { op: "done", task: "Current" });
		expect(result.isError).toBe(true);
		expect(result.content.some(part => part.type === "text" && part.text.includes("R1"))).toBe(true);
	}
	expect(decoded).toBeLessThanOrEqual(50 * 8);

	// An unrelated archived requirement must never demand a historical row fold
	// while completing the current linked row, including the first cold gate.
	const linked = createRequirementCandidates(
		[],
		["Deliver Current", "Old archived delivery"],
		"2026-11-07T00:00:00Z",
	).map((requirement, i) => ({
		...requirement,
		classification: "linked",
		rows: [i === 0 ? "Current" : "Archived unrelated"],
	}));
	history.push(entry("linked-ledger", "requirements_ledger", { version: 1, requirements: linked }));
	decoded = 0;
	for (let i = 0; i < 3; i++) {
		if (i > 0) history.push(entry(`linked-append-${i}`, USER_TODO_EDIT_CUSTOM_TYPE, { phases }));
		const result = await tool.execute(`linked-done-${i}`, { op: "done", task: "Current" });
		expect(result.isError).toBe(true);
		expect(result.content.some(part => part.type === "text" && part.text.includes("R1"))).toBe(true);
	}
	expect(decoded).toBeLessThanOrEqual(3 * 10);

	// A persisted legacy receipt explicitly demands exact historical row changes
	// once. Repeated blocked gates must advance that fold across only the new tail.
	const legacy = linked.map(requirement =>
		requirement.rows.includes("Current")
			? {
					...requirement,
					rowVerdicts: {
						Current: {
							status: "pass",
							artifact: "saved artifact",
							evidence: "Reviewed saved state",
							workerId: "qa-fixture",
							auditor: "qa-auditor",
							rawWords: requirement.rawText,
							receivedAt: "2026-11-07T00:00:01Z",
						},
					},
				}
			: requirement,
	);
	history.push(entry("legacy-ledger", "requirements_ledger", { version: 1, requirements: legacy }));
	decoded = 0;
	expect((await tool.execute("legacy-cold", { op: "done", task: "Current" })).isError).toBe(true);
	expect(decoded).toBeGreaterThanOrEqual(300_000);
	decoded = 0;
	for (let i = 0; i < 3; i++) {
		history.push(entry(`legacy-append-${i}`, USER_TODO_EDIT_CUSTOM_TYPE, { phases }));
		history.push(entry(`legacy-ledger-${i}`, "requirements_ledger", { version: 1, requirements: legacy }));
		expect((await tool.execute(`legacy-done-${i}`, { op: "done", task: "Current" })).isError).toBe(true);
	}
	expect(decoded).toBeLessThanOrEqual(3 * 12);

	branch = [entry("other", USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] })];
	expect(getRequirementArtifactTodoPhases(manager)).toEqual([]);
	branch = [entry("replacement", USER_TODO_EDIT_CUSTOM_TYPE, { phases })];
	expect(getRequirementArtifactTodoPhases(manager)[0]?.tasks[0]?.artifactCwd).toBe("/tmp/current");
}, 60_000);
