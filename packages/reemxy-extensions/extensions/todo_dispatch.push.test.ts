// @ts-nocheck -- copied Reemxy extension runtime is covered by package behavior tests.
import { expect, test, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	sessionContextEntryMetadata,
	type SessionContextEntryMetadata,
} from "@oh-my-pi/pi-coding-agent/session/branch-selection";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { formatPlanForecast, formatTaskForecast, forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import todoDispatch, { DELIVERY_CHECKPOINT_MS, readGitIntegrationState, SPRINT_STATE_ENTRY_TYPE } from "./todo_dispatch";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as childProcess from "node:child_process";

const sdk = {
	forecastTodoPlan,
	formatPlanForecast,
	formatTaskForecast,
	getLatestTodoPhasesFromEntries,
	agentPauseGate,
};

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
	execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
}

test("fixed wall-clock checkpoints interrupt zero-commit work and reset on observed artifacts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "delivery-checkpoint-"));
	const realNow = Date.now();
	let now = realNow;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		const remote = join(dir, "remote.git");
		const work = join(dir, "work");
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		writeFileSync(join(work, "base"), "base");
		git(work, id, "add", "base");
		git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "push", "-q", "-u", "origin", "HEAD");
		expect((await readGitIntegrationState(work, now))?.unpushed).toBe(0);

		let phases = [{ name: "Delivery", tasks: [{
			content: "Build the smallest shippable slice",
			status: "in_progress",
			schedule: { owner: "BuildSlice", resources: [`checkout:${work}`] },
		}] }];
		const branch: unknown[] = [{
			type: "custom",
			customType: SPRINT_STATE_ENTRY_TYPE,
			data: { version: 1, goalWorkStartedAt: realNow - 3 * 24 * 60 * 60_000 },
		}];
		branch.push({ type: "custom", customType: "reemxy-goal-deadlines", data: {
			version: 1, goalId: "overdue", goalStartedAt: Math.floor(realNow / 1000) - 7200,
			timezone: "UTC", active: true, stages: [], baselineDeadlineAt: Math.floor(realNow / 1000) - 60,
			userConstraint: { messageId: "u1", quote: "deliver by then", recordedAt: Math.floor(realNow / 1000) - 7200 },
		} });
		const notices: unknown[] = [];
		const steering: Array<{ id: string; content: string }> = [];
		let deliverySucceeds = true;
		let running: unknown[] = [];
		const statuses = new Map<string, string | undefined>();
		let tick;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let provider: ((ctx: ExtensionContext) => unknown) | undefined;
		await todoDispatch({
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
			pi: { ...sdk, readGoalDeadline: () => undefined },
			registerSoftToolRequirementProvider: (
				p: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown },
			) => { provider = p.demand ?? p; },
			appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
			sendMessage: (message) => notices.push(message),
		} as unknown as ExtensionAPI);
		const ctx = {
			cwd: work,
			ui: { setStatus: (key, value) => statuses.set(key, value) },
			getTodoSnapshot: () => phases,
			sessionManager: {
				getHeader: () => ({ id: "checkpoint-root" }),
				getBranch: () => branch,
				getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) =>
					branch.filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
				getLatestBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) =>
					branch.filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))).at(-1),
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({ running, recent: [], nonJobAgents: [] }),
			sendAgentMessage: async (id, content) => { steering.push({ id, content }); return { delivered: deliverySucceeds }; },
			getTaskMaxConcurrency: () => 4,
			isIdle: () => false,
			hasPendingMessages: () => false,
			setInterval: (handler) => { tick = handler; return {}; },
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		AgentRegistry.global().register({ id: "checkpoint-fixture", kind: "main", session: {
			sessionManager: ctx.sessionManager,
			commitTodoPhases: (next) => { phases = next; },
		} });
		try {
			await handlers.get("session_start")!({}, ctx);
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).not.toContain("DELIVERY CHECKPOINT");

			// Forecast edits cannot move the persisted wall-clock observation.
			phases[0].tasks[0].schedule.estimate = {
				optimisticSeconds: 60,
				likelySeconds: 60 * 60,
				pessimisticSeconds: 3 * 24 * 60 * 60,
				confidence: "low",
				basis: "model changed its promise",
				updatedAt: now + DELIVERY_CHECKPOINT_MS,
			};
			now += DELIVERY_CHECKPOINT_MS;
			running = [{ id: "build-job", agentId: "BuildSlice", type: "task", status: "running" }];
			await tick();
			await Promise.resolve();
			expect(steering).toHaveLength(1);
			expect(steering[0].id).toBe("BuildSlice");
			expect(steering[0].content).toContain("smallest");
			await tick();
			await Promise.resolve();
			expect(steering).toHaveLength(1);
			running = [];
			const first = JSON.stringify(provider?.(ctx) ?? {});
			expect(first).toContain("DELIVERY CHECKPOINT");
			expect(first).toContain("fixed 15-minute wall-clock interval");
			expect(first).toContain("ETA/PERT");
			expect(first).toContain("narrow the method immediately");
			expect(phases.flatMap(phase => phase.tasks)).toHaveLength(1);
			expect(JSON.stringify(phases)).not.toMatch(/retro|audit|quality assurance/i);
			await Promise.resolve();
			const persisted = branch.filter(entry =>
				typeof entry === "object" && entry !== null && "customType" in entry && entry.customType === SPRINT_STATE_ENTRY_TYPE
			).at(-1) as { data?: { deliveryCheckpointHead?: string; deliveryCheckpointAt?: number; deliveryCheckpointActive?: boolean } } | undefined;
			expect(persisted?.data).toMatchObject({ deliveryCheckpointActive: true, deliveryCheckpointAt: realNow });
			expect(persisted?.data?.deliveryCheckpointHead).toBeTruthy();

			now += DELIVERY_CHECKPOINT_MS;
			phases[0].tasks.push({ content: "Concurrent writer", status: "in_progress", schedule: { owner: "OtherWriter", resources: [`checkout:${work}`] } });
			running = [
				{ id: "build-job", agentId: "BuildSlice", type: "task", status: "running" },
				{ id: "other-job", agentId: "OtherWriter", type: "task", status: "running" },
			];
			await tick();
			expect(steering).toHaveLength(1);
			phases[0].tasks.pop();
			// Executor identity and attempt-suffixed job IDs are also valid ownership records.
			Object.assign(phases[0].tasks[0].schedule, { owner: undefined, executor: { workerId: "BuildSlice" } });
			running = [{ id: "BuildSlice-2", type: "task", status: "running" }];
			deliverySucceeds = false;
			await tick();
			await Promise.resolve();
			await Promise.resolve();
			expect(steering).toHaveLength(2);
			expect(steering[1].id).toBe("BuildSlice-2");
			expect(JSON.stringify(notices)).toContain("todo-worker-message-undelivered");
			deliverySucceeds = true;
			await tick();
			expect(steering).toHaveLength(2);
			now += 30_000;
			await tick();
			await Promise.resolve();
			await Promise.resolve();
			expect(steering).toHaveLength(3);
			await tick();
			expect(steering).toHaveLength(3);
			running = [];
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			const second = JSON.stringify(provider?.(ctx) ?? {});
			expect(second).toContain("SECOND CONSECUTIVE ARTIFACT-FREE CHECKPOINT");
			expect(second).toContain("stop/release");
			expect(second).toContain("split/reassign");
			expect(second).toContain("smallest shippable slice");

			writeFileSync(join(work, "slice"), "checkpoint");
			git(work, id, "add", "slice");
			git(work, id, "commit", "-q", "-m", "checkpoint slice");
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).toContain("not confirmed on origin/");
			const pushRow = phases.flatMap(phase => phase.tasks).find(row => row.content.startsWith("Push: run project gates and push origin/"));
			expect(pushRow).toBeDefined();
			expect(pushRow.schedule.estimate.basis).toContain("only if authorized");
			expect(statuses.get("todo-delivery-checkpoint")).toContain("publication unconfirmed");
			expect(statuses.get("todo-delivery-checkpoint")).not.toContain("without new HEAD");
			git(work, id, "remote", "set-url", "origin", join(dir, "missing.git"));
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).toContain("cannot verify");
			expect(statuses.get("todo-delivery-checkpoint")).toContain("publication unknown");
			expect(pushRow.status).toBe("pending");
			git(work, id, "remote", "set-url", "origin", remote);
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			// No authorization is in this session: neither a row nor a reminder may push by itself.
			const target = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
			const remoteHead = () => execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${target}`], { encoding: "utf8" }).trim();
			const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: work, encoding: "utf8" }).trim();
			expect(remoteHead()).toBe(base);
			await tick();
			expect(remoteHead()).toBe(base);
			expect(JSON.stringify(provider?.(ctx))).toContain("only if authorized");

			// A checkpoint must not dispatch a second owner into an occupied checkout.
			const slice = phases.flatMap(phase => phase.tasks).find(row => row.content === "Build the smallest shippable slice");
			slice.schedule.owner = "LandActiveSlice";
			ctx.getAsyncJobSnapshot = () => ({ running: [{ id: "LandActiveSlice", agentId: "LandActiveSlice", type: "task", status: "running", agentProfile: "git-pr-owner", label: slice.content }], recent: [], nonJobAgents: [] });
			const conflict = await handlers.get("tool_call")!({ toolName: "task", input: { tasks: [{ name: "PublishSlice", agent: "git-pr-owner", task: `Publish slice in ${work}`, cwd: work }] } }, ctx);
			expect(conflict?.block).toBe(true);
			expect(conflict?.reason).toContain("already has live git-pr-owner");
			const other = join(dir, "independent");
			const independent = await handlers.get("tool_call")!({ toolName: "task", input: { tasks: [{ name: "PublishOtherSlice", agent: "git-pr-owner", task: `Publish slice in ${other}`, cwd: other }] } }, ctx);
			expect(independent?.block).not.toBe(true);
			ctx.getAsyncJobSnapshot = () => ({ running: [], recent: [], nonJobAgents: [] });

			now += DELIVERY_CHECKPOINT_MS / 2;
			git(work, id, "push", "-q", "origin", "HEAD");
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			now += DELIVERY_CHECKPOINT_MS / 2;
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).not.toMatch(/DELIVERY CHECKPOINT|ARTIFACT-FREE CHECKPOINT/);

			// A slice committed while origin is unavailable can still be published by
			// another worker; once the target is readable again, delivery resets the clock.
			now += DELIVERY_CHECKPOINT_MS / 2;
			git(work, id, "remote", "set-url", "origin", join(dir, "missing.git"));
			writeFileSync(join(work, "second-slice"), "second checkpoint");
			git(work, id, "add", "second-slice");
			git(work, id, "commit", "-q", "-m", "second checkpoint");
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).toContain("cannot verify");
			git(work, id, "push", "-q", remote, `HEAD:refs/heads/${target}`);
			git(work, id, "remote", "set-url", "origin", remote);
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).not.toMatch(/DELIVERY CHECKPOINT|ARTIFACT-FREE CHECKPOINT/);

			// A read-only audit may inspect this checkout, but it is not delivery work and cannot start the artifact clock.
			phases.flatMap(phase => phase.tasks).find(row => row.content === "Build the smallest shippable slice").schedule.readOnly = true;
			now += DELIVERY_CHECKPOINT_MS * 2;
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(JSON.stringify(provider?.(ctx) ?? {})).not.toMatch(/DELIVERY CHECKPOINT|ARTIFACT-FREE CHECKPOINT/);
		} finally {
			handlers.get("session_shutdown")?.({}, ctx);
			AgentRegistry.global().unregister("checkpoint-fixture");
		}
	} finally {
		clock.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

// A lead must see a publication obligation without a goal or a fresh fetch.
test("live heads create one notice and priority push row, then a worker push clears both without fetch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "push-demand-"));
	try {
		const remote = join(dir, "remote.git");
		const work = join(dir, "work");
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		writeFileSync(join(work, "a"), "a");
		git(work, id, "add", "a");
		git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "push", "-q", "-u", "origin", "HEAD");
		writeFileSync(join(work, "b"), "b");
		git(work, id, "add", "b");
		const old = new Date(Date.now() - 80 * 60_000).toISOString();
		git(work, { ...id, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old }, "commit", "-q", "-m", "local fix");

		let phases = [];
		const notices = [];
		const statuses = [];
		let tick;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let provider: ((ctx: ExtensionContext) => unknown) | undefined;
		await todoDispatch({
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				handlers.set(event, handler),
			getActiveTools: () => ["task", "todo", "bash", "read", "wait"],
			pi: { ...sdk, readGoalDeadline: () => undefined },
			registerSoftToolRequirementProvider: (
				p: ((ctx: ExtensionContext) => unknown) & { demand?: (ctx: ExtensionContext) => unknown },
			) => {
				provider = p.demand ?? p;
			},
			appendEntry: () => undefined,
			sendMessage: (message) => notices.push(message),
		} as unknown as ExtensionAPI);
		const branch: unknown[] = [];
		const ctx = {
			cwd: work,
			ui: { setStatus: (_key, value) => statuses.push(value) },
			getTodoSnapshot: () => phases,
			sessionManager: {
				getHeader: () => ({ id: "push-root" }),
				getBranch: () => branch,
				getBranchMatching: (predicate: (entry: SessionContextEntryMetadata) => boolean) =>
					branch.filter(entry => predicate(sessionContextEntryMetadata(entry as SessionEntry))),
				getLatestBranchMatching: () => undefined,
				getSessionFile: () => undefined,
			},
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 4,
			isIdle: () => false,
			hasPendingMessages: () => false,
			setInterval: (handler) => { tick = handler; return {}; },
			setTimeout: () => ({}),
			clearTimer: () => undefined,
		} as unknown as ExtensionContext;
		AgentRegistry.global().register({ id: "push-fixture", kind: "main", session: {
			sessionManager: ctx.sessionManager,
			commitTodoPhases: (next) => { phases = next; },
		} });
		const sync = spyOn(childProcess, "spawnSync").mockImplementation(() => { throw new Error("sync git on main thread"); });
		try {
			await handlers.get("session_start")!({}, ctx);
			await tick();
			expect(phases).toEqual([]);
			expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(0);
			expect(provider?.(ctx)?.reminder?.some(message => message.content.includes("UNPUSHED WORK")) ?? false).toBe(false);
			const probe = await handlers.get("tool_call")!({ toolName: "task", input: { tasks: [{ name: "SpawnProbe", agent: "task", task: "Read only: report model and effort. Do nothing else." }] } }, ctx);
			expect(probe?.block).not.toBe(true);
			// The neighbouring lead owns an explicit checkout row; its push obligation remains.
			phases = [{ name: "DC lead", tasks: [{ content: "Implement branch work", status: "completed", schedule: { resources: [`checkout:${work}`] } }] }];
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			await handlers.get("context")!({ messages: [] }, ctx);
			await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
			expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(1);
			expect(phases.flatMap(phase => phase.tasks)).toHaveLength(2);
			expect(phases[0].tasks[0].content).toContain("project gates and push origin/");
			expect(phases[0].tasks[0].status).toBe("pending");
			expect(statuses.at(-1)).toMatch(/1 unpushed · oldest 80m/);
		} finally { sync.mockRestore(); }
		// Live chief shape: three unstaffed own rows, overdue publication, refused spawn.
		const readyRows = ["Cooling trunks", "Power source", "Render frame"].map(content => ({ content, status: "pending", schedule: { dependencies: [] } }));
		phases[0].tasks.push(...readyRows);
		const refused = await handlers.get("tool_result")!({ toolName: "task", input: {}, isError: true, content: [{ type: "text", text: "refused: staff existing rows first" }] }, ctx);
		// Publication remains in todo state; tool results no longer carry chief prose.
		expect(refused).toBeUndefined();
		for (const row of readyRows) {
			row.status = "completed";
			const result = await handlers.get("tool_result")!({ toolName: "read", input: {}, content: [{ type: "text", text: "receipt" }] }, ctx);
			expect(result?.content?.at(-1)?.text ?? "receipt").toBe("receipt");
			expect(phases[0].tasks[0].status).toBe("pending");
		}
		await handlers.get("tool_result")!({ toolName: "task", input: {}, isError: false, content: [{ type: "text", text: "staffed" }] }, ctx);
		const worker = join(dir, "worker");
		git(work, id, "worktree", "add", "--detach", worker, "HEAD");
		git(worker, id, "-c", "remote.origin.fetch=", "push", "-q", "origin", "HEAD:refs/heads/worker-published");
		// A different branch cannot prove the selected delivery branch was pushed.
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBe(1);
		const branchName = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
		git(worker, id, "push", "-q", "origin", `HEAD:refs/heads/${branchName}`);
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		const cleared = await handlers.get("tool_result")!({ toolName: "read", input: {}, content: [{ type: "text", text: "receipt" }] }, ctx);
		expect(cleared?.content?.at(-1)?.text ?? "").not.toContain("FIX NOW:");
		expect(phases[0].tasks[0].status).toBe("completed");
		expect(statuses.at(-1)).toBeUndefined();
		expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(1);
		git(work, id, "config", "omp.unpushedThresholdMinutes", "120");
		git(work, id, "--git-dir", remote, "update-ref", "-d", "refs/heads/worker-published");
		git(work, id, "--git-dir", remote, "update-ref", `refs/heads/${branchName}`, "HEAD~1");
		const below = await readGitIntegrationState(work, Date.now());
		expect(below?.unpushed).toBe(1);
		expect(below?.pushThresholdMs).toBe(120 * 60_000);
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(phases[0].tasks[0].status).toBe("completed");
		git(work, id, "config", "omp.unpushedThresholdMinutes", "15");
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(notices.filter(message => message.customType === "todo-unpushed")).toHaveLength(2);
		expect(phases.flatMap(phase => phase.tasks)).toHaveLength(5);
		expect(phases[0].tasks[0].status).toBe("pending");
		git(work, id, "remote", "set-url", "origin", join(dir, "missing.git"));
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		expect(phases[0].tasks[0].status).toBe("pending");
		git(work, id, "remote", "set-url", "origin", remote);
		await handlers.get("tool_result")!({ toolName: "todo", isError: false }, ctx);
		const demand = provider?.(ctx) as { reminder?: Array<{ content: string }> } | undefined;
		expect(demand?.reminder?.[0]?.content ?? "").toContain("UNPUSHED WORK: 1 commit(s)");
		handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		AgentRegistry.global().unregister("push-fixture");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("publication is confirmed only on the selected remote branch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "checkpoint-target-"));
	try {
		const remote = join(dir, "remote.git"), work = join(dir, "work");
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		writeFileSync(join(work, "base"), "base");
		git(work, id, "add", "base"); git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "config", "omp.pushBranch", "delivery");
		git(work, id, "push", "-q", "origin", "HEAD:refs/heads/delivery");
		writeFileSync(join(work, "next"), "next");
		git(work, id, "add", "next"); git(work, id, "commit", "-q", "-m", "next");
		git(work, id, "push", "-q", "origin", "HEAD:refs/heads/unrelated");
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBe(1);
		git(work, id, "push", "-q", "origin", "HEAD:refs/heads/delivery");
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBe(0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a deleted target ref does not count the entire history as unpushed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "checkpoint-deleted-target-"));
	try {
		const remote = join(dir, "remote.git"), work = join(dir, "work");
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		writeFileSync(join(work, "base"), "base");
		git(work, id, "add", "base"); git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "config", "omp.pushBranch", "delivery");
		git(work, id, "push", "-q", "origin", "HEAD:refs/heads/delivery");
		git(work, id, "--git-dir", remote, "update-ref", "-d", "refs/heads/delivery");
		const state = await readGitIntegrationState(work, Date.now());
		expect(state?.unpushed).toBeUndefined();
		expect(state?.pushTargetMissing).toBe(true);
		expect(state?.pushBranch).toBe("delivery");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("target descendant confirms inclusion, not exact HEAD identity", async () => {
	const dir = mkdtempSync(join(tmpdir(), "checkpoint-descendant-"));
	try {
		const remote = join(dir, "remote.git"), work = join(dir, "work"), other = join(dir, "other");
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		writeFileSync(join(work, "base"), "base");
		git(work, id, "add", "base"); git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "config", "omp.pushBranch", "delivery");
		git(work, id, "worktree", "add", "--detach", other, "HEAD");
		writeFileSync(join(other, "next"), "next");
		git(other, id, "add", "next"); git(other, id, "commit", "-q", "-m", "next");
		git(other, id, "push", "-q", "origin", "HEAD:refs/heads/delivery");
		const localHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
		const remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/delivery"], { encoding: "utf8" }).trim();
		expect(remoteHead).not.toBe(localHead);
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBe(0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a remote tip absent from the local object database leaves publication unknown until fetched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "checkpoint-unknown-tip-"));
	try {
		const remote = join(dir, "remote.git"), work = join(dir, "work"), other = join(dir, "other");
		const id = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
		writeFileSync(join(work, "base"), "base");
		git(work, id, "add", "base"); git(work, id, "commit", "-q", "-m", "base");
		git(work, id, "config", "omp.pushBranch", "delivery");
		git(work, id, "push", "-q", "origin", "HEAD:refs/heads/delivery");
		execFileSync("git", ["clone", "-q", "--branch", "delivery", remote, other], { stdio: "ignore" });
		writeFileSync(join(other, "next"), "next");
		git(other, id, "add", "next"); git(other, id, "commit", "-q", "-m", "next");
		git(other, id, "push", "-q", "origin", "HEAD:refs/heads/delivery");
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBeUndefined();
		git(work, id, "fetch", "-q", "origin", "refs/heads/delivery");
		expect((await readGitIntegrationState(work, Date.now()))?.unpushed).toBe(0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
