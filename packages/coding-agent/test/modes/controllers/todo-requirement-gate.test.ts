import { afterEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { bindRequirementRowArtifact, getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("TodoCommandController linked-requirement gate", () => {
	let tempRoot = "";

	afterEach(async () => {
		if (tempRoot) await removeWithRetries(tempRoot);
		tempRoot = "";
	});

	// ------------------------------------------------------------------
	// Linked-requirement gate: slash `/todo done` shares the native gate.
	// ------------------------------------------------------------------

	const LEDGER_AT = "2026-09-28T12:00:00.000Z";

	function createLedgerContext(manager: SessionManager): InteractiveModeContext {
		return {
			agent: {
				appendMessage: vi.fn(),
			},
			session: {
				getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
				setTodoPhases: vi.fn(),
			},
			sessionManager: manager,
			setTodos: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		} as unknown as InteractiveModeContext;
	}

	function linkedRequirement(
		rawAsk: string,
		rows: string[],
		verdict?: RequirementLedgerItem["verdict"],
	): RequirementLedgerItem {
		return {
			...createRequirementCandidates([], [rawAsk], LEDGER_AT)[0]!,
			classification: "linked",
			rows,
			...(verdict ? { verdict } : {}),
		};
	}

	function appendLedger(manager: SessionManager, requirements: RequirementLedgerItem[]): void {
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
			requirements,
		);
	}

	function initArtifactRepo(cwd: string): string {
		mkdirSync(cwd, { recursive: true });
		execFileSync("git", ["init", "--initial-branch=main"], { cwd });
		writeFileSync(path.join(cwd, "artifact.txt"), "audited\n");
		execFileSync("git", ["add", "artifact.txt"], { cwd });
		execFileSync(
			"git",
			["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "audited"],
			{ cwd },
		);
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	}

	function commitArtifactBump(cwd: string): string {
		writeFileSync(path.join(cwd, "artifact.txt"), "superseded\n");
		execFileSync("git", ["add", "artifact.txt"], { cwd });
		execFileSync(
			"git",
			["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "superseded"],
			{ cwd },
		);
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	}

	it("blocks /todo done while a linked requirement has no qa pass", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-gate-open-"));
		const manager = SessionManager.inMemory(tempRoot);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Plan", tasks: [{ content: "Gate artifact", status: "pending" }] }],
		});
		appendLedger(manager, [linkedRequirement("gate the artifact", ["Gate artifact"])]);
		manager.appendCustomEntry(REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE, {
			version: 1,
			sessionId: manager.getHeader()?.id,
			jobs: [],
			rejected: [{ workerId: "worker-1", ids: ["R1"], reason: "R1: malformed or partial verdict table" }],
		});
		const ctx = createLedgerContext(manager);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("done Gate artifact");

		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining("blocked until every linked requirement has a fresh qa-auditor pass"),
		);
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining('R1 ("Gate artifact")'));
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("R1: malformed or partial verdict table"));
		expect(ctx.setTodos).not.toHaveBeenCalled();
		const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
		expect(persisted[0]!.tasks[0]!.status).toBe("pending");
	});

	it("blocks /todo done when the linked pass names a superseded artifact", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-gate-stale-"));
		const repo = path.join(tempRoot, "repo");
		const auditedHead = initArtifactRepo(repo);
		const manager = SessionManager.inMemory(repo);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [
				{
					name: "Plan",
					tasks: [{ content: "Gate artifact", status: "pending", artifactCwd: repo, artifactOwner: "main" }],
				},
			],
		});
		appendLedger(manager, [
			linkedRequirement("gate the artifact", ["Gate artifact"], {
				status: "pass",
				evidence: "qa evidence",
				artifact: auditedHead,
				workerId: "qa-1",
				auditor: "qa-auditor",
			}),
		]);
		const currentHead = commitArtifactBump(repo);
		expect(currentHead).not.toBe(auditedHead);
		const ctx = createLedgerContext(manager);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("done Gate artifact");

		expect(ctx.showError).toHaveBeenCalledWith(
			expect.stringContaining("blocked until every linked requirement has a fresh qa-auditor pass"),
		);
		expect(ctx.setTodos).not.toHaveBeenCalled();
		const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
		expect(persisted[0]!.tasks[0]!.status).toBe("pending");
	});

	it("completes /todo done with a pass for the resource HEAD bound across an owner rewrite", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-gate-fresh-"));
		const repo = path.join(tempRoot, "repo");
		const head = initArtifactRepo(repo);
		const manager = SessionManager.inMemory(repo);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [
				{
					name: "Plan",
					tasks: [
						{
							content: "Gate artifact",
							status: "pending",
							schedule: { owner: "qa-worker", resources: [repo] },
						},
					],
				},
			],
		});
		const phases = getLatestTodoPhasesFromEntries(manager.getBranch());
		Object.assign(phases[0]!.tasks[0]!, { schedule: { owner: "main", resources: [repo] } });
		const bound = await bindRequirementRowArtifact(
			{ cwd: repo, sessionManager: manager },
			"Gate artifact",
			phases,
			{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
		);
		expect(bound).toEqual({ cwd: repo, head, dirty: false });
		appendLedger(manager, [
			linkedRequirement("gate the artifact", ["Gate artifact"], {
				status: "pass",
				evidence: "qa evidence",
				artifact: bound.head!,
				workerId: "qa-1",
				auditor: "qa-auditor",
			}),
		]);
		const ctx = createLedgerContext(manager);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("done Gate artifact");

		expect(ctx.showError).not.toHaveBeenCalled();
		const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
		expect(persisted[0]!.tasks[0]!.status).toBe("completed");
	});

	it("completes /todo done when no requirement links the row", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-gate-unlinked-"));
		const manager = SessionManager.inMemory(tempRoot);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Plan", tasks: [{ content: "Gate artifact", status: "pending" }] }],
		});
		appendLedger(manager, createRequirementCandidates([], ["unclassified ask"], LEDGER_AT));
		const ctx = createLedgerContext(manager);
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("done Gate artifact");

		expect(ctx.showError).not.toHaveBeenCalled();
		const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
		expect(persisted[0]!.tasks[0]!.status).toBe("completed");
	});
});
