/** Offline restart benchmark. OMP_RESTART_BENCH_FIXTURE is a generated restart-pipeline fixture. */
import { vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { isCompiledBinary, logger, setAgentDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { DAEMON_BROKER_WORKER_ARG, RESTART_SNAPSHOT_WORKER_ARG } from "../src/cli/worker-selectors";
import { startDaemonBrokerFromEnvironment } from "../src/launch/broker";
import { runRestartSnapshotWorker } from "../src/task/restart-snapshot-worker";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import * as workerClient from "../src/subprocess/worker-client";

if (process.argv[2] === DAEMON_BROKER_WORKER_ARG) await startDaemonBrokerFromEnvironment();
else if (process.argv[2] === RESTART_SNAPSHOT_WORKER_ARG) await runRestartSnapshotWorker();
else if (process.argv[2]?.startsWith("__omp_worker_"))
	throw new Error(`Unsupported benchmark worker ${process.argv[2]}`);
else await benchmark();

async function benchmark(): Promise<void> {
	const root = process.env.OMP_RESTART_BENCH_FIXTURE!;
	if (!root) throw new Error("Set OMP_RESTART_BENCH_FIXTURE to a generated synthetic fixture");
	if (process.env.HOME !== root || process.env.TMPDIR !== path.join(root, "tmp"))
		throw new Error("Run through restart-end-to-end.py: HOME and TMPDIR must be isolated before imports");
	setAgentDir(path.join(root, "agent"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline restart benchmark"));
	vi.spyOn(AgentSession.prototype, "prewarmModelConnection").mockImplementation(() => {});
	if (process.env.OMP_RESTART_BENCH_PROFILE) {
		logger.startTiming();
		const getBranch = SessionManager.prototype.getBranch;
		vi.spyOn(SessionManager.prototype, "getBranch").mockImplementation(function (
			this: SessionManager,
			fromId?: string,
		) {
			return logger.time("benchmark:materializeBranch", () => getBranch.call(this, fromId));
		});
	}
	logger.setTransports({ file: path.join(root, "runtime.log"), console: false });
	const events = path.join(root, "e2e.jsonl");
	function mark(event: string, id?: string): void {
		fs.appendFileSync(
			events,
			`${JSON.stringify({ event, id, at: performance.timeOrigin + performance.now(), pid: process.pid })}\n`,
		);
	}
	logger.registerLogSink(({ message, context }) => {
		if (message.startsWith("Restart stage"))
			fs.appendFileSync(
				events,
				`${JSON.stringify({ event: message, ...context, pid: process.pid, at: performance.timeOrigin + performance.now() })}\n`,
			);
	});
	mark("module_ready");
	if (process.argv[2] === "--module-floor") process.exit(0);
	initTheme();
	await Settings.init({ inMemory: true, cwd: root });
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	const models = new ModelRegistry(auth);
	const model = models.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("missing bundled fixture model");
	function session(manager: SessionManager, id?: string): AgentSession {
		return logger.time(
			"benchmark:constructSession",
			() =>
				new AgentSession({
					agent: new Agent({
						initialState: {
							model,
							systemPrompt: ["offline benchmark"],
							tools: [],
							messages: manager.buildSessionContext().messages,
						},
						streamFn: () => {
							mark("worker_continuing", id);
							// The model transport is local and never makes a provider request.
							return new AssistantMessageEventStream();
						},
					}),
					sessionManager: manager,
					settings: Settings.isolated({ "spelling.autocomplete": "off" }),
					modelRegistry: models,
				}),
		);
	}
	const file = path.join(root, "sessions", "large.jsonl");
	mark("journal_open_started");
	const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
	mark("journal_open");
	const lead = session(manager);
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		kind: "main",
		displayName: "lead",
		session: lead,
		sessionFile: file,
		status: "idle",
	});
	const receive = Boolean(process.env.OMP_RESTART_SESSION_ID);
	if (!receive) {
		for (let i = 0; i < 4; i++) {
			const id = `bench-worker-${i}`;
			const childFile = path.join(root, "sessions", "large", `${id}.jsonl`);
			let child: SessionManager;
			if (fs.existsSync(childFile)) child = await SessionManager.open(childFile);
			else {
				child = SessionManager.create(path.join(root, `worker-${i}`), path.dirname(childFile));
				child.appendSessionInit({
					systemPrompt: ["offline benchmark"],
					task: "preserve dirty work",
					tools: [],
					isolated: true,
				});
				child.appendMessage({ role: "user", content: "continue work", timestamp: 1 });
				await child.ensureOnDisk();
				await child.close();
				fs.renameSync(child.getSessionFile()!, childFile);
				child = await SessionManager.open(childFile);
			}
			AgentRegistry.global().register({
				id,
				kind: "sub",
				displayName: id,
				parentId: MAIN_AGENT_ID,
				session: session(child, id),
				sessionFile: childFile,
				status: "running",
			});
		}
	} else {
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			async ref => async () => session(await SessionManager.open(ref.sessionFile!), ref.id),
			() => 0,
		);
	}
	const mode = new InteractiveMode(lead, "benchmark");
	// Use the real TUI layout/paint path with an output sink, without a desktop or TTY.
	let paintedBytes = 0;
	vi.spyOn(mode.ui.terminal, "start").mockImplementation(() => {});
	vi.spyOn(mode.ui.terminal, "stop").mockImplementation(() => {});
	vi.spyOn(mode.ui.terminal, "write").mockImplementation(data => {
		paintedBytes += data.length;
	});
	vi.spyOn(mode.ui.terminal, "drainInput").mockResolvedValue();
	vi.spyOn(mode, "showError").mockImplementation(message => mark(`error:${message}`));
	if (receive) {
		const remove = mode.ui.addPaintListener(() => {
			if (mode.editor.disableSubmit || !paintedBytes) return;
			remove();
			mode.editor.handleInput("x");
			if (!mode.editor.getText().includes("x")) throw new Error("first frame rejected input");
			mark("first_frame_input_accepted");
		});
	}
	mark("init_started");
	await mode.init();
	mark("init_complete");
	if (process.env.OMP_RESTART_BENCH_PROFILE) logger.printTimings();
	if (!receive) await Bun.sleep(150);
	if (!receive) {
		// Prepare before the request; compare both versions with the same warm-runtime setup.
		await manager.writeIndexHandoff();
		if (!isCompiledBinary())
			vi.spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([process.execPath, import.meta.path]);
		const exec = process.execve!;
		vi.spyOn(process, "execve").mockImplementation((...args) => {
			mark("old_runtime_exit");
			return exec(...args);
		});
		mark("request_accepted");
		await mode.restart();
	}
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		await Bun.sleep(10);
		const rows = Bun.JSONL.parse(await Bun.file(events).text()) as Array<{ event: string; id?: string }>;
		if (receive && new Set(rows.filter(row => row.event === "worker_continuing").map(row => row.id)).size === 4) {
			mark("all_workers_continuing");
			if (process.env.OMP_RESTART_BENCH_PROFILE) logger.printTimings();
			process.exit(0);
		}
	}
	mark("timeout");
	process.exit(1);
}
