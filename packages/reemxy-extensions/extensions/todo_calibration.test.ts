import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { sessionContextEntryMetadata, type SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { forecastTodoPlan, formatPlanForecast, formatTaskForecast } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { calibrationHints, percentile, readDurationHistory, stripThinkingSuffix } from "./todo_calibration";
import todoDispatch from "./todo_dispatch";

let dir: string;
let journal: string;
const savedState = process.env.OMP_AGENT_ROUTER_STATE;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "todo-calibration-"));
	journal = join(dir, "spawns.jsonl");
	process.env.OMP_AGENT_ROUTER_STATE = journal;
});
afterEach(() => {
	if (savedState === undefined) delete process.env.OMP_AGENT_ROUTER_STATE;
	else process.env.OMP_AGENT_ROUTER_STATE = savedState;
	rmSync(dir, { recursive: true, force: true });
});

function outcome(spawnKey: string, agent: string, model: string, seconds: number, status = "completed") {
	return JSON.stringify({ kind: "outcome", spawnKey, jobId: spawnKey, at: "2026-10-20T10:00:00.000Z", agent, chosen: model, order: [model], status, durationMs: seconds * 1000 });
}
function writeJournal(lines: string[]) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(journal, `${lines.join("\n")}\n`);
}
/** `count` finished runs of `role` on `model`, lasting 60 s, 120 s, ... */
function runs(role: string, model: string, count: number, prefix = role) {
	return Array.from({ length: count }, (_, i) => outcome(`${prefix}-${i}`, role, model, 60 * (i + 1)));
}

test("history keeps completed runs only and strips the thinking suffix from the model", () => {
	writeJournal([
		outcome("a", "coder", "provider/m:high", 600),
		outcome("b", "coder", "provider/m:low", 300, "failed"),
		outcome("c", "coder", "provider/m", 0),
		"not json",
		JSON.stringify({ kind: "spawn", spawnKey: "d", at: "2026-10-20T10:00:00.000Z", agent: "qa", chosen: "other/n:medium", order: [] }),
	]);
	const history = readDurationHistory(journal);
	expect(history.samples).toEqual([{ spawnKey: "a", role: "coder", model: "provider/m", seconds: 600 }]);
	// A spawn that has not finished still resolves its owner id to a role and model.
	expect(history.spawns.get("d")).toEqual({ role: "qa", model: "other/n" });
	expect(stripThinkingSuffix("provider/m:xhigh")).toBe("provider/m");
	expect(readDurationHistory(join(dir, "missing.jsonl")).samples).toEqual([]);
});

test("a hint needs ten finished runs of the owner's role/model and reports median and p90", () => {
	writeJournal([...runs("coder", "provider/m", 10), ...runs("qa", "provider/n", 9), ...runs("coder", "provider/other", 12, "other")]);
	const history = readDurationHistory(journal);
	const hints = calibrationHints(
		[
			{ task: "t1", owner: "coder-0" },
			{ task: "t2", owner: "coder-3" },
			{ task: "t3", owner: "qa-1" },
			{ task: "t4", owner: "nobody-we-know" },
		],
		history,
	);
	// 60..600 s: median 330 s -> 6 min (5.5 rounds up), p90 546 s -> 9 min; both owners share one line.
	expect(hints).toEqual(["history for coder/provider/m: median 6 min, p90 9 min (10 finished runs)"]);
	// Nine qa runs is thin history: no line, rather than a number that looks calibrated.
	expect(hints.join("\n")).not.toContain("qa");
	expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
});

test("an owner that names a role is calibrated on the whole role", () => {
	writeJournal([...runs("coder", "provider/m", 6), ...runs("coder", "provider/other", 6, "other")]);
	expect(calibrationHints([{ task: "t", owner: "coder" }], readDurationHistory(journal))).toEqual([
		"history for coder: median 4 min, p90 6 min (12 finished runs)",
	]);
});

function branchMock(getBranch: () => unknown[]) {
	return {
		getBranch,
		getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
		getLatestBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) => getBranch().findLast(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
	};
}

async function scheduleResult(updates: unknown[], phases: unknown[], isError = false) {
	const cwd = mkdtempSync(join(tmpdir(), "todo-calibration-repo-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const now = Date.now();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
		pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, readGoalDeadline: () => ({ goalId: "g", deadlineAt: now + 3_600_000 }), getLatestTodoPhasesFromEntries, agentPauseGate },
		registerSoftToolRequirementProvider: () => undefined,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctx = {
		cwd,
		sessionManager: { getHeader: () => ({ id: "calibration" }), ...branchMock(() => []), getSessionFile: () => undefined },
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}),
		clearTimer: () => undefined,
	} as unknown as ExtensionContext;
	try {
		return (await handlers.get("tool_result")!(
			{ toolName: "todo", toolCallId: "s", input: { op: "schedule", updates }, content: [{ type: "text", text: "ok" }], details: { op: "schedule", phases }, isError },
			ctx,
		)) as { content: Array<{ text: string }> } | undefined;
	} finally {
		handlers.get("session_shutdown")?.({}, ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
}

const rowsOf = (...owners: Array<string | undefined>) => [
	{
		name: "Work",
		tasks: owners.map((owner, i) => ({
			content: `Row ${i}`,
			status: "pending",
			schedule: { dependencies: [], resources: [`r${i}`], ...(owner ? { owner } : {}), estimate: { optimisticSeconds: 60 + i, likelySeconds: 120 + i, pessimisticSeconds: 240 + i, confidence: "medium", basis: "fixture", updatedAt: Date.now() } },
		})),
	},
];

test("a schedule result lists history for the owners it set, generic text only", async () => {
	writeJournal(runs("coder", "provider/m", 10));
	const out = await scheduleResult([{ task: "Row 0", owner: "coder-1" }, { task: "Row 1" }], rowsOf("coder-1", "coder-2"));
	const text = out!.content.map(part => part.text).join("\n");
	expect(text).toContain("history for coder/provider/m: median 6 min, p90 9 min (10 finished runs)");
	expect(text).not.toMatch(/darafei|tbilisi|komzpa/i);
});

test("no hint without enough history, for a non-schedule call, or for a refused call", async () => {
	writeJournal(runs("coder", "provider/m", 9));
	const thin = await scheduleResult([{ task: "Row 0", owner: "coder-1" }], rowsOf("coder-1"));
	expect(thin?.content.map(part => part.text).join("\n") ?? "").not.toContain("history for");
	writeJournal(runs("coder", "provider/m", 10));
	const refused = await scheduleResult([{ task: "Row 0", owner: "coder-1" }], rowsOf("coder-1"), true);
	expect(refused).toBeUndefined();
});
