import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { SessionManager } from "../../src/session/session-manager";
import { RequirementsLedgerRuntime } from "../../src/session/requirements-ledger-runtime";
import {
	evaluateRequirementDoneGate,
	formatRequirementGateNotice,
	parseRequirementsLedger,
} from "../../src/tools/requirements-ledger";
import { getAcceptedTodoRows, getRequirementRowArtifact, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import backlog from "../fixtures/requirements-dc-backlog.json";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("requirement convergence", () => {
	it("keeps a pass after unrelated commits but reopens it after delivered files change", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "requirement-relevance-"));
		dirs.push(cwd);
		git(cwd, "init", "-b", "main");
		git(cwd, "config", "user.name", "Test");
		git(cwd, "config", "user.email", "test@example.invalid");
		await Bun.write(path.join(cwd, "base.txt"), "base");
		git(cwd, "add", ".");
		git(cwd, "commit", "-m", "base");
		git(cwd, "checkout", "-b", "delivery");
		await Bun.write(path.join(cwd, "delivered.txt"), "delivered");
		git(cwd, "add", ".");
		git(cwd, "commit", "-m", "delivery");
		const commit = git(cwd, "rev-parse", "HEAD");
		const row = "Deliver feature";
		const requirements = parseRequirementsLedger({
			version: 1,
			requirements: [
				{
					id: "R1",
					at: "2026-11-06T09:05:00Z",
					rawText: "deliver feature",
					classification: "linked",
					rows: [row],
					rowVerdicts: {
						[row]: {
							status: "pass",
							evidence: "verified",
							receivedAt: "2026-11-06T09:05:00.000Z",
							artifact: `row "${row}" @ git:${cwd}@${commit}`,
							workerId: "qa-1",
							auditor: "qa-auditor",
							rawWords: "deliver feature",
						},
					},
				},
			],
		})!.requirements;
		const phases: TodoPhase[] = [
			{ name: "Done", tasks: [{ content: row, status: "completed", schedule: { resources: [cwd] } } as never] },
		];
		const check = () =>
			evaluateRequirementDoneGate(requirements, [row], (row, receipt) =>
				getRequirementRowArtifact({ cwd, receipt }, row, phases),
			);
		await Bun.write(path.join(cwd, "unrelated.txt"), "other");
		git(cwd, "add", ".");
		git(cwd, "commit", "-m", "unrelated");
		expect(await check()).toEqual([]);
		await Bun.write(path.join(cwd, "delivered.txt"), "changed");
		git(cwd, "add", ".");
		git(cwd, "commit", "-m", "changed delivery");
		expect((await check()).map(issue => issue.requirement.id)).toEqual(["R1"]);
	});
	it("settles accepted backlog without a verdict and recovers stale receipts only after a fresh relevance probe", async () => {
		const requirements = parseRequirementsLedger({ version: 1, requirements: backlog.requirements })!.requirements;
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: backlog.phases });
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		const accepted = getAcceptedTodoRows(manager.getBranch());
		expect(accepted.has(backlog.requirements[1]!.rows[0]!)).toBe(true);
		const rows = requirements.flatMap(r => r.rows);
		const probe = async (_row: string, receipt?: string) => ({
			head: null,
			dirty: false,
			identityCheck: receipt ? { artifact: receipt } : undefined,
		});
		expect(
			await evaluateRequirementDoneGate(requirements, rows, probe, new Map(), new Set(), new Set(), accepted),
		).toEqual([]);
		const failed = structuredClone(requirements);
		failed[0]!.rowVerdicts![rows[0]!]!.status = "fail";
		expect(
			(await evaluateRequirementDoneGate(failed, rows, probe, new Map(), new Set(), new Set(), accepted)).map(
				i => i.requirement.id,
			),
		).toEqual(["R1"]);
		accepted.add(rows[0]!);
		expect(await evaluateRequirementDoneGate(failed, rows, probe, new Map(), new Set(), new Set(), accepted)).toEqual(
			[],
		);
	});
	it("keeps a large notice short and rejects a fifth concurrent auditor", async () => {
		const requirement = parseRequirementsLedger({ version: 1, requirements: backlog.requirements })!.requirements[0]!;
		const open = Array.from({ length: 90 }, (_, i) => ({
			requirement: { ...requirement, id: `R${i + 1}`, rows: [`row ${i}`] },
			issues: ["needs audit"],
		}));
		const notice = formatRequirementGateNotice(open, 3);
		expect(notice).toContain("at most 3 concurrent");
		expect(Buffer.byteLength(notice)).toBeLessThan(900);
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/",
			sessionManager: SessionManager.inMemory(),
			onSettledAssistantMessage: () => {},
		});
		await expect(
			runtime.prepareAuditorTaskCall("task", "too-many", {
				tasks: Array.from({ length: 5 }, (_, i) => ({ agent: "qa-auditor", name: `qa-${i}`, task: "audit" })),
			}),
		).rejects.toThrow("at most 4 concurrent");
	});
});
