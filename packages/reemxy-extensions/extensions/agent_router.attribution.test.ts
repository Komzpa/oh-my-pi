import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createRouterState, recordTaskOutcome } from "./agent_router";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const chosen = "deepseek/deepseek-v4-pro:high";
const first = "xiaomi/mimo-v2.6-flash";
const served = "codex-lb/gpt-6-luna:low";
const at = "2026-10-01T01:02:18.693Z";
const reason = { class: "auth", status: 401, message: "401 Invalid API Key", source: "provider-error" } as const;

async function outcome(result: Record<string, unknown>, wait = false) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-attribution-"));
	dirs.push(dir);
	const state = createRouterState();
	state.spawns.set("worker", { kind: "spawn", spawnKey: "worker", agent: "coder", at, chosen, order: [chosen, first, served], recordedOutcome: false });
	const cooldowns: string[] = [];
	const context = { sessionManager: { getHeader: () => ({ id: "parent" }) }, modelRegistry: { isSelectorSuppressed: () => false, suppressSelector: (key: string) => cooldowns.push(key) } } as unknown as ExtensionContext;
	const rows = await recordTaskOutcome({ toolName: wait ? "wait" : "task", details: wait ? { jobs: [{ id: "worker", status: "completed", durationMs: 100, ...result }] } : { results: [{ agent: "coder", exitCode: 0, durationMs: 100, ...result }] } } as never, context, state, { stateFile: path.join(dir, "spawns.jsonl") });
	return { row: rows[0]!, cooldowns };
}

test("served attribution preserves chosen and first turn on task and wait outcomes", async () => {
	for (const wait of [false, true]) {
		const { row } = await outcome({ resolvedModel: served, firstTurnModel: first, fallbacks: [{ from: first, to: served, at, reason }] }, wait);
		expect(row.chosen).toBe(chosen);
		expect(row.resolvedModel).toBe(served);
		expect(row.firstTurnModel).toBe(first);
		expect(row.status).toBe("completed");
	}
});

test("fallback outcome records exact provider error class status and message head", async () => {
	const { row } = await outcome({ resolvedModel: served, firstTurnModel: first, fallbacks: [{ from: first, to: served, at, reason }] });
	expect(row.fallbacks).toEqual([{ from: first, to: served, at, reason }]);
});

test("retry cooldown belongs only to the failing fallback source not chosen or successful served", async () => {
	const { cooldowns } = await outcome({ resolvedModel: served, firstTurnModel: first, fallbacks: [{ from: first, to: served, at, reason }] });
	expect(cooldowns).toEqual([first]);
	expect(cooldowns).not.toContain(chosen);
	expect(cooldowns).not.toContain(served);
});

test("spawn substitution without a recorded trigger never invents failure cooldown", async () => {
	const { row, cooldowns } = await outcome({ resolvedModel: served });
	expect(row.resolvedModel).toBe(served);
	expect(cooldowns).toEqual([]);
	expect(row.fallbackReason).toBe("unrecorded");
});
