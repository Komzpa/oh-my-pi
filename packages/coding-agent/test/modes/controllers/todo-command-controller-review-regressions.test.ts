import { afterEach, describe, expect, it, vi } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getLatestTodoPhasesFromEntries, TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const LEDGER_AT = "2026-10-25T12:00:00.000Z";

describe("PR41 slash TODO controller regressions", () => {
	let tempRoot = "";
	let priorVisual: string | undefined;
	let priorEditor: string | undefined;

	afterEach(async () => {
		if (priorVisual === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = priorVisual;
		if (priorEditor === undefined) delete process.env.EDITOR;
		else process.env.EDITOR = priorEditor;
		priorVisual = undefined;
		priorEditor = undefined;
		if (tempRoot) await removeWithRetries(tempRoot);
		tempRoot = "";
	});

	function createContext(manager: SessionManager): InteractiveModeContext {
		return {
			agent: { appendMessage: vi.fn() },
			session: {
				getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
				setTodoPhases: vi.fn(),
			},
			sessionManager: manager,
			setTodos: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			ui: { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
		} as unknown as InteractiveModeContext;
	}

	function appendLinkedRequirement(manager: SessionManager, row: string): void {
		const candidate = createRequirementCandidates([], [`complete ${row}`], LEDGER_AT)[0]!;
		const requirement: RequirementLedgerItem = { ...candidate, classification: "linked", rows: [row] };
		appendRequirementsSnapshot({ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) }, [
			requirement,
		]);
	}

	function latest(manager: SessionManager): TodoPhase[] {
		return getLatestTodoPhasesFromEntries(manager.getBranch());
	}

	it("guards TUI rm and import replacement of unfinished linked rows", async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "todo-controller-removal-"));
		const row = "Keep linked work";
		const manager = SessionManager.inMemory(tempRoot);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: row, status: "pending" }] }],
		});
		appendLinkedRequirement(manager, row);
		const ctx = createContext(manager);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand(`rm ${row}`);
		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining("Cannot remove unfinished requirement-linked"),
		);
		expect(latest(manager)[0]?.tasks.map(task => task.content)).toContain(row);
		await controller.handleTodoCommand("rm");
		expect(latest(manager)[0]?.tasks.map(task => task.content)).toContain(row);

		await writeFile(path.join(tempRoot, "TODO.md"), "# Replacement\n- [ ] Unrelated task\n", "utf8");
		await controller.handleTodoCommand("import");
		expect(ctx.showError).toHaveBeenCalledTimes(3);
		expect(latest(manager)[0]?.tasks.map(task => task.content)).toContain(row);
		expect(latest(manager).flatMap(phase => phase.tasks.map(task => task.content))).not.toContain("Unrelated task");
	});

	it("guards TUI editor replacement of unfinished linked rows", async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "todo-controller-editor-"));
		priorVisual = process.env.VISUAL;
		priorEditor = process.env.EDITOR;
		const editor = path.join(tempRoot, "editor.sh");
		await writeFile(editor, "#!/bin/sh\ncat > \"$1\" <<'TODO'\n# Replacement\n- [ ] Unrelated task\nTODO\n", "utf8");
		await chmod(editor, 0o755);
		process.env.VISUAL = editor;
		const row = "Keep linked work";
		const manager = SessionManager.inMemory(tempRoot);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: row, status: "pending" }] }],
		});
		appendLinkedRequirement(manager, row);
		const ctx = createContext(manager);

		await new TodoCommandController(ctx).handleTodoCommand("edit");

		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining("Cannot remove unfinished requirement-linked"),
		);
		expect(latest(manager)[0]?.tasks.map(task => task.content)).toContain(row);
	});

	it("preserves linked-row checkout metadata when import keeps the row", async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "todo-controller-import-metadata-"));
		const row = "Keep artifact binding";
		const binding = {
			artifactCwd: path.join(tempRoot, "worker"),
			artifactOwner: "qa-worker",
			deployment: "deploy:https://example.invalid/release@v1 field=version",
			schedule: { owner: "qa-worker", resources: [path.join(tempRoot, "worker")] },
		};
		const manager = SessionManager.inMemory(tempRoot);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Before", tasks: [{ content: row, status: "pending", ...binding }] }],
		});
		appendLinkedRequirement(manager, row);
		await writeFile(path.join(tempRoot, "TODO.md"), `# After\n- [ ] ${row}\n`, "utf8");
		const ctx = createContext(manager);

		await new TodoCommandController(ctx).handleTodoCommand("import");

		const imported = latest(manager);
		expect(imported[0]?.name).toBe("After");
		expect(imported[0]?.tasks[0]).toMatchObject({ content: row, ...binding });
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("round-trips canonical artifact binding and native classify metadata through Markdown import", async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "todo-controller-native-markdown-metadata-"));
		const row = "Keep native artifact binding";
		const owner = "qa-worker";
		const manager = SessionManager.inMemory(tempRoot);
		const canonical: TodoPhase[] = [
			{
				name: "Before",
				tasks: [
					{
						content: row,
						status: "pending",
						artifactCwd: tempRoot,
						artifactOwner: owner,
						schedule: { owner },
					} as never,
				],
			},
		];
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: canonical });
		let phases: TodoPhase[] = [
			{
				name: "Before",
				tasks: [{ content: row, status: "pending", schedule: { owner } } as never],
			},
		];
		const tool = new TodoTool({
			cwd: tempRoot,
			hasUI: false,
			getSessionFile: () => path.join(tempRoot, "session.jsonl"),
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sessionManager: manager,
			getTodoPhases: () => phases,
			setTodoPhases: (next: TodoPhase[]) => (phases = next),
		} as never);
		const append = await tool.execute("append-neighbor", {
			op: "append",
			phase: "Before",
			items: ["Neighbor row"],
		} as never);
		expect(append.isError).toBeUndefined();

		const candidate = createRequirementCandidates([], [`complete ${row}`], LEDGER_AT)[0]!;
		appendRequirementsSnapshot({ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) }, [
			candidate,
		]);
		const deployment = "deploy:https://example.invalid/release@v1 field=version";
		const classified = await tool.execute("classify-binding", {
			op: "classify",
			id: candidate.id,
			classification: "linked",
			rows: [row],
			deployment,
		} as never);
		expect(classified.isError).toBeUndefined();
		const beforeImport = latest(manager)[0]?.tasks.find(task => task.content === row);
		expect(beforeImport).toMatchObject({
			artifactCwd: tempRoot,
			artifactOwner: owner,
			deployment,
			schedule: { owner },
		});

		await writeFile(path.join(tempRoot, "TODO.md"), `# After\n- [ ] ${row}\n`, "utf8");
		const ctx = createContext(manager);
		await new TodoCommandController(ctx).handleTodoCommand("import");

		const imported = latest(manager)[0]?.tasks.find(task => task.content === row);
		expect(latest(manager)[0]?.name).toBe("After");
		expect(imported).toMatchObject({
			artifactCwd: tempRoot,
			artifactOwner: owner,
			deployment,
			schedule: { owner },
		});
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("rechecks the same TODO artifact after an awaited completion gate", async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "todo-controller-race-"));
		const previousTrusted = process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				started.resolve();
				await release.promise;
				return Response.json({ version: "v1" });
			},
		});
		try {
			const row = "Gate the current declaration";
			const deployment = `deploy:http://127.0.0.1:${server.port}/version@v1 field=version`;
			process.env.OMP_TRUSTED_DEPLOYMENT_URLS = JSON.stringify([`http://127.0.0.1:${server.port}/version`]);
			const manager = SessionManager.inMemory(tempRoot);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [{ name: "Work", tasks: [{ content: row, status: "in_progress", deployment }] }],
			});
			const candidate = createRequirementCandidates([], [`complete ${row}`], LEDGER_AT)[0]!;
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				[
					{
						...candidate,
						classification: "linked",
						rows: [row],
						verdict: {
							status: "pass",
							rawWords: candidate.rawText,
							evidence: "endpoint returned v1",
							artifact: `${deployment}`,
							workerId: "qa-worker",
							auditor: "qa-auditor",
						},
					},
				],
			);
			const ctx = createContext(manager);
			const completing = new TodoCommandController(ctx).handleTodoCommand(`done ${row}`);
			await started.promise;
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Work",
						tasks: [{ content: row, status: "in_progress", deployment: deployment.replace("@v1", "@v2") }],
					},
				],
			});
			release.resolve();
			await completing;
			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("changed while the audit check was running"),
			);
			expect(latest(manager)[0]?.tasks[0]).toMatchObject({
				status: "in_progress",
				deployment: deployment.replace("@v1", "@v2"),
			});
		} finally {
			release.resolve();
			server.stop(true);
			if (previousTrusted === undefined) delete process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
			else process.env.OMP_TRUSTED_DEPLOYMENT_URLS = previousTrusted;
		}
	});

	it("audits abandoned rows before no-argument whole-plan done", async () => {
		tempRoot = await mkdtemp(path.join(os.tmpdir(), "todo-controller-abandoned-done-"));
		const row = "Abandoned but still linked";
		const manager = SessionManager.inMemory(tempRoot);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: row, status: "pending" }] }],
		});
		appendLinkedRequirement(manager, row);
		const ctx = createContext(manager);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("drop");
		expect(latest(manager)[0]?.tasks[0]?.status).toBe("abandoned");
		await controller.handleTodoCommand("done");

		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("R1"));
		expect(latest(manager)[0]?.tasks[0]?.status).toBe("abandoned");
	});
});
