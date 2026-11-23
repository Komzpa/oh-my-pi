import { describe, expect, test } from "bun:test";
import { __testDropEmptyOptionalTaskFields as drop } from "../../src/task/index";

// `sourceSession` left with seance (upstream db5d932058ec); only `model` is normalized now.
describe("task empty optional fields", () => {
	test("empty model is treated as absent", () => {
		expect(drop({ name: "A", task: "t", model: "" })).toEqual({ name: "A", task: "t" });
		expect(drop({ tasks: [{ name: "A", task: "t", model: [] }] })).toEqual({
			tasks: [{ name: "A", task: "t" }],
		});
	});
	test("real values are kept untouched", () => {
		const raw = { tasks: [{ name: "A", task: "t", model: "codex-lb/gpt-6-luna" }] };
		expect(drop(raw)).toBe(raw);
	});
});
