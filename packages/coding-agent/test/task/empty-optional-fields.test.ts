import { describe, expect, test } from "bun:test";
import { __testDropEmptyOptionalTaskFields as drop } from "../../src/task/index";

describe("task empty optional fields", () => {
	test("empty model and sourceSession are treated as absent", () => {
		expect(drop({ name: "A", task: "t", model: "", sourceSession: "" })).toEqual({ name: "A", task: "t" });
		expect(drop({ tasks: [{ name: "A", task: "t", model: [], sourceSession: null }] })).toEqual({
			tasks: [{ name: "A", task: "t" }],
		});
	});
	test("real values are kept untouched", () => {
		const raw = { tasks: [{ name: "A", task: "t", model: "codex-lb/gpt-6-luna", sourceSession: "abc" }] };
		expect(drop(raw)).toBe(raw);
	});
});
