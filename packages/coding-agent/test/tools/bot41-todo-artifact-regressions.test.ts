import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { ptree } from "@oh-my-pi/pi-utils";
import { useFastGitStatusCoordinator } from "../helpers/fast-status-coordinator";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import {
	appendRequirementsSnapshot,
	countRequirements,
	createRequirementCandidates,
	getLatestRequirements,
} from "../../src/tools/requirements-ledger";

import {
	bindRequirementRowArtifact,
	getLatestTodoPhasesFromEntries,
	getRequirementRowArtifact,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../src/tools/todo";
import { formatRequirementIdentity } from "../../src/utils/requirement-artifact";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

useFastGitStatusCoordinator();

function makeRepo(root: string, commit = true): void {
	mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "--initial-branch=main"], { cwd: root });
	writeFileSync(join(root, "artifact.txt"), "current artifact\n");
	writeFileSync(join(root, "neighbor.txt"), "neighbor artifact\n");
	if (!commit) return;
	execFileSync("git", ["add", "artifact.txt", "neighbor.txt"], { cwd: root });
	execFileSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"],
		{ cwd: root },
	);
}

function phasesFor(row: string, task: Record<string, unknown>): TodoPhase[] {
	return [{ name: "Plan", tasks: [{ content: row, status: "pending", ...task } as never] }];
}

