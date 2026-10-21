import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode restart", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let originalArgv: string[];
	let lastRestartErrors: string[] = [];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-restart-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		originalArgv = process.argv;
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "persona sessions"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.argv = originalArgv;
		await session?.dispose();
		session = undefined;
		await sessionManager.close();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	/**
	 * Restart is queue-based: `restart()` files a request that the controller bound by
	 * `init()` executes once the session is idle. Drive the real queue and stop only at
	 * the `process.execve` replacement boundary; teardown and argv production run for real.
	 * Returns `undefined` when no successor was exec'd; `lastRestartErrors` then holds the reasons shown.
	 */
	async function restart(argv: string[]): Promise<string[] | undefined> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		const executed = Promise.withResolvers<string[]>();
		vi.spyOn(process, "execve").mockImplementation(((_file: string, args: string[]) => {
			executed.resolve(args);
			// Stand in for a successful exec, which never returns to the caller.
			throw new Error("execve replaced the process");
		}) as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		const showError = vi.spyOn(mode, "showError");
		await mode.init();
		await mode.restart();
		const outcome = await Promise.race([executed.promise, Bun.sleep(5_000).then(() => undefined)]);
		if (outcome === undefined) {
			// A refused restart reports the reason to the user instead of exiting.
			lastRestartErrors = showError.mock.calls.map(call => String(call[0]));
		}
		return outcome;
	}

	it("resumes an explicitly opened persona journal without rediscovering its ID", async () => {
		sessionManager.appendMessage({ role: "user", content: "initial request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "saved answer" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			timestamp: 2,
		});
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const transcript = sessionManager.buildSessionContext().messages;
		await sessionManager.close();
		sessionManager = await SessionManager.open(file);
		const command = await restart([
			"--session",
			file,
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--append-system-prompt",
			"persona prompt",
			"--skills",
			"/office/skills",
			"-e",
			"/office/extension.ts",
			"--model",
			"openai-codex/gpt-6.1-sol:high",
			"initial request",
		]);
		if (!command) throw new Error("expected replacement command");
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("openai-codex/gpt-6.1-sol:high");
		expect(parsed.messages).toEqual([]);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(file);
			expect(resumed.getSessionId()).toBe(id);
			// The journal resumes intact; the only addition is the restart request's own queue notice.
			expect(resumed.buildSessionContext().messages).toEqual([
				...transcript,
				expect.objectContaining({ role: "custom", customType: "restart-queued" }),
			]);
		} finally {
			await resumed.close();
		}
	});

	it("resumes a journal created in a flag-looking relative directory", async () => {
		using relativeDir = TempDir.createSync("-omp-restart-");
		await sessionManager.close();
		sessionManager = SessionManager.create(tempDir.path(), relativeDir.path());
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", `--session-dir=${relativeDir.path()}`]);
		if (!command) throw new Error("expected replacement command");
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(file));
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "saved request", timestamp: 1 },
				expect.objectContaining({ role: "custom", customType: "restart-queued" }),
			]);
		} finally {
			await resumed.close();
		}
	});

	it("materializes a never-written journal with the restart notice and resumes that exact file", async () => {
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected allocated journal path");
		expect(await Bun.file(file).exists()).toBe(false);
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", "initial request"]);
		if (!command) throw new Error(`expected replacement command; errors: ${lastRestartErrors.join("; ")}`);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		// Queueing the restart writes its notice, so the relaunch has a durable journal to resume
		// and does not replay the original prompt into a fresh session.
		expect(parsed.resume).toBe(file);
		expect(parsed.messages).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(true);
	});
});
