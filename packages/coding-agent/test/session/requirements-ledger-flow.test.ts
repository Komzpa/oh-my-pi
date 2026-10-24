import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	RequirementsLedgerRuntime,
	type RequirementPublicationGate,
} from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import {
	getLatestTodoPhasesFromEntries,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import { formatRequirementIdentity } from "@oh-my-pi/pi-coding-agent/utils/requirement-artifact";

const AT = "2026-10-24T10:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
	return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function todoTool(cwd: string, manager: SessionManager): TodoTool {
	let phases = getLatestTodoPhasesFromEntries(manager.getBranch());
	return new TodoTool({
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		sessionManager: manager,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	});
}

function fixture(options: { candidate?: boolean; linked?: boolean; withCheckout?: boolean } = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-requirement-flow-"));
	fs.mkdirSync(cwd, { recursive: true });
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "flow@example.invalid");
	git(cwd, "config", "user.name", "Requirement Flow Test");
	fs.writeFileSync(path.join(cwd, "artifact.txt"), "before\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "initial artifact");
	const oldHead = git(cwd, "rev-parse", "HEAD");
	const manager = SessionManager.inMemory();
	const candidate =
		options.candidate || options.linked ? createRequirementCandidates([], ["Audit the build artifact"], AT) : [];
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements: candidate });
	let requirements = candidate;
	if (options.linked) {
		const result = classifyRequirement(requirements, "R1", "linked", { rows: ["Build artifact"] });
		if ("error" in result) throw new Error(result.error);
		requirements = result.requirements;
	}
	if (options.withCheckout) {
		requirements[0]!.rowVerdicts = {
			"Build artifact": {
				status: "pass",
				evidence: "checked build output",
				artifact: formatRequirementIdentity({ kind: "git", repo: cwd, commit: oldHead }),
				workerId: "qa-1",
				auditor: "qa-auditor",
				rawWords: requirements[0]!.rawText,
				receivedAt: AT,
			},
		};
	}
	if (options.linked || options.withCheckout) {
		appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, requirements);
	}
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Build",
				tasks: [
					{
						content: "Build artifact",
						status: "pending",
						schedule: { owner: "main", resources: [cwd] },
					},
				],
			},
		],
	});
	let gate: RequirementPublicationGate | undefined;
	const notices: string[] = [];
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		queueModelNotice: notice => {
			notices.push(notice);
		},
		setPublicationGate: next => {
			gate = next;
		},
	});
	return { cwd, manager, notices, runtime, gate: () => gate };
}

