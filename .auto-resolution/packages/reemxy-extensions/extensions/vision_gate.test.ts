import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import agentRouter from "./agent_router";
import { VISION_REFUSAL, visionResultRefusal, visionToolRefusal } from "./vision_gate";

function worker(cwd: string, input = ["text"]): ExtensionContext {
	return { cwd, agent: { kind: "sub", id: "worker", name: "coder" }, model: { input } } as ExtensionContext;
}

test("image reads depend on file contents and current model capabilities, never the filename or brief", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "vision-gate-"));
	try {
		await Bun.write(
			path.join(cwd, "opaque"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				"base64",
			),
		);
		await Bun.write(path.join(cwd, "screenshot.png"), "visual screenshot desktop mobile");
		const event = { toolName: "read", input: { path: "opaque" } };
		expect(await visionToolRefusal(event, worker(cwd))).toEqual({ block: true, reason: VISION_REFUSAL });
		expect(await visionToolRefusal(event, worker(cwd))).toMatchObject({ block: true });
		expect(await visionToolRefusal(event, worker(cwd, ["text", "image"]))).toBeUndefined();
		expect(
			await visionToolRefusal({ toolName: "read", input: { path: "screenshot.png" } }, worker(cwd)),
		).toBeUndefined();
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("structured screenshot calls refuse before execution and opaque captures return an actionable error", async () => {
	const ctx = worker("/project");
	expect(
		await visionToolRefusal(
			{ toolName: "browser", input: { action: "call", chain: [{ method: "screenshot", args: [] }] } },
			ctx,
		),
	).toMatchObject({ block: true });
	expect(
		await visionToolRefusal(
			{ toolName: "browser", input: { action: "call", chain: [{ method: "title", args: ["screenshot"] }] } },
			ctx,
		),
	).toBeUndefined();
	const result = { details: { screenshots: [{ dest: "/tmp/opaque", mimeType: "image/png" }] } };
	expect(visionResultRefusal(result, ctx)).toMatchObject({
		isError: true,
		content: [{ type: "text", text: VISION_REFUSAL }],
	});
	expect(visionResultRefusal(result, worker("/project", ["image", "text"]))).toBeUndefined();
	expect(
		visionResultRefusal({ content: [{ type: "text", text: "screenshot.png visual screenshot" }] }, ctx),
	).toBeUndefined();
	expect(visionResultRefusal({ content: [{ type: "image", data: "bytes" }] }, ctx)?.isError).toBe(true);
});

test("registered hooks reject screenshot results while keeping ordinary results intact", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	agentRouter({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI);
	const ctx = worker("/project");
	expect(
		await handlers.get("tool_call")!(
			{ toolName: "browser", input: { action: "call", chain: [{ method: "screenshot", args: [] }] } },
			ctx,
		),
	).toMatchObject({ block: true });
	expect(
		await handlers.get("tool_result")!(
			{ toolName: "browser", details: { screenshots: [{ dest: "/tmp/image" }] }, content: [] },
			ctx,
		),
	).toMatchObject({ isError: true });
	expect(
		await handlers.get("tool_result")!({ toolName: "browser", content: [{ type: "text", text: "screenshot" }] }, ctx),
	).toBeUndefined();
});
