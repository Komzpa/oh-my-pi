import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import agentRouter from "./agent_router";
import { workerToolPreflight, type TestProcess } from "./dispatch_preflight";
const ctx = { cwd: "/project", agent: { kind: "sub" } } as ExtensionContext;
const low = {
	meminfo: async () => "MemTotal: 999999 kB\nMemFree: 1 kB\nMemAvailable: 4194304 kB\n",
	processes: async (): Promise<TestProcess[]> => [],
};
const call = (toolName: string, input: unknown, context = ctx, probes = low) =>
	workerToolPreflight({ toolName, input }, context, probes);

test("write behavior blocks outside cwd without telltale prose and cannot be bypassed by retry", async () => {
	for (let retry = 0; retry < 3; retry++)
		expect((await call("write", { path: "/elsewhere/a", content: "plain" }))?.reason).toContain(
			"Outside your worktree: ask your lead with write agent://Main before writing /elsewhere/a",
		);
	expect(await call("write", { path: "a", content: "Write roots: /elsewhere. Run playwright test" })).toBeUndefined();
	expect(await call("read", { path: "/elsewhere/a" })).toBeUndefined();
	expect(await call("write", { path: "agent://Main", content: "help" })).toBeUndefined();
	expect(await call("edit", { path: "../project-other/a" })).toMatchObject({ block: true });
	expect(
		await call("write", { path: "/elsewhere/a" }, { ...ctx, agent: { kind: "main" } } as ExtensionContext),
	).toBeUndefined();
});
test("known bash write operands are checked; mention-only commands pass", async () => {
	expect(await call("bash", { command: "touch /elsewhere/a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "cp a /elsewhere/b" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "echo 'touch /elsewhere/a playwright test'" })).toBeUndefined();
	expect(await call("bash", { command: "touch local" })).toBeUndefined();
});
test("symlink escapes and edit rename targets are blocked", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-"));
	try {
		await fs.symlink(os.tmpdir(), path.join(dir, "escape"));
		const context = { ...ctx, cwd: dir };
		expect(await call("write", { path: "escape/new" }, context)).toMatchObject({ block: true });
		expect(await call("edit", { path: "local", edits: [{ rename: "../outside" }] }, context)).toMatchObject({
			block: true,
		});
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
test("actual test launch probes fresh resources on each attempt; matching words alone do not", async () => {
	let count = 0;
	const probes = {
		...low,
		meminfo: async () => {
			count++;
			return count < 3 ? "MemAvailable: 4194304 kB\n" : "MemAvailable: 99999999 kB\n";
		},
	};
	expect(await call("bash", { command: "echo 'playwright browser full-suite'" }, ctx, probes)).toBeUndefined();
	expect(count).toBe(0);
	for (let i = 0; i < 2; i++)
		expect((await call("bash", { command: "bun test" }, ctx, probes))?.reason).toContain("4.00 GiB (4194304 KiB)");
	expect(await call("bash", { command: "bun test" }, ctx, probes)).toBeUndefined();
	expect(count).toBe(3);
});
test("same-project proc argv prevents simultaneous launches, unrelated commands and projects do not", async () => {
	const probes = {
		meminfo: async () => "MemAvailable: 99999999 kB\n",
		processes: async () => [
			{ pid: 42, cwd: "/project/tests", command: "", argv: ["chromium", "--headless"] },
			{ pid: 43, cwd: "/project-other", command: "bun test" },
			{ pid: 44, cwd: "/project", command: "echo playwright test" },
		],
	};
	expect((await call("bash", { command: "npx playwright test" }, ctx, probes))?.reason).toContain(
		"same-project test processes=1 (PIDs 42)",
	);
	expect(await call("bash", { command: "npx playwright test" }, { ...ctx, cwd: "/other" }, probes)).toBeUndefined();
});

test("shell redirections and changed cwd resolve targets, quoted mentions remain inert", async () => {
	expect(await call("bash", { command: "echo data >/elsewhere/a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "cd /elsewhere && touch a" })).toMatchObject({ block: true });
	expect(await call("bash", { command: "echo '> /elsewhere/a'" })).toBeUndefined();
	expect(await call("bash", { command: "cd /project && echo data >local" })).toBeUndefined();
	expect(await call("bash", { command: "env CI=1 timeout 30 bash -lc 'npm run test'" })).toMatchObject({
		block: true,
	});
});

test("registered tool hook checks launch state and file target before execution", async () => {
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
	agentRouter(
		{
			on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) =>
				handlers.set(name, handler),
		} as unknown as ExtensionAPI,
		low,
	);
	const hook = handlers.get("tool_call")!;
	expect(await hook({ toolName: "bash", input: { command: "bun test" } }, ctx)).toMatchObject({ block: true });
	expect(await hook({ toolName: "write", input: { path: "/elsewhere/a", content: "plain" } }, ctx)).toMatchObject({
		block: true,
	});
	expect(await hook({ toolName: "bash", input: { command: "echo 'bun test'" } }, ctx)).toBeUndefined();
});

test("a managed browser launch checks RAM while attaching an existing browser does not", async () => {
	expect(await call("browser", { action: "open" })).toMatchObject({ block: true });
	expect(await call("browser", { action: "open", app: { cdp_url: "http://localhost:9222" } })).toBeUndefined();
	expect(await call("browser", { action: "call", chain: [{ method: "title", args: [] }] })).toBeUndefined();
});

test("patch payload targets cannot escape through pathless edit formats", async () => {
	expect(
		await call("edit", { input: "*** Begin Patch\n*** Add File: /elsewhere/a\n+hello\n*** End Patch" }),
	).toMatchObject({ block: true });
	expect(await call("edit", { input: "[/elsewhere/a]\n1: update" })).toMatchObject({ block: true });
});
