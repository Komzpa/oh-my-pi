import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { nativeWorkspace, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];
/** Order of worktree captures and the run's IRC wake release. */
let events: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	events = [];
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Do work",
		assignment: "Do work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

/**
 * Runs a kept-alive branch-mode isolated agent whose workspace delta is
 * `runEndPatch` when it finishes and `releasePatch` when it is released, and
 * returns how many times a task branch was committed.
 */
async function commitsAcrossRelease(
	id: string,
	runEndPatch: string,
	releasePatch: string,
	options: {
		cleanup?: () => Promise<void>;
		afterRun?: () => Promise<void>;
		failInitialCapture?: boolean;
		restartMarker?: "matching" | "other-workspace";
	} = {},
): Promise<number> {
	const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-"));
	tempRoots.push(artifactsDir);
	const workspace = path.join(artifactsDir, "isolation", "m");
	await fs.mkdir(workspace, { recursive: true });
	const taskFile = path.join(workspace, "task.txt");
	await Bun.write(taskFile, runEndPatch);
	const baseline = {
		root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	};
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: workspace,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(
		options.cleanup ??
			(async handle => {
				await fs.rm(handle.mergedDir, { recursive: true, force: true });
			}),
	);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: releasePatch, nestedPatches: [] });
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: runEndPatch, nestedPatches: [] };
	});
	if (options.failInitialCapture) {
		commitSpy.mockRejectedValueOnce(new Error("branch capture failed"));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementation(async () => ({
			rootPatch: await Bun.file(taskFile).text(),
			nestedPatches: [],
		}));
	}
	const session = {
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		releaseTaskResources: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id: options.id,
			displayName: options.id,
			kind: "sub",
			session,
			sessionFile: `/tmp/${options.id}.jsonl`,
			status: "running",
		});
		// A held peer message would wake a turn in the worktree once released.
		options.deferIrcWakeRelease?.(() => events.push("irc wakes released"));
		await executorModule.finalizeSubagentLifecycle({
			id: options.id,
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: 0,
			reviveSession: async () => session,
			onRelease: options.onRelease,
		});
		return result(options.id);
	});

	const runResult = await runIsolatedSubprocess({
		baseOptions: {
			cwd: "/repo",
			agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
			task: "Do work",
			index: 0,
			id,
		},
		context: { repoRoot: "/repo" },
		openWorkspace: nativeWorkspace(undefined),
		agentId: id,
		mergeMode: "branch",
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	if (options.failInitialCapture) {
		expect(runResult.error).toContain("branch capture failed");
		expect(await Bun.file(runResult.patchPath!).text()).toBe(runEndPatch);
		// A follow-up turn still uses the effectiveCwd that was adopted at run end.
		expect(await Bun.file(taskFile).exists()).toBe(true);
		await Bun.write(taskFile, releasePatch);
	}
	if (options.restartMarker) {
		await Bun.write(
			path.join(artifactsDir, `${id}.restart-isolation.json`),
			JSON.stringify({ id, cwd: options.restartMarker === "matching" ? workspace : `${workspace}-other` }),
		);
	}
	if (options.afterRun) await options.afterRun();
	else await AgentLifecycleManager.global().release(id);
	if (options.restartMarker === "matching") {
		expect(await Bun.file(taskFile).text()).toBe(runEndPatch);
		expect(worktreeModule.cleanupIsolation).not.toHaveBeenCalled();
	} else {
		expect(await Bun.file(taskFile).exists()).toBe(false);
	}
	if (options.failInitialCapture) {
		const finalPatch = runResult.patchPath;
		expect(finalPatch).toBeDefined();
		expect(await Bun.file(finalPatch!).text()).toBe(releasePatch);
		expect(worktreeModule.cleanupIsolation).toHaveBeenCalledWith(expect.objectContaining({ mergedDir: workspace }));
	}
	return commitSpy.mock.calls.length;
}

describe("isolated agent release", () => {
	const patch = "diff --git a/task.txt b/task.txt\n+work\n";

	it("preserves checkpointed work when aborted execution reaches finally", async () => {
		const id = "RestartAborted";
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-abort-"));
		tempRoots.push(artifactsDir);
		const workspace = path.join(artifactsDir, "workspace");
		const taskFile = path.join(workspace, "task.txt");
		await Bun.write(taskFile, "unfinished work");
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: workspace,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue({
			root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
			nested: [],
		});
		vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async handle => {
			await fs.rm(handle.mergedDir, { recursive: true, force: true });
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			await Bun.write(
				path.join(artifactsDir, `${id}.restart-isolation.json`),
				JSON.stringify({ id, cwd: workspace }),
			);
			throw new Error("restart abort");
		});
		const runResult = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id,
				keepAlive: false,
			},
			context: { repoRoot: "/repo" },
			openWorkspace: nativeWorkspace(undefined),
			agentId: id,
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
		});
		expect(runResult.error).toContain("restart abort");
		expect(await Bun.file(taskFile).text()).toBe("unfinished work");
		expect(worktreeModule.cleanupIsolation).not.toHaveBeenCalled();
	});

	it("keeps restart-checkpointed work at its original path without release capture", async () => {
		expect(
			await commitsAcrossRelease("RestartPreserved", patch, `${patch}+follow-up\n`, { restartMarker: "matching" }),
		).toBe(1);
	});

	it("cleans ordinary releases when a stale restart marker names another workspace", async () => {
		expect(await commitsAcrossRelease("RestartStale", patch, patch, { restartMarker: "other-workspace" })).toBe(1);
	});

	it("keeps a failed branch-capture workspace usable until release and captures follow-up work", async () => {
		expect(
			await commitsAcrossRelease("ReleaseCaptureFailure", patch, `${patch}+follow-up\n`, {
				failInitialCapture: true,
			}),
		).toBe(2);
	});

	it("does not re-commit a workspace that is unchanged since the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseUnchanged", patch, patch)).toBe(1);
	});

	it("commits follow-up work made after the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseChanged", patch, `${patch}+follow-up\n`)).toBe(2);
	});

	it("repairs a borrowed workspace package before starting the isolated worker", async () => {
		const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-workspace-link-"));
		tempRoots.push(fixtureRoot);
		const oldCheckout = path.join(fixtureRoot, "old");
		const currentCheckout = path.join(fixtureRoot, "current");
		const workerCheckout = path.join(fixtureRoot, "worker");
		const artifactsDir = path.join(fixtureRoot, "artifacts");
		const workspaceName = "@oh-my-pi/pi-ai";
		for (const [checkout, source] of [
			[oldCheckout, "old"],
			[currentCheckout, "current"],
		]) {
			await fs.mkdir(path.join(checkout, "packages", "ai"), { recursive: true });
			await fs.mkdir(path.join(checkout, "packages", "app"), { recursive: true });
			await fs.writeFile(path.join(checkout, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
			await fs.writeFile(
				path.join(checkout, "packages", "ai", "package.json"),
				JSON.stringify({ name: workspaceName, type: "module", exports: "./index.js" }),
			);
			await fs.writeFile(
				path.join(checkout, "packages", "ai", "index.js"),
				`export const source = ${JSON.stringify(source)}; export const singleton = {};\n`,
			);
			await fs.writeFile(
				path.join(checkout, "packages", "app", "resolve.mjs"),
				`import { source, singleton } from "${workspaceName}"; import { singleton as peer, nested } from "external";\nconsole.log(JSON.stringify({source,direct:singleton===peer,nested:singleton===nested}));\n`,
			);
		}
		const oldNodeModules = path.join(oldCheckout, "node_modules");
		await fs.mkdir(path.join(oldNodeModules, "@oh-my-pi"), { recursive: true });
		await fs.symlink(
			path.join(oldCheckout, "packages", "ai"),
			path.join(oldNodeModules, "@oh-my-pi", "pi-ai"),
			"dir",
		);
		await fs.mkdir(path.join(oldNodeModules, "external/node_modules/nested"), { recursive: true });
		for (const member of ["external", "external/node_modules/nested"]) {
			await fs.writeFile(
				path.join(oldNodeModules, member, "package.json"),
				JSON.stringify({ type: "module", exports: "./index.js" }),
			);
		}
		await fs.writeFile(
			path.join(oldNodeModules, "external/index.js"),
			`export { singleton } from "${workspaceName}"; export { singleton as nested } from "nested";`,
		);
		await fs.writeFile(
			path.join(oldNodeModules, "external/node_modules/nested/index.js"),
			`export { singleton } from "${workspaceName}";`,
		);
		await fs.symlink(oldNodeModules, path.join(currentCheckout, "node_modules"), "dir");
		await fs.cp(currentCheckout, workerCheckout, { recursive: true });
		await fs.mkdir(artifactsDir);

		const baseline = {
			root: {
				repoRoot: currentCheckout,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: workerCheckout,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		let observed: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const workerRoot = options.worktree;
			if (!workerRoot) throw new Error("isolated worker has no worktree");
			const entry = path.join(workerRoot, "packages", "app", "resolve.mjs");
			const child = Bun.spawn([process.execPath, "run", entry], {
				cwd: workerRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			console.error(`isolation consumer PID=${child.pid}`);
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			const exitCode = await child.exited;
			if (exitCode !== 0) throw new Error(stderr);
			observed = stdout.trim();
			return { ...result(options.id), output: observed };
		});

		const run = await runIsolatedSubprocess({
			baseOptions: {
				cwd: currentCheckout,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Resolve workspace dependencies",
				index: 0,
				id: "BorrowedWorkspace",
			},
			context: { repoRoot: currentCheckout },
			openWorkspace: nativeWorkspace(undefined),
			agentId: "BorrowedWorkspace",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => ({ ...result("BorrowedWorkspace"), exitCode: 1, error: String(error) }),
		});

		expect(run.exitCode).toBe(0);
		expect(JSON.parse(observed ?? "null")).toEqual({ source: "current", direct: true, nested: true });
	});

	it("lets held peer messages wake the agent only after the run-end branch is committed", async () => {
		await commitsAcrossRelease("ReleaseAfterCapture", patch, patch);
		expect(events).toEqual(["commit", "irc wakes released"]);
	});

	it("keeps a timed-out shutdown release alive until the sandbox is removed", async () => {
		const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "omp-signal-isolation-"));
		tempRoots.push(sandbox);
		const finishCleanup = Promise.withResolvers<void>();
		const registrations = vi.spyOn(postmortem, "register");
		await commitsAcrossRelease("ReleaseAfterDeadline", patch, patch, {
			cleanup: async () => {
				await finishCleanup.promise;
				await fs.rm(sandbox, { recursive: true });
			},
			afterRun: async () => {
				await AgentLifecycleManager.global().dispose(Date.now());
				expect(
					await fs.stat(sandbox).then(
						() => true,
						() => false,
					),
				).toBe(true);
				const signalRelease = registrations.mock.calls.find(
					([id]) => id === "isolation-release:ReleaseAfterDeadline",
				)?.[1];
				expect(signalRelease).toBeDefined();
				const awaitedCleanup = signalRelease?.(postmortem.Reason.SIGHUP);
				finishCleanup.resolve();
				await awaitedCleanup;
				expect(
					await fs.stat(sandbox).then(
						() => true,
						() => false,
					),
				).toBe(false);
			},
		});
	});

	it("surfaces a release-time commit failure with the retained workspace via the lifecycle release caller", async () => {
		const id = "ReleaseFailureSurfaces";
		const runEndPatch = patch;
		const releasePatch = `${patch}+follow-up\n`;
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-release-"));
		tempRoots.push(artifactsDir);
		const workspace = path.join(artifactsDir, "isolation", "m");
		await fs.mkdir(workspace, { recursive: true });
		const taskFile = path.join(workspace, "task.txt");
		await Bun.write(taskFile, runEndPatch);
		const baseline = {
			root: { repoRoot: "/repo", headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
			nested: [],
		};
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: workspace,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementation(async () => ({
			rootPatch: await Bun.file(taskFile).text(),
			nestedPatches: [],
		}));
		const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
			events.push("commit");
			return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: runEndPatch, nestedPatches: [] };
		});
		const session = {
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {},
		} as unknown as AgentSession;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				session,
				sessionFile: `/tmp/${options.id}.jsonl`,
				status: "running",
			});
			options.deferIrcWakeRelease?.(() => events.push("irc wakes released"));
			await executorModule.finalizeSubagentLifecycle({
				id: options.id,
				session,
				aborted: false,
				keepAlive: true,
				isolated: true,
				agentIdleTtlMs: 0,
				reviveSession: async () => session,
				onRelease: options.onRelease,
			});
			return result(options.id);
		});
		const runResult = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id,
			},
			context: { repoRoot: "/repo" },
			openWorkspace: nativeWorkspace(undefined),
			agentId: id,
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
		});
		expect(runResult.error).toBeUndefined();
		// Follow-up work after the run-end branch forces a second commit at release.
		await Bun.write(taskFile, releasePatch);
		commitSpy.mockRejectedValueOnce(new Error("release commit failed"));
		const releaseError: unknown = await AgentLifecycleManager.global()
			.release(id)
			.then(
				() => null,
				error => error,
			);
		expect(releaseError).toBeInstanceOf(Error);
		const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
		expect(message).toContain("release commit failed");
		expect(message).toContain("Isolation workspace retained at");
		const retainedDir = message.match(/Isolation workspace retained at (\S+)/)?.[1];
		expect(retainedDir).toBeDefined();
		expect(await Bun.file(path.join(retainedDir!, "task.txt")).text()).toBe(releasePatch);
		expect(AgentRegistry.global().get(id)).toBeUndefined();
	});
});
