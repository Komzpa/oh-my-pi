import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { applyOpsToPhases, getRequirementRowArtifact, TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

describe("PR #41 todo artifact cwd", () => {
	it("keeps sequential execution cwd local and does not leak it into standalone todo ops", async () => {
		const makeSession = (cwd: string) => {
			let phases: Parameters<NonNullable<ToolSession["setTodoPhases"]>>[0] = [];
			return {
				session: {
					cwd,
					hasUI: false,
					getSessionFile: () => null,
					settings: Settings.isolated(),
					getSessionSpawns: () => "*",
					getTodoPhases: () => phases,
					setTodoPhases: next => {
						phases = next;
					},
				} satisfies ToolSession,
				getPhases: () => phases,
			};
		};

		const first = makeSession("/tmp/pr41-first-checkout");
		await new TodoTool(first.session).execute("first", { op: "init", items: ["First row"] });
		expect(first.getPhases()[0]?.tasks[0]?.artifactCwd).toBe("/tmp/pr41-first-checkout");

		const second = makeSession("/tmp/pr41-second-checkout");
		await new TodoTool(second.session).execute("second", { op: "init", items: ["Second row"] });
		expect(second.getPhases()[0]?.tasks[0]?.artifactCwd).toBe("/tmp/pr41-second-checkout");
		expect(first.getPhases()[0]?.tasks[0]?.artifactCwd).toBe("/tmp/pr41-first-checkout");

		const standalone = applyOpsToPhases([], [{ op: "init", items: ["Independent row"] } as never]);
		expect(standalone.phases[0]?.tasks[0]?.artifactCwd).toBeUndefined();
	});
	it("resolves ownerless rows against the main checkout", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-pr41-ownerless-row-"));
		try {
			execFileSync("git", ["init", "--initial-branch=main"], { cwd });
			writeFileSync(join(cwd, "artifact.txt"), "artifact\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
				{ cwd },
			);
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			const phases: TodoPhase[] = [{ name: "Plan", tasks: [{ content: "Ownerless", status: "pending" }] }];
			expect(await getRequirementRowArtifact({ cwd }, "Ownerless", phases)).toEqual({ cwd, head, dirty: false });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("completes an audited Main-owned row from the clean session checkout without lending it to an unknown worker", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-pr41-main-owner-"));
		try {
			execFileSync("git", ["init", "--initial-branch=main"], { cwd });
			writeFileSync(join(cwd, "artifact.txt"), "artifact\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
				{ cwd },
			);
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			const manager = SessionManager.inMemory(cwd);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Plan",
						tasks: [
							{ content: "Main artifact", status: "pending", schedule: { owner: "Main", resources: [] } },
							{
								content: "Worker artifact",
								status: "pending",
								schedule: { owner: "UnknownWorker", resources: [] },
							},
						],
					},
				],
			});
			const requirements = createRequirementCandidates(
				[],
				["Audit main artifact", "Audit worker artifact"],
				"2026-10-14T03:00:00.000Z",
			).map((requirement, index) => ({
				...requirement,
				classification: "linked" as const,
				rows: [index === 0 ? "Main artifact" : "Worker artifact"],
				verdict: {
					status: "pass" as const,
					evidence: "Observed clean committed artifact",
					artifact: `row "${index === 0 ? "Main artifact" : "Worker artifact"}" @ ${head}`,
					workerId: "qa-main",
					auditor: "qa-auditor" as const,
					rawWords: requirement.rawText,
				},
			}));
			appendRequirementsSnapshot(
				{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
				requirements,
			);
			const session: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated(),
				sessionManager: manager,
				getSessionSpawns: () => "*",
				getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
				setTodoPhases: phases => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
			};
			const tool = new TodoTool(session);
			expect((await tool.execute("main-done", { op: "done", task: "Main artifact" })).isError).not.toBe(true);
			expect((await tool.execute("worker-done", { op: "done", task: "Worker artifact" })).isError).toBe(true);
			const tasks = getLatestTodoPhasesFromEntries(manager.getBranch())[0]!.tasks;
			expect(tasks.find(task => task.content === "Main artifact")?.status).toBe("completed");
			expect(tasks.find(task => task.content === "Worker artifact")!.status).not.toBe("completed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
