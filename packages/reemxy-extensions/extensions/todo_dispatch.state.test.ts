import { describe, expect, test } from "bun:test";
import { boundedNotices, MAX_NOTICE_KEYS, noticeDigest, noticeKey, readPersistedSprintState } from "./todo_dispatch";

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
