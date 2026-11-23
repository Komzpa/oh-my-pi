import type { SessionEntry } from "../src/session/session-entries";
import { describe, expect, it } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import {
	readTodoPlanHistory,
	TODO_PLAN_HISTORY_CUSTOM_TYPE,
	settleTodoPlanRecord,
	todoPlanMembers,
	todoPlanCalibrationHistory,
	type TodoPlanHistoryRecord,
} from "../src/tools/todo-plan-history";
const phases: TodoPhase[] = [
	{
		name: "work",
		tasks: [
			{ content: "a", status: "pending" },
			{ content: "b", status: "pending" },
		],
	},
];
function origin(): TodoPlanHistoryRecord {
	return {
		prediction: {
			sessionId: "s",
			originAt: 100,
			rawP50Finish: 200,
			predictionVersion: "v1",
			membershipFingerprint: "ab",
		},
		members: [...todoPlanMembers(phases).keys()],
	};
}
describe("persisted plan outcome", () => {
	it("requires every frozen member and excludes outcomes until observed", () => {
		const record = origin();
		const updated = structuredClone(phases);
		updated[0]!.tasks[0]!.status = "completed";
		updated[0]!.tasks[0]!.schedule = { finishedAt: 250 };
		expect(settleTodoPlanRecord(record, updated, 300)).toBeUndefined();
		updated[0]!.tasks[1]!.status = "completed";
		updated[0]!.tasks[1]!.schedule = { finishedAt: 350 };
		const settled = settleTodoPlanRecord(record, updated, 400)!;
		expect(settled.prediction.actualFinish).toBe(350);
		expect(todoPlanCalibrationHistory([settled], 400)).toEqual([]);
		expect(todoPlanCalibrationHistory([settled], 401)[0]!.rawP50Finish).toBe(200);
		expect(record.prediction.observedAt).toBeUndefined();
	});
	it("removal, abandonment and reset censor rather than train on a partial closure", () => {
		const record = origin();
		expect(settleTodoPlanRecord(record, [], 300)?.censoredAt).toBe(300);
		const updated = structuredClone(phases);
		updated[0]!.tasks[0]!.status = "abandoned";
		const censored = settleTodoPlanRecord(record, updated, 300)!;
		expect(todoPlanCalibrationHistory([censored], 500)).toEqual([]);
		expect(settleTodoPlanRecord(record, phases, 300, true)?.censoredAt).toBe(300);
	});
	it("duplicate rows remain distinct and future/backdated finishes cannot label an origin", () => {
		const updated = structuredClone(phases);
		updated[0]!.tasks[1]!.content = "a";
		expect(new Set(todoPlanMembers(updated).keys()).size).toBe(2);
		for (const row of updated[0]!.tasks) {
			row.status = "completed";
			row.schedule = { finishedAt: 99 };
		}
		const record = { ...origin(), members: [...todoPlanMembers(updated).keys()] };
		expect(settleTodoPlanRecord(record, updated, 300)).toBeUndefined();
		for (const row of updated[0]!.tasks) row.schedule = { finishedAt: 301 };
		expect(settleTodoPlanRecord(record, updated, 300)).toBeUndefined();
	});
});

describe("branch history replay", () => {
	it("rehydrates terminal labels, rejects rewritten predictions and drops rewound outcomes", () => {
		const initial = origin();
		const settled = { ...initial, prediction: { ...initial.prediction, observedAt: 500, actualFinish: 400 } };
		const entry = (id: string, data: TodoPlanHistoryRecord): SessionEntry => ({
			type: "custom",
			id,
			parentId: null,
			timestamp: "2026-11-07T00:00:00.000Z",
			customType: TODO_PLAN_HISTORY_CUSTOM_TYPE,
			data,
		});
		let branch = [entry("origin", initial), entry("settled", settled)];
		const manager = { getBranch: () => branch };
		expect(todoPlanCalibrationHistory(readTodoPlanHistory(manager), 501)[0]!.actualFinish).toBe(400);
		branch.push(entry("rewrite", { ...settled, prediction: { ...settled.prediction, rawP50Finish: 999 } }));
		expect(readTodoPlanHistory(manager)[0]!.prediction.rawP50Finish).toBe(200);
		branch = branch.slice(0, 1);
		expect(todoPlanCalibrationHistory(readTodoPlanHistory(manager), 501)).toEqual([]);
	});
});
