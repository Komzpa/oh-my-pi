import { expect, it } from "bun:test";
import { getRequirementHudCounts } from "../../src/modes/utils/requirement-hud-counts";
import { SessionManager } from "../../src/session/session-manager";
import {
	evaluateRequirementDoneGate,
	formatRequirementGateNotice,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	type RequirementLedgerItem,
} from "../../src/tools/requirements-ledger";
import { getClosedTodoRows, getCompletedTodoRows, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";

it("shows unaudited closed history separately, permits publication, and demands audits after reopening", async () => {
	const manager = SessionManager.inMemory();
	const requirements: RequirementLedgerItem[] = ["completed", "abandoned"].map((status, i) => ({
		id: `R${i + 1}`,
		at: "2026-11-06T09:00:00Z",
		rawText: status,
		classification: "linked",
		rows: [status],
	}));
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements });
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "History",
				tasks: [
					{ content: "completed", status: "completed" },
					{ content: "abandoned", status: "abandoned" },
				],
			},
		],
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
	let probes = 0;
	const check = () =>
		evaluateRequirementDoneGate(
			requirements,
			["completed", "abandoned"],
			async () => {
				probes++;
				return { head: null, dirty: false };
			},
			new Map(),
			getCompletedTodoRows(manager.getBranch()),
			new Set(),
			new Set(),
			getClosedTodoRows(manager.getBranch()),
		);
	expect(await check()).toEqual([]);
	expect(probes).toBe(0);
	expect(getRequirementHudCounts(manager)).toEqual({ total: 2, passed: 0, failed: 0, open: 0, legacyUnverified: 2 });
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [{ name: "Reopened", tasks: [{ content: "completed", status: "pending" }] }],
	});
	const open = await check();
	expect(open.map(item => item.requirement.id)).toEqual(["R1"]);
	expect(formatRequirementGateNotice(open)).toContain("R1");
	expect(getRequirementHudCounts(manager)).toEqual({ total: 2, passed: 0, failed: 0, open: 1, legacyUnverified: 1 });
	expect(probes).toBe(1);
});

it("keeps a real fail blocking even when all linked rows are abandoned", async () => {
	const manager = SessionManager.inMemory();
	const requirements: RequirementLedgerItem[] = [
		{
			id: "R1",
			at: "2026-11-06T09:00:00Z",
			rawText: "fix layout",
			classification: "linked",
			rows: ["failed", "unaudited"],
			rowVerdicts: {
				failed: {
					status: "fail",
					receivedAt: "2026-11-06T09:00:00Z",
					evidence: "layout clipped",
					artifact: "layout",
					auditor: "qa-auditor",
					workerId: "qa-1",
					rawWords: "fix layout",
					collateral: {
						screenshots: ["/tmp/layout.png"],
						defects: [{ screenshot: "/tmp/layout.png", region: "header", defect: "layout clipped" }],
					},
				},
			},
		},
	];
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements });
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "History",
				tasks: [
					{ content: "failed", status: "abandoned" },
					{ content: "unaudited", status: "abandoned" },
				],
			},
		],
	});
	const open = await evaluateRequirementDoneGate(
		requirements,
		["failed", "unaudited"],
		async () => ({ head: null, dirty: false }),
		new Map(),
		new Set(),
		new Set(),
		new Set(),
		getClosedTodoRows(manager.getBranch()),
	);
	expect(open.map(item => item.requirement.id)).toEqual(["R1"]);
	expect(getRequirementHudCounts(manager)).toEqual({ total: 1, passed: 0, failed: 1, open: 0, legacyUnverified: 0 });
});
