import { expect, test } from "bun:test";
import { YieldTool } from "../../src/tools/yield";
import type { ToolSession } from "../../src/tools";

test("yield accepts structured requirements alongside arbitrary caller data and rejects malformed evidence", async () => {
	const tool = new YieldTool({} as ToolSession);
	const result = await tool.execute("valid", {
		data: "report",
		requirements: [{ requirement: "ship", done: true, evidence: { commit: "abcdef" } }],
	});
	expect(result.details).toMatchObject({
		status: "success",
		requirements: [{ requirement: "ship", done: true, evidence: { commit: "abcdef" } }],
	});
	await expect(
		tool.execute("invalid", {
			data: "report",
			requirements: [{ requirement: "ship", done: "yes", evidence: { path: "x" } }],
		}),
	).rejects.toThrow("requirements:");
	await expect(
		tool.execute("ambiguous", {
			data: "report",
			blocker: { kind: "owner", evidence: { path: "x", command: "true" } },
		}),
	).rejects.toThrow("blocker:");
});