describe("requirements ledger flow notices", () => {
	it("puts a named repair action first on each QA scope refusal", async () => {
		const assertAction = async (action: () => Promise<unknown>, reference: string) => {
			let error: unknown;
			try {
				await action();
			} catch (reason) {
				error = reason;
			}
			expect(error).toBeDefined();
			const firstLine = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]!;
			expect(firstLine.length).toBeLessThanOrEqual(100);
			expect(firstLine).toContain(reference);
			expect(firstLine.startsWith("Blocked:")).toBe(false);
		};
		const empty = fixture({ linked: true });
		try {
			await assertAction(
				() =>
					empty.runtime.prepareAuditorTaskCall("task", "empty-scope", {
						agent: "qa-auditor",
						requirementIds: [],
						task: "Audit",
					}),
				"qa-auditor",
			);
		} finally {
			fs.rmSync(empty.cwd, { recursive: true, force: true });
		}
		const unknown = fixture({ linked: true });
		try {
			await assertAction(
				() =>
					unknown.runtime.prepareAuditorTaskCall("task", "unknown-scope", {
						agent: "qa-auditor",
						requirementIds: ["R99"],
						task: "Audit",
					}),
				"R99",
			);
		} finally {
			fs.rmSync(unknown.cwd, { recursive: true, force: true });
		}
		const missing = fixture({ linked: true });
		try {
			const current = getLatestRequirements(missing.manager.getBranch());
			const changed = current.map(requirement => ({ ...requirement, rows: ["Missing row"] }));
			appendRequirementsSnapshot(
				{ appendEntry: (type, data) => missing.manager.appendCustomEntry(type, data) },
				changed,
			);
			await assertAction(
				() =>
					missing.runtime.prepareAuditorTaskCall("task", "missing-row", {
						agent: "qa-auditor",
						requirementIds: ["R1"],
						task: "Audit",
					}),
				"R1",
			);
		} finally {
			fs.rmSync(missing.cwd, { recursive: true, force: true });
		}
		const unmatched = fixture({ linked: true });
		try {
			await assertAction(
				() =>
					unmatched.runtime.prepareAuditorTaskCall("task", "unmatched-name", {
						agent: "qa-auditor",
						name: "OtherAudit",
						task: "Audit",
					}),
				"OtherAudit",
			);
		} finally {
			fs.rmSync(unmatched.cwd, { recursive: true, force: true });
		}
	});

	it("announces candidate IDs and the exact classify operation when capture creates them", async () => {
		const { cwd, manager, notices, runtime } = fixture();
		try {
			await runtime.captureCandidate("Please preserve the build output");
			expect(notices).toHaveLength(1);
			expect(notices[0]!.split("\n")).toHaveLength(2);
			expect(notices[0]).toContain("Classify R1");
			expect(notices[0]).toContain('op="classify", id="R1"');
			expect(notices[0]).toContain("completion stays gated");
			expect(
				manager
					.getBranch()
					.some(entry => entry.type === "custom" && entry.customType === "requirements_flow_notice"),
			).toBe(true);
			const todo = todoTool(cwd, manager);
			await runtime.beforeTodoCall?.("todo", { op: "done", task: "Build artifact" });
			const done = await todo.execute("candidate-done-flow", { op: "done", task: "Build artifact" });
			expect(done.isError).toBe(true);
			expect(done.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n")).toContain(
				"Classify R1",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("announces linked rows before a done refusal and deduplicates the same row state", async () => {
		const { cwd, manager, notices, runtime } = fixture({ candidate: true });
		try {
			const todo = todoTool(cwd, manager);
			const classified = await todo.execute("classify-flow", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: ["Build artifact"],
			});
			expect(classified.isError).toBeFalsy();
			await runtime.afterToolCall({
				toolCall: { id: "classify-flow", name: "todo" },
				result: classified,
				isError: false,
			} as never);
			const started = await todo.execute("start-flow", { op: "start", task: "Build artifact" });
			expect(started.isError).toBeFalsy();
			await runtime.afterToolCall({
				toolCall: { id: "start-flow", name: "todo" },
				result: started,
				isError: false,
			} as never);
			expect(notices[0]).toContain('requirementIds:["R1"]');
			expect(notices[0]).toContain("current artifact");
			const before = notices.length;
			await runtime.beforeTodoCall?.("todo", { op: "done", task: "Build artifact" });
			const afterFirstGate = notices.length;
			expect(afterFirstGate).toBeGreaterThan(before);
			expect(notices.slice(before).join("\n")).toContain("ledger after completion");
			const done = await todo.execute("done-flow", { op: "done", task: "Build artifact" });
			expect(done.isError).toBe(true);
			const refusal = done.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
			expect(refusal).toContain("Re-audit R1");
			expect(notices[0]).toContain("Audit R1");
			await runtime.beforeTodoCall?.("todo", { op: "done", task: "Build artifact" });
			expect(notices.length).toBe(afterFirstGate);
			for (const notice of notices) expect(notice.split("\n")).toHaveLength(2);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("announces retained links before actual row removal and init refusals", async () => {
		const { cwd, manager, notices, runtime } = fixture({ linked: true });
		try {
			const todo = todoTool(cwd, manager);
			await runtime.beforeTodoCall?.("todo", { op: "rm", task: "Build artifact" });
			expect(notices[0]).toContain("stays linked");
			expect(notices[0]).toContain("ledger history and verdicts are retained");
			const removal = await todo.execute("remove-flow", { op: "rm", task: "Build artifact" });
			expect(removal.isError).toBe(true);
			expect(removal.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n")).toContain("R1");
			await runtime.beforeTodoCall?.("todo", { op: "init", list: [{ phase: "New", items: ["Replacement"] }] });
			expect(notices[1]).toContain("stays linked");
			const replacement = await todo.execute("init-flow", {
				op: "init",
				list: [{ phase: "New", items: ["Replacement"] }],
			});
			expect(replacement.isError).toBe(true);
			expect(replacement.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n")).toContain(
				"R1",
			);
			const retained = getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === "R1");
			expect(retained?.rows).toEqual(["Build artifact"]);
			for (const notice of notices) expect(notice.split("\n")).toHaveLength(2);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("announces a saved pass becoming stale before the publication refusal", async () => {
		const { cwd, manager, notices, runtime, gate } = fixture({ linked: true, withCheckout: true });
		try {
			fs.writeFileSync(path.join(cwd, "artifact.txt"), "after\n");
			git(cwd, "add", ".");
			git(cwd, "commit", "-m", "change audited artifact");
			await runtime.beforeTodoCall?.("todo", { op: "done", task: "Build artifact" });
			expect(notices.find(notice => notice.includes("Re-audit R1"))).toContain("Re-audit R1");
			const todo = todoTool(cwd, manager);
			const done = await todo.execute("stale-done-flow", { op: "done", task: "Build artifact" });
			expect(done.isError).toBe(true);
			const doneRefusal = done.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
			expect(doneRefusal).toContain("Re-audit R1");
			const noticesAfterDone = notices.length;
			const publicationGate = gate();
			expect(publicationGate).toBeDefined();
			const refusal = await publicationGate!(
				{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as never,
				new AbortController().signal,
			);
			const staleNotice = notices.find(notice => notice.includes("Re-audit R1"));
			expect(staleNotice).toContain("Re-audit R1");
			expect(staleNotice).toContain('requirementIds:["R1"]');
			expect(refusal && "replacementText" in refusal ? refusal.replacementText : "").toContain("Not audit-verified");
			const retained = getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === "R1");
			expect(retained?.rows).toEqual(["Build artifact"]);
			expect(retained?.rowVerdicts?.["Build artifact"]?.status).toBe("pass");
			await publicationGate!(
				{ role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } as never,
				new AbortController().signal,
			);
			expect(notices.length).toBe(noticesAfterDone);
			expect(notices.filter(notice => notice.includes("Re-audit R1"))).toEqual([
				notices.find(notice => notice.includes("Re-audit R1"))!,
			]);
			for (const notice of notices) expect(notice.split("\n")).toHaveLength(2);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
