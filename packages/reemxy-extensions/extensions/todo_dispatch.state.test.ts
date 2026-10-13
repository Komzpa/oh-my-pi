import { describe, expect, test } from "bun:test";
import { boundedNotices, MAX_NOTICE_KEYS, noticeDigest, noticeKey, pruneSprintState, readPersistedSprintState, SPRINT_STATE_ENTRY_TYPE, type SprintState } from "./todo_dispatch";

const planCheck = (i: number) => `PLAN CHECK: 3 problem(s). (1) row ${i} ${"suspect risk ".repeat(300)}`;

describe("sprint state stays bounded", () => {
	test("1000 distinct plan checks keep the notice record small", () => {
		let notices: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) {
			const key = noticeKey("todo-plan-check", planCheck(i));
			notices = boundedNotices({ ...notices, [key]: noticeDigest(planCheck(i)) });
		}
		expect(Object.keys(notices)).toHaveLength(MAX_NOTICE_KEYS);
		expect(JSON.stringify(notices).length).toBeLessThan(64 * 1024);
		expect(notices[noticeKey("todo-plan-check", planCheck(999))]).toBe(noticeDigest(planCheck(999)));
		expect(notices[noticeKey("todo-plan-check", planCheck(0))]).toBeUndefined();
	});

	test("a legacy full-text state restores bounded and hashed", () => {
		const lastNotices = Object.fromEntries(
			Array.from({ length: 685 }, (_, i) => [`todo-plan-check\0${planCheck(i)}`, planCheck(i)]),
		);
		expect(JSON.stringify(lastNotices).length).toBeGreaterThan(1_000_000);
		const state = readPersistedSprintState([
			{ customType: "todo-dispatch-sprint-state", data: { version: 1, lastNotices } },
		]);
		expect(Object.keys(state.lastNotices)).toHaveLength(MAX_NOTICE_KEYS);
		expect(JSON.stringify(state).length).toBeLessThan(64 * 1024);
		expect(state.lastNotices[noticeKey("todo-plan-check", planCheck(684))]).toBe(noticeDigest(planCheck(684)));
	});
});

describe("sprint state prune keeps sessions bounded", () => {
	test("500 add/remove cycles with 10 live rows persist under 20 KB and rehydrate", () => {
		const now = Date.now();
		const live = Array.from({ length: 10 }, (_, i) => `live-row-${i}`);
		const dead = Array.from({ length: 500 }, (_, i) => `dead-row-${i}`);
		const all = [...live, ...dead];
		const state = {
			version: 1 as const,
			seenRows: [...all],
			lastPlanningSetKey: null,
			lastRetroAt: null,
			goalWorkStartedAt: null,
			rowStatuses: Object.fromEntries(all.map((r) => [r, "pending"])),
			reopenedRows: [...dead.slice(0, 100), ...live.slice(0, 2)],
			workerFinishes: dead.map((row, i) => ({ jobId: `job-${i}`, id: `id-${i}`, at: now - 24 * 3600_000, row })),
			seenJobIds: dead.map((_, i) => `job-${i}`),
			retroFacilitatorJobs: [],
			retroCoveredIds: [],
			retroReceiptIds: [],
			correctionPending: false,
			retroDueReason: null,
			lastNotices: Object.fromEntries(all.map((r) => [`todo-plan-check\0${r}`, "a1b2c3d4e5f60718"])),
			ignoredDemands: {},
		};
		const pruned = pruneSprintState(state, new Set(live), now);
		expect(JSON.stringify(pruned).length).toBeLessThan(20 * 1024);
		expect([...pruned.seenRows].sort()).toEqual([...live].sort());
		const branch = [{ customType: SPRINT_STATE_ENTRY_TYPE, data: pruned }];
		const rehydrated = readPersistedSprintState(branch);
		expect(rehydrated.seenRows).toEqual(pruned.seenRows);
		expect(rehydrated.rowStatuses).toEqual(pruned.rowStatuses);
		expect({ ...rehydrated, lastNotices: pruned.lastNotices }).toEqual(pruned);
	});

	test("a live row's seen flag survives pruning", () => {
		const state = {
			version: 1 as const,
			seenRows: ["live-row", "dead-row"],
			lastPlanningSetKey: null,
			lastRetroAt: null,
			goalWorkStartedAt: null,
			rowStatuses: { "live-row": "in_progress", "dead-row": "completed" },
			reopenedRows: ["dead-row"],
			workerFinishes: [],
			seenJobIds: [],
			retroFacilitatorJobs: [],
			retroCoveredIds: [],
			retroReceiptIds: [],
			correctionPending: false,
			retroDueReason: null,
			lastNotices: {},
			ignoredDemands: {},
		};
		const pruned = pruneSprintState(state, new Set(["live-row"]));
		expect(pruned.seenRows).toContain("live-row");
		expect(pruned.seenRows).not.toContain("dead-row");
		expect(Object.keys(pruned.rowStatuses)).toEqual(["live-row"]);
	});

	test("a burst of state changes in one turn appends exactly one entry", async () => {
		const live = new Set(["live-row"]);
		let state: SprintState = {
			version: 1 as const,
			seenRows: ["live-row"],
			lastPlanningSetKey: null,
			lastRetroAt: null,
			goalWorkStartedAt: null,
			rowStatuses: { "live-row": "in_progress" },
			reopenedRows: [],
			workerFinishes: [],
			seenJobIds: [],
			retroFacilitatorJobs: [],
			retroCoveredIds: [],
			retroReceiptIds: [],
			correctionPending: false,
			retroDueReason: null,
			lastNotices: {} as Record<string, string>,
			ignoredDemands: {},
		};
		const branch: unknown[] = [];
		let persistedJson = "";
		let scheduled = false;
		const flush = () => {
			scheduled = false;
			state = pruneSprintState(state, live);
			const json = JSON.stringify(state);
			if (json === persistedJson) return;
			persistedJson = json;
			branch.push({ customType: SPRINT_STATE_ENTRY_TYPE, data: state });
		};
		const persist = () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(flush);
		};
		for (let i = 0; i < 20; i++) {
			state = { ...state, lastNotices: { ...state.lastNotices, [`k${i}`]: "a1b2c3d4e5f60718" } };
			persist();
		}
		await Promise.resolve();
		await Promise.resolve();
		expect(branch.filter((entry) => typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === SPRINT_STATE_ENTRY_TYPE)).toHaveLength(1);
		expect(readPersistedSprintState(branch)).toEqual(state);
	});
});
