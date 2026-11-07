import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import todoDispatch, { GLOBAL_KILL_REFUSAL, isGlobalKillCommand } from "./todo_dispatch";

const REFUSED = [
	'pkill -f "vite preview"',
	"pkill -9 -f 'node.*playwright'",
	"pkill node",
	"killall chrome",
	"fuser -k 4173/tcp",
	"fuser -km /tmp/x",
	"kill -9 -1",
	"kill 0",
	"kill -- -1",
	"kill $(pgrep -f vite)",
	'kill -9 "$(lsof -ti :4173)"',
	"kill `fuser 4173/tcp`",
	"pgrep -f vite | xargs kill",
	"cd /tmp && sudo pkill -f chromium; echo done",
	"bash -c 'pkill -f vite'",
	"timeout 5 pkill -f vite",
];
const ALLOWED = [
	"kill 12345",
	"kill -9 12345",
	"kill -1 12345",
	"kill -TERM $pid",
	'echo "pkill -f vite is forbidden"',
	"grep -n 'killall' notes.txt",
	"git log --grep='fuser -k'",
	"cat pkill.md",
	"fuser 4173/tcp",
	"pgrep -f vite",
	"bun test extensions/one.test.ts",
];

test("global kill commands are recognized, plain PID kills and quoted text are not", () => {
	for (const command of REFUSED) expect(isGlobalKillCommand(command), command).toBe(true);
	for (const command of ALLOWED) expect(isGlobalKillCommand(command), command).toBe(false);
});

test("a subagent bash global kill is refused with the PID instruction; main and plain kill pass", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		getActiveTools: () => ["bash", "read"],
		pi: { forecastTodoPlan, formatPlanForecast, formatTaskForecast, getLatestTodoPhasesFromEntries, agentPauseGate, readGoalDeadline: () => null },
		registerSoftToolRequirementProvider: () => undefined,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
	} as unknown as ExtensionAPI;
	await todoDispatch(api);
	const ctxFor = (header: unknown) =>
		({
			cwd: "/tmp",
			sessionManager: { getHeader: () => header, getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined },
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			isIdle: () => true,
			hasPendingMessages: () => false,
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		}) as unknown as ExtensionContext;
	const sub = ctxFor({ id: "sub", parentSession: "main" });
	const main = ctxFor({ id: "main" });
	const call = (command: string) => ({ toolName: "bash", toolCallId: "k", input: { command } });
	const refused = (await handlers.get("tool_call")!(call('pkill -f "vite preview"'), sub)) as { block?: boolean; reason?: string };
	expect(refused.block).toBe(true);
	expect(refused.reason).toBe(GLOBAL_KILL_REFUSAL);
	expect(refused.reason).toContain("`kill <pid>`");
	const plain = (await handlers.get("tool_call")!(call("kill 12345"), sub)) as { block?: boolean } | undefined;
	expect(plain?.block).not.toBe(true);
	const chief = (await handlers.get("tool_call")!(call("pkill -f vite"), main)) as { reason?: string } | undefined;
	expect(chief?.reason).not.toBe(GLOBAL_KILL_REFUSAL);
}, 60_000);
