import { beforeAll, expect, test } from "bun:test";
import { renderLeadRowInstructions } from "./lead-row-instructions";
import type { TodoScheduleInputTask } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { TodoDisplayState } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import {
	expectedDisplayActions,
	leadInstructionScenarios,
	type LeadInstructionScenario,
	verifyLeadRoundTrip,
} from "./lead-instructions.scenarios";

let scenarios: LeadInstructionScenario[];
beforeAll(async () => {
	scenarios = await leadInstructionScenarios();
});

const contracts: Record<string, { tool?: string; operation?: string; wait?: boolean; handoff?: boolean }> = {
	"unseen-product-decision": { handoff: true },
	working: { wait: true },
	waiting: { wait: true },
	verifying: { wait: true },
	"audit-queued": { wait: true },
	"handoff-pending": { handoff: true },
	auditing: { wait: true },
	"ready-to-close": { tool: "todo", operation: "done" },
	"needs-you": { wait: true },
	"findings-only": { tool: "task" },
	aborted: { tool: "task" },
	failed: { tool: "task" },
	refused: { tool: "task" },
	"estimate-cap": {},
	"external-blocker": { wait: true },
	"lost-after-restart": { tool: "task" },
	"audit-fail": { tool: "task" },
	"missing-executable-proof": { tool: "task" },
	"head-moved": { wait: true },
	"eta-reached": { tool: "todo", operation: "schedule" },
	"user-answered-review": { tool: "todo", operation: "schedule" },
	"blocked-on-user": {},
	"blocked-user-already-asked": { wait: true },
	"review-page-accept": {},
	"review-page-redo": { tool: "task" },
	"review-page-drop": {},
	"owner-question-telegram": { tool: "todo", operation: "schedule" },
	"never-handed-to-owner": { handoff: true },
	"running-worker-scope": { wait: true },
	"capacity-full": { wait: true },
};

test("every consumer display state and scenario has an instruction contract", () => {
	expect([...new Set(scenarios.map(scenario => scenario.state))].sort()).toEqual(
		(Object.keys(expectedDisplayActions) as TodoDisplayState[]).sort(),
	);
	expect(scenarios.map(scenario => scenario.id).sort()).toEqual(Object.keys(contracts).sort());
	for (const scenario of scenarios) expect(expectedDisplayActions[scenario.state as TodoDisplayState]).toBeDefined();
});

for (const id of Object.keys(contracts)) {
	test(`${id}: lead receives a row-specific next action without conflicting turn notices`, async () => {
		const scenario = scenarios.find(scenario => scenario.id === id)!;
		const contract = contracts[id]!;
		if (id === "review-page-accept" || id === "review-page-drop") {
			expect(await verifyLeadRoundTrip(scenario, [])).toBe(true);
			for (const notice of scenario.notices) expect(notice).not.toContain("until the user responds");
			return;
		}
		expect(scenario.state).toBe(scenario.expectedState);
		const notice = scenario.notices.find(
			text => text.includes(JSON.stringify(scenario.row)) && (text.includes("NEXT ACTION") || text.includes("WAIT")),
		);
		expect(notice, `${id}: next action missing from actual turn_end notices`).toBeDefined();
		if (!notice) return;
		if (id === "capacity-full") {
			expect(notice).toContain("all worker slots are busy");
			expect(notice).not.toContain("undefined");
		}
		if (contract.tool) {
			expect(notice).toContain(contract.tool);
			expect(notice).toContain(JSON.stringify(scenario.row));
			if (contract.operation) expect(notice).toContain(contract.operation);
			if (contract.tool === "write") expect(notice).toContain("/kill");
			if (contract.tool === "task") {
				expect(notice).toContain("tasks:");
				expect(notice).toContain("task:");
			}
		} else if (contract.handoff) {
			expect(notice).toContain("send review page http://review.invalid/card");
			expect(notice).toContain("handoffPending:false after sending");
		} else if (contract.wait) {
			expect(notice.toLowerCase()).toContain("wait");
			expect(notice).not.toContain("NEXT ACTION:");
			for (const text of scenario.notices) {
				expect(text).not.toContain("Use todo view for current rows");
				expect(text).not.toContain("check ready and lost-owner rows next");
			}
			for (const text of scenario.notices.filter(text => text.includes(JSON.stringify(scenario.row)))) {
				// A staffing, ETA or unblock demand for a runtime/user-owned row caused the live failure.
				expect(text).not.toContain("Staff ");
				expect(text).not.toContain("ETA approaching");
				expect(text).not.toContain("Ask the user now");
			}
		} else if (id === "estimate-cap") {
			expect(notice).toContain("NEXT ACTION: inspect the current result");
			expect(notice).toContain("split only genuinely independent remaining deliverables");
			expect(notice).toContain("A cap does not itself require another row");
			expect(notice).toContain("If unsplittable, preserve its running owner and output");
			expect(notice).not.toContain('op:"append"');
		} else {
			expect(notice).toContain("Which endpoint?");
		}
		if (id === "eta-reached" || id === "estimate-cap") {
			for (const text of scenario.notices) expect(text).not.toContain("/kill");
		}
		if (contract.wait) {
			const summary = scenario.notices.find(text => text.includes("TODO status:"));
			expect(summary).toContain("0 ready without a verified owner");
			expect(summary).toContain("0 lost owners");
		}
		if (id === "missing-executable-proof") {
			expect(notice).toContain("run the named focused checks");
			expect(notice).toContain("inspected desktop/phone screenshots");
		}
		if (id === "audit-fail") expect(notice).toContain("Settings still exposes the wrong return edge");
		if (contract.tool !== "task") {
			for (const text of scenario.notices.filter(text => text.startsWith("Staff ")))
				expect(text).not.toContain(JSON.stringify(scenario.row));
		}
	});
}

test("unseen product decisions precede confirmations and saved answers do not ask again", () => {
	const make = (content: string): TodoScheduleInputTask => ({
		content,
		status: "in_progress",
		schedule: { review: "user", firstDeliveredAt: 1, handoffPending: true },
	});
	const confirmation = make("Confirm the release date");
	const product = make("Showcase scenario");
	product.schedule!.decision = "owner";
	const answered = make("Answered scenario");
	answered.schedule!.decision = "owner";
	answered.schedule!.reviewAnswers = ["page/card/hash/accept"];
	const text = renderLeadRowInstructions(
		[{ name: "Review", tasks: [confirmation, answered, product] }],
		{ workers: [], owners: new Map() },
		{ now: 100 },
	);
	expect(text.indexOf('Row "Showcase scenario"')).toBeLessThan(text.indexOf('Row "Confirm the release date"'));
	expect(text).not.toContain('publish a review page for rows "Answered scenario"');
});
