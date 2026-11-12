import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

for (const mode of ["resume", "restore", "package"] as const) {
	test(`installed lead extension paths reach one reviewer after ${mode}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "critic-resume-"));
		const original = SessionManager.inMemory(dir);
		original.appendCustomEntry("user_todo_edit", {
			phases: [
				{
					name: "work",
					tasks: [
						{
							content: "Facility labels after rotation",
							status: "pending",
							schedule: { cumulativeReestimateCount: 5 },
						},
					],
				},
			],
		});
		const file = path.join(dir, "session.jsonl");
		await Bun.write(
			file,
			[original.getHeader(), ...original.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n",
		);
		const manager = await SessionManager.open(file);
		const auth = await AuthStorage.create(":memory:");
		const { session, extensionsResult } = await createAgentSession({
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			cwd: dir,
			agentDir: path.join(dir, "agent"),
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth),
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
			disableExtensionDiscovery: true,
			additionalExtensionPaths:
				mode === "package"
					? [path.resolve(import.meta.dir, "..")]
					: ["goal_deadlines.ts", "todo_dispatch.ts", "agent_router.ts"].map(file =>
							path.join(import.meta.dir, file),
						),
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			expect(extensionsResult?.errors).toEqual([]);
			let calls = 0;
			session.agent.streamFn = () => {
				throw new Error("Unexpected provider request");
			};
			session.extensionRunner!.invokeNativeTool = async (name, params) => {
				expect(name).toBe("task");
				expect(params).toMatchObject({ agent: "reviewer" });
				calls++;
				return {
					content: [],
					details: {
						results: [
							{
								output: JSON.stringify({
									converging: true,
									criticalPathBlocker: null,
									falseDependencies: [],
									split: [],
									cut: [],
									escalate: [],
									actions: [],
								}),
							},
						],
					},
				} as never;
			};
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					throw error;
				},
			});
			if (mode === "restore") expect(await restoreSession(session)).toEqual({ turn: false, subagents: [] });
			for (let i = 0; i < 100 && !calls; i++) await Bun.sleep(10);
			expect(calls).toBe(1);
		} finally {
			await session.dispose();
			await manager.close();
			auth.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
}
