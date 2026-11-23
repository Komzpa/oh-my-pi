import { expect, test } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { buildTodoSchedulePatchEdit, patchTodoSchedule } from "../src/session/todo-schedule-patch";

const initial = (): TodoPhase[] => [{ name: "Ship", tasks: [{ content: "Delivery", status: "completed" }] }];

test("new nonblocking audit advice retains accepted delivery and work count", () => {
	const rows = patchTodoSchedule(initial(), "Delivery", { auditFollowUps: ["Consider this later"] })!;
	expect(rows.flatMap(phase => phase.tasks)).toHaveLength(1);
	expect(rows[0]!.tasks[0]!.status).toBe("completed");
	expect(rows[0]!.tasks[0]!.notes).toEqual(["Consider this later"]);
	expect(buildTodoSchedulePatchEdit("Delivery", {}).adviceOnly).toBe(true);
});

test("legacy row-producing transitions remain available only for old persisted deltas", () => {
	const rows = patchTodoSchedule(initial(), "Delivery", { auditFollowUps: ["Old evidence"] }, 1, {
		legacyFollowUps: true,
	})!;
	expect(rows.flatMap(phase => phase.tasks)).toHaveLength(2);
	const legacy = rows[1]!.tasks[0]!;
	expect(legacy.content).toBe("Audit follow-up: Delivery");
	expect(legacy.notes).toContain("Old evidence");
	const current = patchTodoSchedule(rows, "Delivery", { auditFollowUps: ["New advice"] })!;
	expect(current[1]!.tasks[0]).toBe(legacy);
	expect(current[0]!.tasks[0]!.notes).toEqual(["New advice"]);
});

test("actual blocking audit defect still requires repair", () => {
	const rows = patchTodoSchedule(initial(), "Delivery", {
		deliveryCritic: { verdict: "defects", startedAt: 2, key: "x", findings: [] },
		review: "redo",
	})!;
	expect(rows[0]!.tasks[0]!.status).toBe("pending");
	expect(rows.flatMap(phase => phase.tasks)).toHaveLength(1);
});
