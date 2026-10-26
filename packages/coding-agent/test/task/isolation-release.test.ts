import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const tempRoots: string[] = [];
/** Order of worktree captures and the run's IRC wake release. */
let events: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	events = [];
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
	failInitialCapture = false,
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
	vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: releasePatch, nestedPatches: [] });
	const commitSpy = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
		events.push("commit");
		return { branchName: `omp/task/${id}`, baseSha: "base", rootPatch: runEndPatch, nestedPatches: [] };
	});
	if (failInitialCapture) {
		commitSpy.mockRejectedValueOnce(new Error("branch capture failed"));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockImplementation(async () => ({
			rootPatch: await Bun.file(taskFile).text(),
			nestedPatches: [],
		}));
	}
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
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "branch",
		artifactsDir,
		buildFailureResult: error => ({ ...result(id), exitCode: 1, error: String(error) }),
	});
	if (failInitialCapture) {
		expect(runResult.error).toContain("branch capture failed");
		expect(await Bun.file(runResult.patchPath!).text()).toBe(runEndPatch);
		// A follow-up turn still uses the effectiveCwd that was adopted at run end.
		expect(await Bun.file(taskFile).exists()).toBe(true);
		await Bun.write(taskFile, releasePatch);
	}
	await AgentLifecycleManager.global().release(id);
	if (failInitialCapture) {
		const finalPatch = runResult.patchPath;
		expect(finalPatch).toBeDefined();
		expect(await Bun.file(finalPatch!).text()).toBe(releasePatch);
		expect(worktreeModule.cleanupIsolation).toHaveBeenCalledWith(expect.objectContaining({ mergedDir: workspace }));
	}
	return commitSpy.mock.calls.length;
}

describe("isolated agent release", () => {
	const patch = "diff --git a/task.txt b/task.txt\n+work\n";

	it("keeps a failed branch-capture workspace usable until release and captures follow-up work", async () => {
		expect(await commitsAcrossRelease("ReleaseCaptureFailure", patch, `${patch}+follow-up\n`, true)).toBe(2);
	});

	it("does not re-commit a workspace that is unchanged since the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseUnchanged", patch, patch)).toBe(1);
	});

	it("commits follow-up work made after the run-end branch", async () => {
		expect(await commitsAcrossRelease("ReleaseChanged", patch, `${patch}+follow-up\n`)).toBe(2);
	});

	it("lets held peer messages wake the agent only after the run-end branch is committed", async () => {
		await commitsAcrossRelease("ReleaseAfterCapture", patch, patch);
		expect(events).toEqual(["commit", "irc wakes released"]);
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
			preferredBackend: undefined,
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
