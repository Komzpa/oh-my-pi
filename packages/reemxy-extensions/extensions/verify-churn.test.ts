import { expect, test } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { todoRowDeliveryKey } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { applyTodoExecutorObservation } from "@oh-my-pi/pi-coding-agent/tools/todo-executor";
import fixture from "./fixtures/dc-verify-churn.json";
import { queueDeliveryCritic, type DeliveryRow } from "./delivery_critic";
import * as leadRows from "./lead-row-instructions";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

test("DC snapshot: stakeholder reviews cannot replace the row executor or invalidate its audit", () => {
	const phases = [{ name: "DC", tasks: [structuredClone(fixture.row)] }] as TodoPhase[];
	for (const agentProfile of ["reviewer", "qa-auditor"]) {
		expect(
			applyTodoExecutorObservation(phases, {
				workerId: "NextReview",
				agentProfile,
				startedAt: 1793984600000,
				taskText: `Request: ${fixture.row.content}`,
			}),
		).toBeUndefined();
	}
	// Explicitly staffing a gate remains a real executor assignment.
	expect(
		applyTodoExecutorObservation(phases, {
			workerId: "ExecuteProof",
			agentProfile: "gate-runner",
			row: fixture.row.content,
			startedAt: 1793984600000,
		})?.[0].tasks[0].schedule?.executor?.workerId,
	).toBe("ExecuteProof");
});

test("DC snapshot: a read-only gate receipt cannot spawn another stakeholder review", () => {
	const row = structuredClone(fixture.row);
	Object.assign(row.schedule.executor, { finishedAt: 1793984600000, outcome: "completed" });
	let calls = 0;
	const ctx = {
		runDeliveryCritic: () => {
			calls++;
		},
		updateTodoSchedule: () => true,
		sessionManager: { getHeader: () => ({ id: "churn" }) },
		setTimeout: () => 1,
	} as unknown as ExtensionContext;
	expect(
		queueDeliveryCritic(
			ctx,
			row as unknown as DeliveryRow,
			JSON.stringify(fixture.receipt),
			async () => {},
			1,
			row.artifactCwd,
		),
	).toBe(false);
	expect(calls).toBe(0);
});

test("DC proof failure gives the lead one executable continuation with the revision and missing screens", () => {
	const row = structuredClone(fixture.row) as TodoPhase["tasks"][number];
	row.schedule!.audit = {
		delivery: todoRowDeliveryKey(row.schedule),
		agent: "qa-auditor",
		repoPath: fixture.row.artifactCwd,
		head: "f73f78a6147e1e16d26619b39ab698769e66e461",
		startedAt: 1793984600000,
		verdict: "fail",
		findings: fixture.row.schedule.progress.evidence,
	};
	const text = leadRows.renderLeadRowInstructions(
		[{ name: "DC", tasks: [row] }],
		{ workers: [], owners: new Map() },
		{ now: 1793984700000 },
	);
	expect(text).toContain('agent:"task"');
	expect(text).toContain("run the named focused checks");
	expect(text).toContain("f73f78a6147e1e16d26619b39ab698769e66e461");
	expect(text).toContain("inspected desktop/phone screenshots");
	expect(text).not.toContain("WAIT:");
	for (const agent of ["reviewer", "qa-auditor", "gate-runner"])
		expect(leadRows.refuseProofReview(row, agent, 1793984700000)).toContain("run the named focused checks");
	expect(leadRows.refuseProofReview(row, "task", 1793984700000)).toBeUndefined();
});
