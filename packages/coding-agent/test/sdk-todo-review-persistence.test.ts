import { expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getLatestTodoPhasesFromEntries,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
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
					schedule: {
						dependencies: [],
						owner: "Coder",
						finishedAt: 123,
						attemptHistory: [],
						reviewPage: "http://review.example/result/",
					},
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
				reviewPagePending: true,
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
			reviewPagePending: true,
			reviewSummary: "Header controls changed",
			firstDeliveredAt: 456,
			speculativeOn: "Delivered UI",
		});
		expect(current[0].tasks[1]).toEqual(phases[0].tasks[1]);
		await manager.ensureOnDisk();
		manager.flushSync();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		expect(getLatestTodoPhasesFromEntries(reopened.getBranch())).toEqual(current);
		expect(ctx.updateTodoSchedule!("Delivered UI", { reviewPagePending: undefined })).toBe(true);
		await manager.ensureOnDisk();
		manager.flushSync();
		const ready = await SessionManager.open(manager.getSessionFile()!);
		const restored = getLatestTodoPhasesFromEntries(ready.getBranch());
		expect(restored[0].tasks[0].schedule?.reviewPagePending).toBeUndefined();
		expect(restored[0].tasks[0].schedule?.review).toBe("user");
		const answer = {
			task: "Delivered UI",
			page: "http://review.example/result/",
			card: "delivered-ui",
			contentSha: "published-v1",
			answer: "accept" as const,
			note: "",
			at: "2026-11-06T07:49:41.801Z",
		};
		expect(await ctx.applyReviewPageAnswer!(answer)).toBe(true);
		expect(session.getTodoPhases()[0].tasks[0].schedule?.review).toBe("accepted");
		expect(await ctx.applyReviewPageAnswer!(answer)).toBe(false);
		await manager.ensureOnDisk();
		manager.flushSync();
		const accepted = await SessionManager.open(manager.getSessionFile()!);
		const acceptedRows = getLatestTodoPhasesFromEntries(accepted.getBranch());
		expect(acceptedRows[0].tasks[0].status).toBe("completed");
		expect(acceptedRows[0].tasks[0].schedule?.reviewAnswers).toHaveLength(1);
		await accepted.close();
		expect(
			ctx.updateTodoSchedule!("Delivered UI", {
				deliveryCritic: {
					key: "rack-attempt-1",
					startedAt: 500,
					verdict: "defects",
					evidence: "Rack controls clip at 1568",
				},
				review: "redo",
				handoffPending: false,
				progress: { at: 600, evidence: "Rack controls clip at 1568" },
			}),
		).toBe(true);
		await manager.ensureOnDisk();
		manager.flushSync();
		const redoSession = await SessionManager.open(manager.getSessionFile()!);
		const redo = getLatestTodoPhasesFromEntries(redoSession.getBranch());
		expect(redo[0].tasks[0].status).toBe("pending");
		expect(redo[0].tasks[0].schedule?.review).toBe("redo");
		expect(redo[0].tasks[0].schedule?.progress?.evidence).toBe("Rack controls clip at 1568");
		expect(redo[0].tasks[1]).toEqual(phases[0].tasks[1]);
		ctx.updateTodoSchedule!("Delivered UI", { auditRounds: 3, auditEscalation: "Save loses records" });
		expect(session.getTodoPhases()[0].tasks[0].status).toBe("blocked");
		expect(
			await ctx.applyReviewPageAnswer!({
				...answer,
				contentSha: "published-v2",
				answer: "redo",
				note: "Repair Save, then verify persistence",
			}),
		).toBe(true);
		await manager.ensureOnDisk();
		manager.flushSync();
		const retrySession = await SessionManager.open(manager.getSessionFile()!);
		const retry = getLatestTodoPhasesFromEntries(retrySession.getBranch())[0].tasks[0];
		expect(retry.status).toBe("pending");
		expect(retry.schedule?.auditEscalation).toBeUndefined();
		expect(retry.schedule?.auditRounds).toBe(0);
		await retrySession.close();
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 30_000);

test("a passing runtime audit closes its delivered row through the real schedule callback; a fail keeps it open", async () => {
	using dir = TempDir.createSync("@omp-todo-audit-close-");
	const authStorage = await AuthStorage.create(dir.join("auth.db"));
	const manager = SessionManager.create(dir.path(), dir.path());
	const executor = { workerId: "PowerFocusFrame-2", startedAt: 10, finishedAt: 20, outcome: "completed" as const };
	const phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "No red focus frame", status: "in_progress", schedule: { owner: executor.workerId, executor } },
				{ content: "Showcase scenario", status: "in_progress", schedule: { executor } },
				{
					content: "Answered scenario",
					status: "in_progress",
					schedule: { decision: "owner", executor, reviewAnswers: ["page/card/hash/accept"] },
				},
				{ content: "Edges only in package", status: "in_progress", schedule: { owner: "UxGraphEdges", executor } },
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
		const tool = new TodoTool({
			cwd: dir.path(),
			settings: Settings.isolated(),
			sessionManager: manager,
			getSessionFile: () => null,
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: (next: TodoPhase[]) => session.setTodoPhases(next),
		} as unknown as ToolSession);
		const staffed = await tool.execute("owner-staff", {
			op: "schedule",
			updates: [{ task: "Showcase scenario", decision: "owner" }],
		});
		expect(staffed.isError).not.toBe(true);
		// Direct tool execution bypasses the agent loop, which normally journals this result.
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "owner-staff",
			toolName: "todo",
			...staffed,
			isError: staffed.isError ?? false,
			timestamp: Date.now(),
		});
		const refused = await tool.execute("owner-done", { op: "done", task: "Showcase scenario" });
		expect(refused.isError).toBe(true);
		expect(session.getTodoPhases()[0].tasks.find(row => row.content === "Showcase scenario")?.status).toBe(
			"in_progress",
		);
		const audit = {
			delivery: JSON.stringify([executor.workerId, 10, 20]),
			repoPath: dir.path(),
			agent: "qa-auditor",
			head: "c64ec5fe6",
			startedAt: 30,
		};
		expect(ctx.updateTodoSchedule!("No red focus frame", { audit: { ...audit, verdict: "pass", at: 40 } })).toBe(
			true,
		);
		expect(
			ctx.updateTodoSchedule!("Edges only in package", {
				audit: { ...audit, verdict: "fail", findings: "Settings edge still listed", at: 40 },
			}),
		).toBe(true);
		for (const task of ["Showcase scenario", "Answered scenario"])
			ctx.updateTodoSchedule!(task, { audit: { ...audit, verdict: "pass", at: 40 } });
		await manager.ensureOnDisk();
		manager.flushSync();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		const [closed, scenario, answered, open] = getLatestTodoPhasesFromEntries(reopened.getBranch())[0].tasks;
		expect(scenario.status).toBe("in_progress");
		expect(scenario.schedule?.review).toBe("user");
		expect(answered.status).toBe("completed");
		expect(answered.schedule?.review).toBeUndefined();
		expect(closed.schedule?.review).toBeUndefined();
		expect(closed.status).toBe("completed");
		expect(typeof closed.schedule?.finishedAt).toBe("number");
		expect(closed.schedule?.audit?.verdict).toBe("pass");
		expect(open.status).toBe("in_progress");
		expect(open.schedule?.audit?.findings).toBe("Settings edge still listed");
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 30_000);
