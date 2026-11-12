import { afterEach, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { patchTodoSchedule } from "../../coding-agent/src/session/todo-schedule-patch";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { classifyTodoDisplayRow, renderTodoPlanDisplay, todoRowAfterWorker, todoRowDeliveryKey, type TodoSchedule } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderLeadRowInstructions } from "./lead-row-instructions";
import { checkRowAudits, resetRowAuditsForTest } from "./row_audit";

const roots: string[] = [];
afterEach(() => {
	resetRowAuditsForTest();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout.toString().trim();
}

function fixture(receipt: "lane" | "reachable" | "missing" | "none" = "lane", fail = false) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "row-integration-"));
	roots.push(repo);
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Fixture");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "commit", "--allow-empty", "-qm", "base");
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-qb", "lane");
	fs.writeFileSync(path.join(repo, "result.txt"), "delivered\n");
	git(repo, "add", "result.txt");
	git(repo, "commit", "-qm", "delivery");
	const commit = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "--detach", base);
	const receiptCommit = receipt === "missing" ? "f".repeat(40) : receipt === "reachable" ? base : commit;
	let phases: TodoPhase[] = [{ name: "Work", tasks: [{
		content: "Deliver result", status: "in_progress", schedule: {
			resources: [repo], progress: { at: 2, evidence: "Saved delivery receipt" },
			...(receipt === "none" ? { reviewPage: "/review/result.html" } : {}),
			executor: { workerId: "Producer", startedAt: 1, finishedAt: 2, outcome: "completed",
				...(receipt === "none" ? {} : { gitCommits: [{ repoPath: repo, commit: receiptCommit }] }) },
		},
	}] }];
	let launches = 0;
	const settled = Promise.withResolvers<void>();
	const ctx = {
		cwd: repo, sessionManager: { getHeader: () => ({ id: repo }), getBranch: () => [] },
		getTodoPhases: () => phases,
		updateTodoSchedule: (title: string, patch: Partial<TodoSchedule>) => {
			phases = patchTodoSchedule(phases, title, patch, 3)!;
			if (patch.audit?.verdict === "pass" || patch.audit?.verdict === "fail") settled.resolve();
			return true;
		},
		runRowAudit: async () => {
			launches++;
			return { details: { results: [{ output: JSON.stringify({ rows: [{
				row: "Deliver result", verdict: fail ? "fail" : "pass", findings: fail ? "Result violates acceptance" : "Result checked",
				checks: [{ command: "bun test result.test.ts", exitCode: fail ? 1 : 0, gate: true }],
				issues: fail ? [{ kind: "product_regression", severity: "blocker", evidence: "Result violates acceptance", action: "Repair result" }] : [],
			}] }) }] } };
		},
	} as unknown as ExtensionContext;
	const row = () => phases[0]!.tasks[0]!;
	const context = { workers: [], owners: new Map() };
	return { repo, commit, row, phases: () => phases, launches: () => launches,
		recordPreviousFailure: () => ctx.updateTodoSchedule!("Deliver result", { audit: {
			delivery: todoRowDeliveryKey(row().schedule), repoPath: repo, head: base,
			startedAt: 2, verdict: "fail", agent: "qa-auditor", findings: "Delivery is outside HEAD",
		} }),
		settled: settled.promise,
		check: () => checkRowAudits(ctx, { resolveAuditor: async () => "qa-auditor" }),
		state: () => classifyTodoDisplayRow(row(), phases, context).state,
		notice: () => renderLeadRowInstructions(phases, context, { now: 3 }),
		display: () => renderTodoPlanDisplay(phases, context, { now: 3, paint: (_tone, text) => text }).lines.join("\n"),
	};
}


test.each(["fresh", "previously failed"])("R1: %s unmerged delivery awaits integration with an exact authorized command", async previous => {
	const h = fixture();
	if (previous === "previously failed") h.recordPreviousFailure();
	const identity = todoRowDeliveryKey(h.row().schedule);
	expect(await h.check()).toBe(0);
	expect(h.launches()).toBe(0);
	expect(h.state()).toBe("awaiting integration");
	expect(h.display()).toContain("awaiting integration");
	expect(todoRowAfterWorker(h.row())?.kind).not.toBe("needs-worker");
	expect(h.notice()).toContain("NEXT ACTION:");
	expect(h.notice()).toContain(`git -C '${h.repo}' merge --no-edit ${h.commit}`);
	expect(h.notice()).not.toContain("git-pr-owner");
	expect(h.notice()).not.toContain("audit-failed");
	expect(await h.check()).toBe(0);
	expect(todoRowDeliveryKey(h.row().schedule)).toBe(identity);
});

test("R2: integration alone starts the audit without a new worker or delivery identity", async () => {
	const h = fixture();
	const identity = todoRowDeliveryKey(h.row().schedule);
	expect(await h.check()).toBe(0);
	expect(h.state()).toBe("awaiting integration");
	git(h.repo, "merge", "--no-edit", h.commit);
	expect(await h.check()).toBe(1);
	await h.settled;
	expect(h.launches()).toBe(1);
	expect(h.row().schedule?.audit?.verdict).toBe("pass");
	expect(h.row().status).toBe("completed");
	expect(todoRowDeliveryKey(h.row().schedule)).toBe(identity);
});

test("negative: nonexistent commit remains failed delivery, not integration pending", async () => {
	const h = fixture("missing");
	expect(await h.check()).toBe(0);
	expect(h.launches()).toBe(0);
	expect(h.state()).toBe("needs worker");
	expect(h.row().schedule?.audit?.findings).toContain("Cannot verify delivery commit");
	expect(h.notice()).not.toContain("merge --no-edit");
});

test("negative: reachable delivery with a failing audit retains its findings", async () => {
	const h = fixture("reachable", true);
	expect(await h.check()).toBe(1);
	await h.settled;
	expect(h.row().schedule?.audit?.verdict).toBe("fail");
	expect(todoRowAfterWorker(h.row())).toMatchObject({ kind: "needs-worker", reason: "audit-failed", findings: expect.stringContaining("Result violates acceptance") });
	expect(h.notice()).toContain("Result violates acceptance");
	expect(h.notice()).not.toContain("merge --no-edit");
});

test("negative: no commit receipt preserves the existing audit and delivery identity", async () => {
	const h = fixture("none");
	const identity = todoRowDeliveryKey(h.row().schedule);
	expect(await h.check()).toBe(1);
	await h.settled;
	expect(h.launches()).toBe(1);
	expect(h.row().status).toBe("completed");
	expect(h.row().schedule?.audit?.verdict).toBe("pass");
	expect(todoRowDeliveryKey(h.row().schedule)).toBe(identity);
});
