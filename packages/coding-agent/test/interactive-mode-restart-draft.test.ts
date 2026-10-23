import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

const LARGE_PASTE = `\x1b[200~${Array.from({ length: 12 }, (_, i) => `pasted line ${i + 1}`).join("\n")}\x1b[201~`;
const LEFT = "\x1b[D";

/** Real InteractiveMode, real restart queue; only the `process.execve` boundary is replaced. */
describe("InteractiveMode restart keeps the unsent editor draft", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let sessions: AgentSession[] = [];
	let modes: InteractiveMode[] = [];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-restart-draft-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		sessions = [];
		modes = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const mode of modes) mode.ui.stop();
		for (const session of sessions) await session.dispose();
		await sessionManager.close();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	function createMode(manager: SessionManager): InteractiveMode {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		sessions.push(session);
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		modes.push(mode);
		return mode;
	}

	function type(mode: InteractiveMode, ...keys: string[]): void {
		for (const key of keys) mode.editor.handleInput(key);
	}

	async function resume(file: string): Promise<InteractiveMode> {
		const resumedManager = await SessionManager.open(file);
		const resumed = createMode(resumedManager);
		await resumed.init();
		return resumed;
	}

	async function restartFrom(mode: InteractiveMode, beforeRestart?: () => void): Promise<string> {
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected durable journal");
		const executed = Promise.withResolvers<string[]>();
		vi.spyOn(process, "execve").mockImplementation(((_file: string, args: string[]) => {
			executed.resolve(args);
			throw new Error("execve replaced the process");
		}) as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		beforeRestart?.();
		await mode.restart();
		const command = await Promise.race([executed.promise, Bun.sleep(5_000).then(() => undefined)]);
		if (!command) throw new Error("restart did not reach the exec boundary");
		return file;
	}

	it("restores text and mid-text cursor in the resumed editor", async () => {
		const mode = createMode(sessionManager);
		await mode.init();
		type(mode, ..."hello world", LEFT, LEFT, LEFT);
		const before = { text: mode.editor.getText(), cursor: mode.editor.getCursor() };
		expect(before.cursor.col).toBe(8);

		const file = await restartFrom(mode);
		const resumed = await resume(file);

		expect(resumed.editor.getText()).toBe(before.text);
		expect(resumed.editor.getCursor()).toEqual(before.cursor);
	});

	it("restores the collapsed paste payload so submit still expands it", async () => {
		const mode = createMode(sessionManager);
		await mode.init();
		type(mode, ..."ab ", LARGE_PASTE, ..."cd", LEFT, LEFT);
		const before = {
			text: mode.editor.getText(),
			cursor: mode.editor.getCursor(),
			expanded: mode.editor.getExpandedText(),
		};
		expect(before.expanded).toContain("pasted line 12");
		expect(before.cursor.col).toBeLessThan(before.text.length);

		const file = await restartFrom(mode);
		const resumed = await resume(file);

		expect(resumed.editor.getText()).toBe(before.text);
		expect(resumed.editor.getExpandedText()).toBe(before.expanded);
	});

	it("keeps keys typed while the restart checkpoint was flushing", async () => {
		const mode = createMode(sessionManager);
		await mode.init();
		type(mode, ..."hello wor");
		const close = sessionManager.close.bind(sessionManager);
		vi.spyOn(sessionManager, "close").mockImplementation(async () => {
			// The user is still typing while the journal flushes after the draft snapshot.
			type(mode, ..."ld!");
			await close();
		});

		const file = await restartFrom(mode);
		const resumed = await resume(file);

		expect(resumed.editor.getText()).toBe("hello world!");
	});

	it("leaves an empty editor empty and writes no draft sidecars", async () => {
		const mode = createMode(sessionManager);
		await mode.init();
		const file = await restartFrom(mode);
		const artifacts = sessionManager.getArtifactsDir();
		if (!artifacts) throw new Error("expected artifacts dir");
		expect(await Bun.file(path.join(artifacts, "draft.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(artifacts, "draft-editor.json")).exists()).toBe(false);
		const resumed = await resume(file);
		expect(resumed.editor.getText()).toBe("");
	});

	it("does not resurrect a submitted message as a draft", async () => {
		const mode = createMode(sessionManager);
		await mode.init();
		const [session] = sessions;
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);
		type(mode, ..."already sent", "\r");
		await Bun.sleep(50);
		expect(mode.editor.getText()).toBe("");
		const file = await restartFrom(mode);
		const resumed = await resume(file);
		expect(resumed.editor.getText()).toBe("");
	});
});
