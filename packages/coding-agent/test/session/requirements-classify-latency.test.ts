import { useFastGitStatusCoordinator } from "../helpers/fast-status-coordinator.js";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	createRequirementCandidates,
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
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(queueModelNotice: (notice: string) => Promise<void>) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-classify-latency-"));
	dirs.push(cwd);
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "latency@example.invalid");
	git(cwd, "config", "user.name", "Latency Test");
	fs.writeFileSync(path.join(cwd, "artifact.txt"), "x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "init");
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], ["Audit the build artifact"], AT),
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Build",
				tasks: [{ content: "Build artifact", status: "pending", schedule: { owner: "main", resources: [cwd] } }],
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
			result: classified,
			isError: false,
		} as never);
		return performance.now() - startedAt;
	};
	return { runtime, classify };
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