describe("PR 41 todo artifact regressions", () => {
	it("uses an active owner's execution checkout before its prior binding, while keeping unmatched owners pinned", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-execution-cwd-"));
		try {
			const old = join(root, "old");
			const current = join(root, "current");
			makeRepo(old);
			makeRepo(current);
			const row = "Worker result";
			const owner = `bot41-${Date.now()}`;
			const phases = phasesFor(row, {
				artifactCwd: old,
				artifactOwner: owner,
				schedule: { owner },
			});
			const result = await getRequirementRowArtifact(
				{ cwd: root, executionCheckout: { owner, cwd: current } },
				row,
				phases,
			);
			expect(result.cwd).toBe(current);
			expect(result.head).toBe(
				execFileSync("git", ["rev-parse", "HEAD"], { cwd: current, encoding: "utf8" }).trim(),
			);

			const other = await getRequirementRowArtifact(
				{ cwd: root, executionCheckout: { owner: `${owner}-other`, cwd: current } },
				row,
				phases,
			);
			expect(other.cwd).toBe(old);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a receipt that narrows a whole-checkout declaration to selected paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-receipt-scope-"));
		try {
			makeRepo(root);
			const row = "Build whole checkout";
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
			const receipt = `row ${JSON.stringify(row)} @ ${formatRequirementIdentity({
				kind: "git",
				repo: root,
				commit: head,
				paths: ["artifact.txt"],
			})}`;
			const result = await getRequirementRowArtifact(
				{ cwd: root, receipt },
				row,
				phasesFor(row, { schedule: { resources: [root] } }),
			);
			expect(result.identityCheck?.reason).toContain("paths do not match the declared scope");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects duplicate canonical resource declarations before they can become receipt targets", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-duplicate-resource-"));
		try {
			const resource = join(root, "missing.txt");
			const row = "Read the explicit resource";
			const result = await getRequirementRowArtifact(
				{ cwd: root },
				row,
				phasesFor(row, { schedule: { resources: [resource, join(root, ".", "missing.txt")] } }),
			);
			expect(result.reason).toContain("duplicate canonical resource");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains declared service version through receipt-free artifact dispatch", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-service-target-"));
		let commandProbe: { mockRestore(): void } | undefined;
		const home = fs
			.readFileSync(`/proc/${process.pid}/environ`)
			.toString()
			.split("\0")
			.find(entry => entry.startsWith("HOME="))
			?.slice(5);
		if (!home) throw new Error("Expected fixture process HOME identity");
		try {
			const systemctl = join(root, "systemctl");
			writeFileSync(
				systemctl,
				`#!/bin/sh\nprintf 'MainPID=${process.pid}\\nInvocationID=fixture-invocation\\nActiveState=active\\n'\n`,
				{ mode: 0o755 },
			);
			const spawn = ptree.spawn;
			commandProbe = spyOn(ptree, "spawn").mockImplementation((command, options) =>
				spawn(command[0] === "systemctl" ? [systemctl, ...command.slice(1)] : command, options),
			);
			const row = "Audit running service";
			const deployment = `deploy:fixture.service@${JSON.stringify(home)} scope=user env=HOME`;
			const result = await getRequirementRowArtifact({ cwd: root }, row, phasesFor(row, { deployment }));
			expect(result.reason ?? "").toBe("");
			expect(result.identities).toEqual([
				{ kind: "deploy", target: "fixture.service", value: home, scope: "user", env: "HOME" },
			]);
			const mismatch = await getRequirementRowArtifact(
				{ cwd: root },
				row,
				phasesFor(row, { deployment: deployment.replace(JSON.stringify(home), "not-the-running-version") }),
			);
			expect(mismatch.identities).toBeUndefined();
			expect(mismatch.reason).toContain("does not match the declared deployment version");
		} finally {
			commandProbe?.mockRestore();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the declared deployment version as a gate on observed and receipted versions", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ version: "v2" }) });
		const previousTrusted = process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
		process.env.OMP_TRUSTED_DEPLOYMENT_URLS = JSON.stringify([`${server.url}version`]);
		try {
			const row = "Verify deployment";
			const deployment = `deploy:${server.url}version@v1 field=version`;
			const phases = phasesFor(row, { deployment });
			const current = await getRequirementRowArtifact({ cwd: "/tmp" }, row, phases);
			expect(current.reason).toContain('currently reports "v2" but row declares "v1"');

			const receipt = `row ${JSON.stringify(row)} @ deploy:${server.url}version@v2 field=version`;
			const checked = await getRequirementRowArtifact({ cwd: "/tmp", receipt }, row, phases);
			expect(checked.identityCheck?.reason).toContain('does not match declared value "v1"');
		} finally {
			if (previousTrusted === undefined) delete process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
			else process.env.OMP_TRUSTED_DEPLOYMENT_URLS = previousTrusted;
			server.stop(true);
		}
	});

	it("persists an exact owner checkout even before the checkout has a commit", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-headless-binding-"));
		try {
			const worker = join(root, "worker");
			makeRepo(worker, false);
			const owner = `bot41-headless-${Date.now()}`;
			const row = "Worker ran without a commit";
			const phases = phasesFor(row, { schedule: { owner } });
			const manager = SessionManager.inMemory();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			let tracker: TodoPhase[] | undefined;
			const result = await bindRequirementRowArtifact(
				{
					cwd: root,
					sessionManager: manager,
					executionCheckout: { owner, cwd: worker },
					setTodoPhases: value => (tracker = value),
				},
				row,
				phases,
				{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
			);
			expect(result.cwd).toBe(worker);
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]).toMatchObject({
				artifactCwd: worker,
				artifactOwner: owner,
			});
			expect(tracker?.[0]?.tasks[0]).toMatchObject({ artifactCwd: worker, artifactOwner: owner });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not bind a checkout after the TODO owner changes during artifact lookup", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-owner-race-"));
		try {
			makeRepo(root);
			const owner = `bot41-owner-race-${Date.now()}`;
			const row = "Keep the checkout bound to its owner";
			const original = phasesFor(row, { schedule: { owner } });
			const manager = SessionManager.inMemory();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: original });
			const binding = bindRequirementRowArtifact(
				{ cwd: root, sessionManager: manager, executionCheckout: { owner, cwd: root } },
				row,
				original,
				{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
			);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: phasesFor(row, { schedule: { owner: `${owner}-reassigned` } }),
			});
			const result = await binding;
			expect(result.reason).toBeDefined();
			expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]?.tasks[0]).not.toHaveProperty("artifactCwd");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("merges canonical artifact bindings into a lagging tracker before a native append", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-tracker-binding-"));
		try {
			const row = "Keep worker provenance";
			const canonical = phasesFor(row, {
				artifactCwd: root,
				artifactOwner: "worker-a",
				schedule: { owner: "worker-a" },
			});
			const manager = SessionManager.inMemory();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: canonical });
			let tracker = phasesFor(row, { schedule: { owner: "worker-a" } });
			const session: ToolSession = {
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated(),
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => tracker,
				setTodoPhases: phases => (tracker = phases),
			};
			const result = await new TodoTool(session).execute("append", {
				op: "append",
				phase: "Plan",
				items: ["A neighboring task"],
			} as never);
			expect(result.isError).toBeUndefined();
			expect(tracker[0]?.tasks[0]).toMatchObject({ artifactCwd: root, artifactOwner: "worker-a" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("retains a pending owner check when init keeps its linked row", async () => {
		const manager = SessionManager.inMemory();
		const row = "Inspect saved artifact";
		let tracker = phasesFor(row, {
			status: "blocked",
			blocker: "Check it",
			awaitingUser: { action: "Check it", ids: ["card-1"] },
		});
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: tracker });
		appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
			{ ...createRequirementCandidates([], ["Inspect artifact"])[0]!, classification: "linked", rows: [row] },
		]);
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			getTodoPhases: () => tracker,
			setTodoPhases: phases => (tracker = phases),
		};
		const tool = new TodoTool(session);
		const result = await tool.execute("init", { op: "init", items: [row, "New unrelated row"] } as never);
		expect(result.isError).toBeUndefined();
		expect(tracker.flatMap(phase => phase.tasks).find(task => task.content === row)).toMatchObject({
			status: "blocked",
			blocker: "Check it",
			awaitingUser: { action: "Check it", ids: ["card-1"] },
		});
		expect(tracker.flatMap(phase => phase.tasks).find(task => task.content === "New unrelated row")?.status).toBe(
			"in_progress",
		);
		expect((await tool.execute("done", { op: "done", task: row } as never)).isError).toBe(true);
	});

	it("composes the model-facing todo guidance from static prompt files", () => {
		const session = { cwd: "/tmp" } as ToolSession;
		const tool = new TodoTool(session);
		expect(tool.description).toContain('op="classify"');
		expect(tool.description).toContain("Requirement audits use the exact assigned IDs");
		expect(tool.description).toContain("todo` NEVER takes a turn of its own");
	});

	it("refuses to link a requirement to duplicate task text that artifact lookup cannot resolve", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("requirements_ledger", {
			version: 1,
			requirements: [
				{
					id: "R41",
					at: "2026-10-25T00:00:00.000Z",
					rawText: "Build a thing",
					classification: "candidate",
					rows: [],
				},
			],
		});
		const row = "Build a thing";
		const duplicated = phasesFor(row, {});
		duplicated[0]!.tasks.push({ content: row, status: "pending" } as never);
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			getTodoPhases: () => duplicated,
		};
		const result = await new TodoTool(session).execute("duplicate-row", {
			op: "classify",
			id: "R41",
			classification: "linked",
			rows: [row],
		} as never);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("duplicate TODO row");
	});

	it("persists stale pass invalidation after refusing done so the requirements HUD counts it as open", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-stale-verdict-"));
		try {
			makeRepo(root);
			const row = "Rebuild artifact";
			const neighborRow = "Inspect neighbor";
			const artifactPath = join(root, "artifact.txt");
			const neighborPath = join(root, "neighbor.txt");
			const rawText = "Rebuild and inspect the artifacts";
			const receivedAt = "2026-10-25T00:00:00.000Z";
			const pass = (path: string, bytes: string) => ({
				status: "pass" as const,
				evidence: "Audited the exact file contents",
				artifact: `row ${JSON.stringify(path === artifactPath ? row : neighborRow)} @ ${formatRequirementIdentity({
					kind: "file",
					path,
					sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
				})}`,
				workerId: "qa-run-1",
				auditor: "qa-auditor" as const,
				rawWords: rawText,
				receivedAt,
			});
			const manager = SessionManager.inMemory();
			const phases = phasesFor(row, { schedule: { resources: [artifactPath] } });
			phases[0]!.tasks.push({
				content: neighborRow,
				status: "pending",
				schedule: { resources: [neighborPath] },
			} as never);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const candidates = createRequirementCandidates([], [rawText], receivedAt);
			const requirement = {
				...candidates[0]!,
				classification: "linked" as const,
				rows: [row, neighborRow],
				rowVerdicts: {
					[row]: pass(artifactPath, "current artifact\n"),
					[neighborRow]: pass(neighborPath, "neighbor artifact\n"),
				},
			};
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				[requirement],
			);
			writeFileSync(artifactPath, "changed artifact\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd: root });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "change artifact"],
				{ cwd: root },
			);
			const session: ToolSession = {
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated(),
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: () => {},
			};
			const result = await new TodoTool(session).execute("stale-done", { op: "done", task: row } as never);
			expect(result.isError).toBe(true);
			const persisted = getLatestRequirements(manager.getBranch());
			expect(persisted[0]?.rowVerdicts?.[row]?.status).toBe("unverifiable");
			expect(persisted[0]?.rowVerdicts?.[neighborRow]?.status).toBe("pass");
			expect(countRequirements(persisted)).toEqual({ total: 1, passed: 0, failed: 0, open: 1 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses done when the requirements ledger changes during artifact lookup", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot41-todo-ledger-race-"));
		try {
			makeRepo(root);
			const row = "Verify concurrent receipt";
			const rawText = "Verify the artifact against the current ask";
			const artifactPath = join(root, "artifact.txt");
			const receivedAt = new Date().toISOString();
			const manager = SessionManager.inMemory();
			const phases = phasesFor(row, { schedule: { resources: [artifactPath] } });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const candidate = createRequirementCandidates([], [rawText], receivedAt)[0]!;
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				{
					...candidate,
					classification: "linked",
					rows: [row],
					rowVerdicts: {
						[row]: {
							status: "pass",
							evidence: "Audited the exact file contents",
							artifact: `row ${JSON.stringify(row)} @ ${formatRequirementIdentity({
								kind: "file",
								path: artifactPath,
								sha256: new Bun.CryptoHasher("sha256").update("current artifact\n").digest("hex"),
							})}`,
							workerId: "qa-run-1",
							auditor: "qa-auditor",
							rawWords: rawText,
							receivedAt,
						},
					},
				},
			]);
			const session: ToolSession = {
				cwd: root,
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated(),
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: () => {},
			};
			const completion = new TodoTool(session).execute("ledger-race", { op: "done", task: row } as never);
			const latest = getLatestRequirements(manager.getBranch());
			latest[0] = {
				...latest[0]!,
				rowVerdicts: {
					...latest[0]!.rowVerdicts,
					[row]: {
						status: "fail",
						evidence: "Concurrent auditor intake rejected this artifact",
						artifact: "rejected",
						workerId: "qa-run-2",
						rawWords: rawText,
						receivedAt: new Date().toISOString(),
					},
				},
			};
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, latest);
			const result = await completion;
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("Requirement evidence changed during the artifact check");
			expect(phases[0]?.tasks[0]?.status).toBe("pending");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
