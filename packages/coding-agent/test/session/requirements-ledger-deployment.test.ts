import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import {
	getLatestTodoPhasesFromEntries,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";

const COMMIT = "5a891ef1d6ae3c0e6d257f311432f881b00aef89";
const OTHER_COMMIT = "123456789abcdef0123456789abcdef012345678";
const DEPLOY = `deploy:http://127.0.0.1:8080/release@${COMMIT} field=commit`;
const OTHER_DEPLOY = `deploy:http://127.0.0.1:8080/release@${OTHER_COMMIT} field=commit`;

describe("deployment binding classification", () => {
	const AT = "2026-09-28T12:00:00.000Z";
	const ROW_A = "Deploy the release binary";
	const ROW_B = "Keep the release notes current";
	const ROW_C = "Announce the release";

	async function classifyFixture(dir: string, rows: string[], raws: string[]) {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], raws, AT),
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Release", tasks: rows.map(content => ({ content, status: "pending" })) }],
		});
		const tool = new TodoTool({
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			sessionManager: manager,
			getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
			setTodoPhases: (phases: TodoPhase[]) => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
		} as unknown as ToolSession);
		return { manager, tool };
	}

	function taskDeployment(manager: SessionManager, row: string): string | undefined {
		const task: unknown = getLatestTodoPhasesFromEntries(manager.getBranch())
			.flatMap(phase => phase.tasks)
			.find(candidate => candidate.content === row);
		if (!task || typeof task !== "object" || !("deployment" in task)) return undefined;
		const deployment: unknown = task.deployment;
		return typeof deployment === "string" ? deployment : undefined;
	}

	it("persists a linked deployment binding as one canonical deploy identity string", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-deployment-classify-"));
		try {
			const { manager, tool } = await classifyFixture(dir, [ROW_A], ["Ship the release"]);
			const result = await tool.execute("classify-deploy", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: [ROW_A],
				deployment: `  ${DEPLOY}  `,
			});
			expect(result.isError).not.toBe(true);
			expect(taskDeployment(manager, ROW_A)).toBe(DEPLOY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects invalid deploy identities, empty or unknown rows, and resources beside deployment", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-deployment-classify-"));
		try {
			const { manager, tool } = await classifyFixture(dir, [ROW_A], ["Ship the release"]);
			const cases: Array<{ rows: string[]; deployment: unknown }> = [
				{ rows: [ROW_A], deployment: "not a deploy identity" },
				{ rows: [ROW_A], deployment: `deploy:relative/binary@${COMMIT} field=commit` },
				{ rows: [ROW_A], deployment: `deploy:http://127.0.0.1:8080/release@${COMMIT}` },
				{ rows: [ROW_A], deployment: { commit: COMMIT, binary: "/opt/litterbox/server/litterbox" } },
				{ rows: [], deployment: DEPLOY },
				{ rows: ["No such row"], deployment: DEPLOY },
			];
			for (const [index, params] of cases.entries()) {
				const result = await tool.execute(`classify-deploy-bad-${index}`, {
					op: "classify",
					id: "R1",
					classification: "linked",
					...params,
					// Deliberately bypass static typing to exercise malformed tool payload rejection.
					deployment: params.deployment as string,
					rows: [...params.rows],
				});
				expect(result.isError).toBe(true);
				expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("candidate");
				expect(taskDeployment(manager, ROW_A)).toBeUndefined();
			}
			const conflict = await tool.execute("classify-deploy-conflict", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: [ROW_A],
				resources: [dir],
				deployment: DEPLOY,
			});
			expect(conflict.isError).toBe(true);
			expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("candidate");
			expect(taskDeployment(manager, ROW_A)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("requires reasoned relink to replace a saved deployment and preserves an omitted binding", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-deployment-classify-"));
		try {
			const { manager, tool } = await classifyFixture(dir, [ROW_A, ROW_B], ["Ship the release"]);
			expect(
				(
					await tool.execute("classify-deploy", {
						op: "classify",
						id: "R1",
						classification: "linked",
						rows: [ROW_A],
						deployment: DEPLOY,
					})
				).isError,
			).not.toBe(true);
			const unreasoned = await tool.execute("classify-deploy-replace", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: [ROW_A],
				deployment: OTHER_DEPLOY,
			});
			expect(unreasoned.isError).toBe(true);
			expect(taskDeployment(manager, ROW_A)).toBe(DEPLOY);
			const relinked = await tool.execute("classify-deploy-relink", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: [ROW_A, ROW_B],
				relink: true,
				reason: "Same binary now covers the notes row",
			});
			expect(relinked.isError).not.toBe(true);
			expect(taskDeployment(manager, ROW_A)).toBe(DEPLOY);
			const replaced = await tool.execute("classify-deploy-replaced", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: [ROW_A, ROW_B],
				deployment: OTHER_DEPLOY,
				relink: true,
				reason: "Release rebuilt at the new commit",
			});
			expect(replaced.isError).not.toBe(true);
			expect(taskDeployment(manager, ROW_A)).toBe(OTHER_DEPLOY);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears only the changed rows receipts on relink and keeps the other requirement untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-deployment-classify-"));
		try {
			const { manager, tool } = await classifyFixture(
				dir,
				[ROW_A, ROW_B, ROW_C],
				["Ship the release", "Note the release"],
			);
			for (const [callId, id, rows] of [
				["link-r1", "R1", [ROW_A, ROW_B]],
				["link-r2", "R2", [ROW_B]],
			] as const) {
				expect(
					(await tool.execute(callId, { op: "classify", id, classification: "linked", rows: [...rows] })).isError,
				).not.toBe(true);
			}
			const verdict = (artifact: string) => ({
				status: "pass" as const,
				evidence: "audited",
				artifact,
				workerId: "qa-1",
				auditor: "qa-auditor" as const,
				receivedAt: AT,
			});
			manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
				version: 1,
				requirements: getLatestRequirements(manager.getBranch()).map(requirement =>
					requirement.id === "R1"
						? { ...requirement, rowVerdicts: { [ROW_A]: verdict("a"), [ROW_B]: verdict("b") } }
						: { ...requirement, rowVerdicts: { [ROW_B]: verdict("b") } },
				),
			});
			const relinked = await tool.execute("relink-r1", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: [ROW_B, ROW_C],
				relink: true,
				reason: "Release row replaced by the announcement row",
			});
			expect(relinked.isError).not.toBe(true);
			const requirements = getLatestRequirements(manager.getBranch());
			const first = requirements.find(requirement => requirement.id === "R1")!;
			const second = requirements.find(requirement => requirement.id === "R2")!;
			expect(first.rows).toEqual([ROW_B, ROW_C]);
			expect(first.rowVerdicts?.[ROW_A]).toBeUndefined();
			expect(first.rowVerdicts?.[ROW_B]).toBeDefined();
			expect(first.rawText).toBe("Ship the release");
			expect(first.amendments?.at(-1)).toMatchObject({ oldRows: [ROW_A, ROW_B], newRows: [ROW_B, ROW_C] });
			expect(second.rows).toEqual([ROW_B]);
			expect(second.rowVerdicts?.[ROW_B]).toBeDefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
