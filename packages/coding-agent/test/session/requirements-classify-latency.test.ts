import { useFastGitStatusCoordinator } from "../helpers/fast-status-coordinator.js";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import * as todoArtifacts from "../../src/tools/todo";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
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

const AT = "2026-10-24T10:00:00.000Z";
const BOUND_MS = 500;

function git(cwd: string, ...args: string[]): string {
	return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(queueModelNotice: (notice: string) => Promise<void>, rowCount = 1) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-classify-latency-"));
	dirs.push(cwd);
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "latency@example.invalid");
	git(cwd, "config", "user.name", "Latency Test");
	fs.writeFileSync(path.join(cwd, "artifact.txt"), "x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "init");
	const manager = SessionManager.inMemory();
	const rows = Array.from({ length: rowCount }, (_, index) =>
		index === 0 ? "Build artifact" : `Other artifact ${index + 1}`,
	);
	const files = rows.map((_, index) => path.join(cwd, `bound-${index + 1}.txt`));
	for (const file of files) fs.writeFileSync(file, "before\n");
	const requirements = createRequirementCandidates(
		[],
		rows.map(row => `Audit ${row}`),
		AT,
	).map((item, index) => ({
		...item,
		...(index > 0 ? { classification: "linked" as const, rows: [rows[index]!] } : {}),
	}));
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements,
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Build",
				tasks: rows.map((content, index) => ({
					content,
					status: "pending",
					schedule: { owner: "main", resources: [files[index]!] },
				})),
			},
		],
	});
	let phases = getLatestTodoPhasesFromEntries(manager.getBranch());
	const todo = new TodoTool({
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
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		queueModelNotice,
		setPublicationGate: () => {},
	});
	/** Runs classify and its afterToolCall hook the way the agent loop does; returns the elapsed ms. */
	const classify = async (): Promise<number> => {
		const startedAt = performance.now();
		const classified = await todo.execute("classify-latency", {
			op: "classify",
			id: "R1",
			classification: "linked",
			rows: ["Build artifact"],
		});
		expect(classified.isError).toBeFalsy();
		await runtime.afterToolCall({
			toolCall: { id: "classify-latency", name: "todo" },
			args: { op: "classify", id: "R1", classification: "linked", rows: ["Build artifact"] },
			result: classified,
			isError: false,
		} as never);
		return performance.now() - startedAt;
	};
	return { runtime, classify, todo, manager, files, rows };
}

function saveSelectedPass(manager: SessionManager, file: string): void {
	const requirements = getLatestRequirements(manager.getBranch());
	requirements[0]!.rowVerdicts = {
		"Build artifact": {
			status: "pass",
			artifact: `file:${file}@sha256=${new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex")}`,
			evidence: "checked bytes",
			workerId: "qa-1",
			auditor: "qa-auditor",
			rawWords: requirements[0]!.rawText,
			receivedAt: "2100-01-01T00:00:00.000Z",
		},
	};
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 1, requirements });
}

/**
 * Regression: the afterToolCall hook of `todo classify` resolved every linked row's artifact
 * (checkout hashing through the git status coordinator) and awaited the model-notice delivery
 * inside the tool's own turn, so classify held the lead for minutes behind busy workers.
 */
describe("todo classify latency", () => {
	useFastGitStatusCoordinator();

	it("never awaits notice delivery inside the tool, then delivers the notice later", async () => {
		const delivered: string[] = [];
		let releaseNotice!: () => void;
		const noticeGate = new Promise<void>(resolve => {
			releaseNotice = resolve;
		});
		const { runtime, classify } = setup(async notice => {
			await noticeGate;
			delivered.push(notice);
		});
		expect(await classify()).toBeLessThan(BOUND_MS);
		expect(delivered).toHaveLength(0);
		releaseNotice();
		await runtime.settleBackgroundNotices();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain('requirementIds:["R1"]');
	});
});

describe("todo classify latency with the production status cadence", () => {
	it("returns within the bound while checkout hashing is still pending", async () => {
		const delivered: string[] = [];
		const { classify } = setup(async notice => {
			delivered.push(notice);
		});
		expect(await classify()).toBeLessThan(BOUND_MS);
	});
});

describe("requirements foreground work stays local to the selected row", () => {
	it("classifies and starts among 100 linked rows without probing any artifact, while announcing only the affected row", async () => {
		const notices: string[] = [];
		const { runtime, classify, todo } = setup(async notice => {
			notices.push(notice);
		}, 100);
		const resolveArtifact = spyOn(todoArtifacts, "getRequirementRowArtifact");
		const open = spyOn(asyncFs, "open");
		const lstat = spyOn(asyncFs, "lstat");
		const startedAt = performance.now();
		await classify();
		await runtime.settleBackgroundNotices();
		const started = await todo.execute("start-local", { op: "start", task: "Build artifact" });
		expect(started.isError).toBeFalsy();
		await runtime.afterToolCall({
			toolCall: { id: "start-local", name: "todo" },
			args: { op: "start", task: "Build artifact" },
			result: started,
			isError: false,
		} as never);
		await runtime.settleBackgroundNotices();
		expect(resolveArtifact).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(lstat).not.toHaveBeenCalled();
		expect(performance.now() - startedAt).toBeLessThan(200);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('requirementIds:["R1"]');
		expect(notices[0]).toContain("qa-auditor");
		expect(notices[0]).not.toContain("R2");
	});

	it("checks the selected passing artifact once at done, even with 99 neighboring linked rows", async () => {
		const { runtime, classify, todo, manager, files } = setup(async () => {}, 100);
		await classify();
		await runtime.settleBackgroundNotices();
		saveSelectedPass(manager, files[0]!);
		const open = spyOn(asyncFs, "open");
		await runtime.beforeTodoCall("todo", { op: "done", task: "Build artifact" });
		const done = await todo.execute("done-local", { op: "done", task: "Build artifact" });
		expect(done.isError).toBeFalsy();
		expect(open.mock.calls.map(args => args[0])).toEqual([files[0]!]);
	});
	it("reopens a same-size edited artifact with restored mtime, then accepts a fresh pass despite a neighboring edit", async () => {
		const notices: string[] = [];
		const { runtime, classify, todo, manager, files } = setup(async notice => {
			notices.push(notice);
		}, 100);
		await classify();
		await runtime.settleBackgroundNotices();
		saveSelectedPass(manager, files[0]!);
		const before = fs.statSync(files[0]!);
		fs.writeFileSync(files[0]!, "after!\n");
		fs.utimesSync(files[0]!, before.atime, before.mtime);
		expect(fs.statSync(files[0]!).size).toBe(before.size);
		await runtime.beforeTodoCall("todo", { op: "done", task: "Build artifact" });
		const stale = await todo.execute("done-stale", { op: "done", task: "Build artifact" });
		expect(stale.isError).toBe(true);
		expect(
			stale.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n"),
		).toContain("Re-audit R1");
		await runtime.afterToolCall({
			toolCall: { id: "done-stale", name: "todo" },
			args: { op: "done", task: "Build artifact" },
			result: stale,
			isError: true,
		} as never);
		expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts?.["Build artifact"]?.status).toBe(
			"unverifiable",
		);
		expect(notices.find(notice => notice.includes("Re-audit R1"))).toContain('requirementIds:["R1"]');
		saveSelectedPass(manager, files[0]!);
		fs.writeFileSync(files[1]!, "changed unrelated artifact\n");
		await runtime.beforeTodoCall("todo", { op: "done", task: "Build artifact" });
		const fresh = await todo.execute("done-fresh", { op: "done", task: "Build artifact" });
		expect(fresh.isError).toBeFalsy();
	});
});
