import { expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

test("real extension context persists customer review annotations through session reload without changing other rows", async () => {
	using dir = TempDir.createSync("@omp-todo-review-persistence-");
	const authStorage = await AuthStorage.create(dir.join("auth.db"));
	const manager = SessionManager.create(dir.path(), dir.path());
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{
					content: "Delivered UI",
					status: "completed",
					schedule: { dependencies: [], owner: "Coder", finishedAt: 123, attemptHistory: [] },
				},
				{ content: "Independent work", status: "in_progress", schedule: { dependencies: [], owner: "Docs" } },
			],
		},
	];
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		sessionManager: manager,
		modelRegistry: new ModelRegistry(authStorage),
		authStorage,
		model: getBundledModel("openai", "gpt-4o-mini"),
		settings: Settings.isolated({ "browser.enabled": false, "computer.enabled": false, "autolearn.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
		restrictToolNames: true,
	});
	try {
		const ctx = session.extensionRunner!.createContext();
		const staleRead = ctx.getTodoPhases!()!;
		expect(
			ctx.updateTodoSchedule!("Delivered UI", {
				review: "user",
				reviewSummary: "Header controls changed",
				firstDeliveredAt: 456,
			}),
		).toBe(true);
		expect(ctx.updateTodoSchedule!("Delivered UI", { speculativeOn: "Delivered UI" })).toBe(true);
		expect(staleRead[0].tasks[0].schedule?.review).toBeUndefined();
		expect(ctx.updateTodoSchedule!("Missing row", { review: "accepted" })).toBe(false);
		const current = session.getTodoPhases();
		expect(current[0].tasks[0].status).toBe("completed");
		expect(current[0].tasks[0].schedule).toEqual({
			...phases[0].tasks[0].schedule,
			review: "user",
			reviewSummary: "Header controls changed",
			firstDeliveredAt: 456,
			speculativeOn: "Delivered UI",
		});
		expect(current[0].tasks[1]).toEqual(phases[0].tasks[1]);
		await manager.ensureOnDisk();
		manager.flushSync();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		expect(getLatestTodoPhasesFromEntries(reopened.getBranch())).toEqual(current);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 30_000);
