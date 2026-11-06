import { expect, it } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { renderTodoPlanDisplay } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import fixture from "../fixtures/workerlink-land-orbit.json";
import {
	applyTodoExecutorObservation,
	todoMatchesObservedWorker,
	validateTodoExecutorRow,
} from "../../src/tools/todo-executor";
import { buildTodoExecutorPersistedEdit, getLatestTodoPhasesFromEntries } from "../../src/tools/todo";
import { taskItemSchema, taskSchema } from "../../src/task/types";

const row = fixture.phases[0].tasks[0].content;
const initial = (): TodoPhase[] => structuredClone(fixture.phases) as TodoPhase[];
const observation = {
	workerId: fixture.item.name,
	taskText: fixture.item.task,
	startedAt: 1793971288538,
	runningWorkerIds: new Set(["OrbitM1Call", "LandOrbitFix"]),
};

function display(phases: TodoPhase[], ids: string[]): string {
	const workers = ids.map(id => ({ id }));
	const owners = new Map();
	for (const task of phases.flatMap(phase => phase.tasks)) {
		const worker = [...workers]
			.reverse()
			.find(worker => todoMatchesObservedWorker(task, { workerId: worker.id, runningWorkerIds: new Set(ids) }));
		if (worker) owners.set(task.content, worker);
	}
	return renderTodoPlanDisplay(
		phases,
		{ workers, owners },
		{ now: observation.startedAt, paint: (_tone, text) => text },
	).lines.join("\n");
}

it("replays LandOrbitFix's real packet against the recorded OrbitM1Call row without leaving either worker unassigned", () => {
	const phases = applyTodoExecutorObservation(initial(), observation)!;
	expect(phases[0].tasks[0].schedule?.executor?.workerId).toBe("LandOrbitFix");
	const hud = display(phases, ["OrbitM1Call", "LandOrbitFix"]);
	expect(hud).toContain("working · LandOrbitFix");
	expect(hud).toContain("OrbitM1Call");
	expect(hud).not.toContain("unassigned workers");
});

it("uses explicit row ahead of misleading text and preserves it in both task schemas", () => {
	for (const schema of [taskItemSchema, taskSchema]) {
		expect(schema.assert({ task: "unrelated", row, solutionSpace: "one fix" })).toMatchObject({ row });
	}
	const phases = applyTodoExecutorObservation(initial(), { ...observation, taskText: "unrelated", row })!;
	expect(phases[0].tasks[0].schedule?.owner).toBe("LandOrbitFix");
	expect(validateTodoExecutorRow(phases, "missing")).toContain("does not exist");
	for (const status of ["completed", "abandoned"] as const) {
		phases[0].tasks[0].status = status;
		expect(validateTodoExecutorRow(phases, row)).toContain("closed");
		expect(applyTodoExecutorObservation(phases, { ...observation, row })).toBeUndefined();
	}
});

it("restores exact explicit membership through durable executor edits after restart", () => {
	const edit = buildTodoExecutorPersistedEdit({ ...observation, taskText: "# Target\nNo title here", row });
	const restored = getLatestTodoPhasesFromEntries([
		{ type: "custom", customType: "user_todo_edit", data: { phases: initial() } },
		{ type: "custom", customType: "user_todo_edit", data: { edit } },
	] as Parameters<typeof getLatestTodoPhasesFromEntries>[0]);
	expect(restored?.[0].tasks[0].schedule?.workerIds).toContain("LandOrbitFix");
	expect(display(restored!, ["LandOrbitFix"])).toContain("working · LandOrbitFix");
	expect(display(restored!, ["LandOrbitFix"])).not.toContain("unassigned");
});

it("reads Row before longer incidental titles and does not steal a live row via substring fallback", () => {
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Push", status: "pending" },
				{ content: "Some much longer incidental task title", status: "pending", schedule: { owner: "A" } },
			],
		},
	];
	const updated = applyTodoExecutorObservation(phases, {
		workerId: "B",
		startedAt: 1,
		taskText: "# Target\nRow: Push\n# Change\nSome much longer incidental task title",
		runningWorkerIds: new Set(["A", "B"]),
	})!;
	expect(updated[0].tasks[0].schedule?.owner).toBe("B");
	expect(updated[0].tasks[1].schedule?.owner).toBe("A");
});
