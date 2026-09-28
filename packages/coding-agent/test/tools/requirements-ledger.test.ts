import * as ledgerReviewExports from "../../src/tools/requirements-ledger";
import { useFastGitStatusCoordinator } from "../helpers/fast-status-coordinator.js";
import * as reviewOs from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	bindRequirementRowArtifact,
	TodoTool,
	committedTodoPhases,
	getLatestTodoPhasesFromEntries,
	getRequirementRowArtifact,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	countRequirements,
	createRequirementCandidates,
	getLatestRequirements,
	getRequirementAuditSources,
	getRequirementRowArtifactIdentity,
	getRequirementVerdictStaleness,
	parseRequirementReceipt,
	parseRequirementReceiptIdentities,
	parseRequirementsLedger,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { formatRequirementIdentity } from "@oh-my-pi/pi-coding-agent/utils/requirement-artifact";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

// Runtime todo rows may carry scheduling metadata even though the shared TUI
// type intentionally describes only the native task fields.
type ScheduledTodoPhase = Omit<TodoPhase, "tasks"> & {
	tasks: Array<TodoPhase["tasks"][number] & { schedule?: { resources?: string[] } }>;
};

const AT = "2026-09-28T12:00:00.000Z";

describe("canonical todo row metadata", () => {
	it("retains main and worker owner/resources through the persisted phase reader", () => {
		const manager = SessionManager.inMemory();
		const phases = [
			{
				name: "Plan",
				tasks: [
					{
						content: "Main row",
						status: "pending",
						schedule: { owner: "main", resources: ["/tmp/main-checkout"], dependencies: [] },
					},
					{
						content: "Worker row",
						status: "in_progress",
						schedule: { owner: "BuildWorker", resources: ["/tmp/worker-checkout"], dependencies: ["Main row"] },
					},
				],
			},
		];
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
		const rows = persisted[0]!.tasks as Array<TodoPhase["tasks"][number] & { schedule: unknown }>;
		expect(rows.map(row => row.schedule)).toEqual([
			{ owner: "main", resources: ["/tmp/main-checkout"], dependencies: [] },
			{ owner: "BuildWorker", resources: ["/tmp/worker-checkout"], dependencies: ["Main row"] },
		]);
	});

	it("maps persisted main and worker rows to their own clean Git artifacts", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-requirement-rows-"));
		try {
			const main = join(root, "main");
			const worker = join(root, "worker");
			for (const cwd of [main, worker]) {
				mkdirSync(cwd);
				execFileSync("git", ["init", "--initial-branch=main"], { cwd });
				writeFileSync(join(cwd, "artifact.txt"), cwd);
				execFileSync("git", ["add", "artifact.txt"], { cwd });
				execFileSync(
					"git",
					["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
					{ cwd },
				);
			}
			const manager = SessionManager.inMemory();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Plan",
						tasks: [
							{ content: "Main row", status: "pending", schedule: { owner: "main", resources: [main] } },
							{
								content: "Worker row",
								status: "in_progress",
								schedule: { owner: "BuildWorker", resources: [worker] },
							},
						],
					},
				],
			});
			const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
			for (const [row, cwd] of [
				["Main row", main],
				["Worker row", worker],
			] as const) {
				const artifact = await getRequirementRowArtifact({ cwd: main }, row, persisted);
				const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
				expect(artifact).toEqual({
					cwd,
					dirty: false,
					head: null,
					identities: [{ kind: "git", repo: cwd, commit }],
				});
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("binds the resource HEAD when dispatch rewrites only the row owner", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-ledger-dispatch-owner-"));
		try {
			execFileSync("git", ["init", "--initial-branch=main"], { cwd });
			writeFileSync(join(cwd, "artifact.txt"), "audited\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "audited"],
				{ cwd },
			);
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			const manager = SessionManager.inMemory(cwd);
			const original = [
				{
					name: "Plan",
					tasks: [{ content: "Dispatch row", status: "pending", schedule: { owner: "main", resources: [cwd] } }],
				},
			] as unknown as TodoPhase[];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Plan",
						tasks: [
							{ content: "Dispatch row", status: "pending", schedule: { owner: "qa-worker", resources: [cwd] } },
						],
					},
				],
			});
			const bound = await bindRequirementRowArtifact({ cwd, sessionManager: manager }, "Dispatch row", original, {
				appendEntry: (type, data) => manager.appendCustomEntry(type, data),
			});
			expect(bound).toEqual({
				cwd,
				head: null,
				dirty: false,
				identities: [{ kind: "git", repo: cwd, commit: head }],
			});
			const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
			expect(persisted[0]?.tasks[0]?.artifactCwd).toBeUndefined();
			expect(persisted[0]?.tasks[0]).toMatchObject({ schedule: { owner: "qa-worker", resources: [cwd] } });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("uses declared resources instead of adding the registered owner's session cwd", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-ledger-resource-owner-"));
		const owner = `worker-${root.slice(root.lastIndexOf("/") + 1)}`;
		const registry = AgentRegistry.global();
		try {
			const resource = join(root, "resource");
			const sessionCwd = join(root, "session");
			for (const cwd of [resource, sessionCwd]) {
				mkdirSync(cwd);
				execFileSync("git", ["init", "--initial-branch=main"], { cwd });
				writeFileSync(join(cwd, "artifact.txt"), cwd);
				execFileSync("git", ["add", "artifact.txt"], { cwd });
				execFileSync(
					"git",
					["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
					{ cwd },
				);
			}
			registry.register({
				id: owner,
				displayName: owner,
				kind: "sub",
				status: "idle",
				session: { sessionManager: { getCwd: () => sessionCwd } } as never,
			});
			const phases: TodoPhase[] = [
				{
					name: "Plan",
					tasks: [
						{
							content: "Resource row",
							status: "in_progress",
							schedule: { owner, resources: [resource] },
						} as TodoPhase["tasks"][number],
					],
				},
			];
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resource, encoding: "utf8" }).trim();
			expect(await getRequirementRowArtifact({ cwd: sessionCwd }, "Resource row", phases)).toEqual({
				cwd: resource,
				head: null,
				dirty: false,
				identities: [{ kind: "git", repo: resource, commit: head }],
			});
		} finally {
			registry.unregister(owner);
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("keeps a native row auditable after schedule edits and plan replacement, but stales a later commit", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-ledger-native-owner-"));
		try {
			execFileSync("git", ["init", "--initial-branch=main"], { cwd });
			writeFileSync(join(cwd, "artifact.txt"), "audited\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "audited"],
				{ cwd },
			);
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
			const manager = SessionManager.inMemory();
			let phases: TodoPhase[] = [];
			const session: ToolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				settings: Settings.isolated(),
				getSessionSpawns: () => "*",
				sessionManager: manager,
				getTodoPhases: () => phases,
				setTodoPhases: next => {
					phases = next;
				},
			};
			const tool = new TodoTool(session);
			await tool.execute("init", { op: "init", items: ["Build artifact"] });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			await tool.execute("append", { op: "append", phase: "Tasks", items: ["Review artifact"] });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
			expect(persisted[0]?.tasks.map(task => [task.content, task.artifactCwd, task.artifactOwner])).toEqual([
				["Build artifact", cwd, "main"],
				["Review artifact", cwd, "main"],
			]);
			Object.assign(persisted[0]!.tasks[0]!, { schedule: { resources: [] } });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: persisted });
			const current = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", persisted);
			expect(current).toEqual({ cwd, head, dirty: false });
			const requirement: RequirementLedgerItem = {
				...createRequirementCandidates([], ["build this artifact"], AT)[0]!,
				classification: "linked",
				rows: ["Build artifact"],
				verdict: {
					status: "pass",
					evidence: "qa evidence",
					artifact: head,
					workerId: "qa-1",
					auditor: "qa-auditor",
					rawWords: "build this artifact",
				},
			};
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				requirement,
			]);
			const done = await tool.execute("done", { op: "done", task: "Build artifact" });
			expect(done.isError).toBeUndefined();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const replacement = await tool.execute("next-plan", { op: "init", items: ["New plan"] });
			expect(replacement.isError).toBeUndefined();
			expect(phases.flatMap(phase => phase.tasks.map(task => task.content))).toEqual(["New plan"]);
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const archived = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases);
			expect(getRequirementVerdictStaleness(requirement, [{ row: "Build artifact", ...archived }])).toBeNull();
			const unknown = await getRequirementRowArtifact({ cwd }, "legacy row", [
				{
					name: "Legacy",
					tasks: [
						{
							content: "legacy row",
							status: "completed",
							schedule: { owner: "UnknownWorker", resources: [] },
						} as TodoPhase["tasks"][number],
					],
				},
			]);
			expect(unknown.head).toBeNull();
			writeFileSync(join(cwd, "artifact.txt"), "committed change\n");
			const dirty = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases);
			expect(dirty).toMatchObject({ cwd, head, dirty: true });
			expect(getRequirementVerdictStaleness(requirement, [{ row: "Build artifact", ...dirty }])).toContain(
				'dirty artifact content changed for row "Build artifact"',
			);
			execFileSync("git", ["add", "artifact.txt"], { cwd });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "changed"],
				{ cwd },
			);
			const changed = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases);
			expect(changed.head).not.toBe(head);
			const staleReason = getRequirementVerdictStaleness(requirement, [{ row: "Build artifact", ...changed }]);
			expect(staleReason).not.toBeNull();
			expect(staleReason).toContain(head);
			expect(staleReason).toContain(changed.head!);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it.each(["in_progress", "abandoned", "pending"] as const)(
		"resolves an omitted %s row's declared artifact without completing it",
		async status => {
			const root = mkdtempSync(join(tmpdir(), "omp-ledger-historical-declaration-"));
			try {
				const cwd = join(root, "tasks-loop");
				const resource = join(root, "omp-fix41-gate-20261004");
				mkdirSync(cwd);
				mkdirSync(resource);
				execFileSync("git", ["init", "--initial-branch=main"], { cwd: resource });
				writeFileSync(join(resource, "artifact.txt"), "classify gate artifact\n");
				execFileSync("git", ["add", "artifact.txt"], { cwd: resource });
				execFileSync(
					"git",
					["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
					{ cwd: resource },
				);
				const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: resource, encoding: "utf8" }).trim();
				const row = "Fix R1 classify gate blocking read-only tools";
				const historical = [
					{
						name: "Sunbim scheduler churn",
						tasks: [
							{
								content: row,
								status,
								artifactCwd: cwd,
								artifactOwner: "main",
								schedule: { owner: "ExemptReadOnlyFromClassifyGate", resources: [resource], dependencies: [] },
							},
						],
					},
				] as unknown as TodoPhase[];
				const manager = SessionManager.inMemory();
				// Original Main tool-result snapshots de77a2cb/74a7e859, 2026-10-04;
				// retain the row's declaration shape, replacing only filesystem locations.
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "classify-r3",
					toolName: "todo",
					content: [{ type: "text", text: "Classified R3 as linked." }],
					details: { op: "classify", phases: historical },
					isError: false,
					timestamp: 1791106532358,
				});
				const phases: TodoPhase[] = [{ name: "Next", tasks: [{ content: "Different row", status: "pending" }] }];
				manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
				const before = JSON.stringify(manager.getBranch());
				const ctx = { cwd, sessionManager: manager };
				const artifact = await getRequirementRowArtifact(ctx, row, phases);
				expect(artifact).toEqual({
					cwd: resource,
					head: null,
					dirty: false,
					identities: [{ kind: "git", repo: resource, commit }],
				});
				const receipt = formatRequirementIdentity(artifact.identities![0]!);
				expect(await getRequirementRowArtifact({ ...ctx, receipt }, row, phases)).toMatchObject({
					identityCheck: { artifact: receipt },
				});
				expect(JSON.stringify(manager.getBranch())).toBe(before);
				expect(historical[0]!.tasks[0]!.status).toBe(status);
				expect(getLatestTodoPhasesFromEntries(manager.getBranch())).toEqual(phases);
				const requirement: RequirementLedgerItem = {
					...createRequirementCandidates([], ["fix the classify gate"], AT)[0]!,
					classification: "linked",
					rows: [row],
				};
				expect(getRequirementVerdictStaleness(requirement, [{ row, ...artifact }])).not.toBeNull();
				writeFileSync(join(resource, "artifact.txt"), "dirty classify gate artifact\n");
				const dirty = await getRequirementRowArtifact({ ...ctx, receipt }, row, phases);
				expect(dirty.identityCheck?.reason).toContain("unverifiable git");
				expect(execFileSync("git", ["status", "--porcelain"], { cwd: resource, encoding: "utf8" })).toContain(
					"artifact.txt",
				);
				rmSync(resource, { recursive: true, force: true });
				const missing = await getRequirementRowArtifact(ctx, row, phases);
				expect(missing.identities).toBeUndefined();
				expect(missing.reason).toContain("current identity unavailable");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("rejects duplicate historical rows while preferring an unambiguous current row", async () => {
		const manager = SessionManager.inMemory();
		const row = "Fix R1 classify gate blocking read-only tools";
		const task = {
			content: row,
			status: "in_progress" as const,
			schedule: {
				owner: "ExemptReadOnlyFromClassifyGate",
				resources: ["/tmp/absent-historical-artifact"],
				dependencies: [],
			},
		};
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [{ name: "Plan", tasks: [task] }] });
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [{ name: "Plan", tasks: [task, task] }] });
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
		const ctx = { cwd: "/tmp", sessionManager: manager };
		expect(await getRequirementRowArtifact(ctx, row, [])).toMatchObject({
			head: null,
			dirty: true,
			cwd: `duplicate historical TODO row ${JSON.stringify(row)}`,
		});
		const root = mkdtempSync(join(tmpdir(), "omp-ledger-current-declaration-"));
		try {
			const path = join(root, "artifact.txt");
			writeFileSync(path, "current artifact\n");
			const current = [{ name: "Current", tasks: [{ ...task, schedule: { resources: [path] } }] }];
			const artifact = await getRequirementRowArtifact(ctx, row, current);
			expect(artifact.cwd).toBe(path);
			expect(artifact.identities).toEqual([
				{ kind: "file", path, sha256: createHash("sha256").update("current artifact\n").digest("hex") },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the audited worker checkout after its registry entry disappears", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-ledger-worker-owner-"));
		const owner = `worker-${root.slice(root.lastIndexOf("/") + 1)}`;
		const registry = AgentRegistry.global();
		try {
			const main = join(root, "main");
			const worker = join(root, "worker");
			for (const cwd of [main, worker]) {
				mkdirSync(cwd);
				execFileSync("git", ["init", "--initial-branch=main"], { cwd });
				writeFileSync(join(cwd, "artifact.txt"), cwd);
				execFileSync("git", ["add", "artifact.txt"], { cwd });
				execFileSync(
					"git",
					["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
					{ cwd },
				);
			}
			const manager = SessionManager.inMemory();
			const phases = [
				{
					name: "Plan",
					tasks: [
						{
							content: "Worker result",
							status: "in_progress",
							artifactCwd: main,
							artifactOwner: "main",
							schedule: { owner, resources: [] },
						},
					],
				},
			] as unknown as TodoPhase[];
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const ctx = { cwd: main, sessionManager: manager };
			const unknown = await getRequirementRowArtifact(ctx, "Worker result", phases);
			expect(unknown.head).toBeNull();
			registry.register({
				id: owner,
				displayName: owner,
				kind: "sub",
				status: "idle",
				session: {
					sessionManager: { getCwd: () => worker },
				} as never,
			});
			const bound = await bindRequirementRowArtifact(ctx, "Worker result", phases, {
				appendEntry: (type, data) => manager.appendCustomEntry(type, data),
			});
			const auditedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worker, encoding: "utf8" }).trim();
			expect(bound).toEqual({ cwd: worker, head: auditedHead, dirty: false });
			const persisted = getLatestTodoPhasesFromEntries(manager.getBranch());
			expect([persisted[0]?.tasks[0]?.artifactCwd, persisted[0]?.tasks[0]?.artifactOwner]).toEqual([worker, owner]);
			registry.unregister(owner);
			expect(await getRequirementRowArtifact(ctx, "Worker result", persisted)).toEqual(bound);
			persisted[0]!.tasks[0]!.status = "completed";
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: persisted });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
				phases: [
					{
						name: "Next",
						tasks: [{ content: "Different row", status: "pending", artifactCwd: main, artifactOwner: "main" }],
					},
				],
			});
			const latest = getLatestTodoPhasesFromEntries(manager.getBranch());
			const archived = await getRequirementRowArtifact(ctx, "Worker result", latest);
			expect(archived).toEqual(bound);
			writeFileSync(join(worker, "artifact.txt"), "new worker commit\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd: worker });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "worker changed"],
				{ cwd: worker },
			);
			const changed = await getRequirementRowArtifact(ctx, "Worker result", latest);
			expect(changed.cwd).toBe(worker);
			expect(changed.head).not.toBe(auditedHead);
		} finally {
			registry.unregister(owner);
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("binds each audited row to its own commit or installed binary hash", async () => {
		const root = mkdtempSync(join(tmpdir(), "omp-ledger-mixed-artifacts-"));
		const repo = join(root, "repo");
		mkdirSync(repo);
		const binary = join(root, "omp");
		const binaryBytes = Buffer.from("installed omp test binary");
		writeFileSync(binary, binaryBytes);
		try {
			execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo });
			writeFileSync(join(repo, "artifact.txt"), "commit artifact\n");
			execFileSync("git", ["add", "artifact.txt"], { cwd: repo });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "artifact"],
				{ cwd: repo },
			);
			const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
			const binaryHash = createHash("sha256").update(binaryBytes).digest("hex");
			const rows = ["Commit artifact", "Installed omp"];
			const phases = [
				{
					name: "Work",
					tasks: [
						{ content: rows[0], status: "pending", schedule: { owner: "main", resources: [repo] } },
						{ content: rows[1], status: "pending", schedule: { owner: "main", resources: [binary] } },
					],
				},
			] as unknown as TodoPhase[];
			const [commitArtifact, binaryArtifact] = await Promise.all(
				rows.map(row => getRequirementRowArtifact({ cwd: repo }, row, phases)),
			);
			expect(commitArtifact).toMatchObject({ cwd: repo, head: null, dirty: false });
			expect(commitArtifact.identities).toEqual([{ kind: "git", repo, commit }]);
			expect(binaryArtifact).toMatchObject({ cwd: binary, head: null, dirty: false });
			expect(binaryArtifact.identities).toEqual([{ kind: "file", path: binary, sha256: binaryHash }]);
			const commitIdentity = formatRequirementIdentity({ kind: "git", repo, commit });
			const fileIdentity = formatRequirementIdentity({ kind: "file", path: binary, sha256: binaryHash });
			const cell = `row ${JSON.stringify(rows[0])} @ ${commitIdentity}; row ${JSON.stringify(rows[1])} @ ${fileIdentity}`;
			expect(getRequirementRowArtifactIdentity(cell, rows[0]!, rows)).toBe(
				`row ${JSON.stringify(rows[0])} @ ${commitIdentity}`,
			);
			expect(getRequirementRowArtifactIdentity(cell, rows[1]!, rows)).toBe(
				`row ${JSON.stringify(rows[1])} @ ${fileIdentity}`,
			);
			const verdict = (artifact: string) => ({
				status: "pass" as const,
				evidence: "exercised the artifact",
				rawWords: "check both artifacts",
				artifact,
				workerId: "qa-1",
				auditor: "qa-auditor" as const,
				receivedAt: AT,
			});
			const requirement: RequirementLedgerItem = {
				...createRequirementCandidates([], ["check both artifacts"], AT)[0]!,
				classification: "linked",
				rows,
				rowVerdicts: {
					[rows[0]!]: verdict(cell),
					[rows[1]!]: verdict(cell),
				},
			};
			const commitScoped = getRequirementRowArtifactIdentity(cell, rows[0]!, rows)!;
			const binaryScoped = getRequirementRowArtifactIdentity(cell, rows[1]!, rows)!;
			const [freshCommit, freshBinary] = await Promise.all([
				getRequirementRowArtifact({ cwd: repo, receipt: commitScoped }, rows[0]!, phases),
				getRequirementRowArtifact({ cwd: repo, receipt: binaryScoped }, rows[1]!, phases),
			]);
			expect(freshCommit.identityCheck?.artifact).toBe(commitScoped);
			expect(freshBinary.identityCheck?.artifact).toBe(binaryScoped);
			expect(
				getRequirementVerdictStaleness(requirement, [
					{ row: rows[0]!, ...freshCommit },
					{ row: rows[1]!, ...freshBinary },
				]),
			).toBeNull();
			const staleCommit = "f".repeat(40);
			const staleCell = `row ${JSON.stringify(rows[0])} @ ${formatRequirementIdentity({ kind: "git", repo, commit: staleCommit })}; row ${JSON.stringify(rows[1])} @ ${fileIdentity}`;
			const stale = {
				...requirement,
				rowVerdicts: {
					[rows[0]!]: verdict(staleCell),
					[rows[1]!]: verdict(staleCell),
				},
			};
			const staleScopedCommit = getRequirementRowArtifactIdentity(staleCell, rows[0]!, rows)!;
			const staleProbedCommit = await getRequirementRowArtifact(
				{ cwd: repo, receipt: staleScopedCommit },
				rows[0]!,
				phases,
			);
			const staleReason = getRequirementVerdictStaleness(stale, [
				{ row: rows[0]!, ...staleProbedCommit },
				{ row: rows[1]!, ...freshBinary },
			]);
			expect(staleReason).not.toBeNull();
			expect(staleReason).toContain(staleCommit);
			expect(staleReason).toContain(commit);
			const staleSingle = getRequirementVerdictStaleness(stale, [{ row: rows[0]!, ...staleProbedCommit }]);
			expect(staleSingle).not.toBeNull();
			expect(staleSingle).toContain(staleCommit);
			expect(staleSingle).toContain(commit);
			expect(getRequirementVerdictStaleness(stale, [{ row: rows[1]!, ...freshBinary }])).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("resolves an Rn-prefixed row label to the assigned row but keeps rejecting foreign rows", () => {
		const assigned = "Rebuild PR #54 from Maksim tip";
		const foreign = "Write take-whole-teammate-branch rule into global rules";
		const sha = "a".repeat(40);
		const knownRows = new Set([assigned, foreign]);
		// R42 shape: an R4 receipt in a merged-source audit whose artifact cites the
		// R6 label for the row R4 itself is assigned to. R4 is linked to two rows, so
		// the legacy single-row projection cannot accept it: only the explicit label can.
		expect(
			getRequirementRowArtifactIdentity(`R6 row "${assigned}" @ ${sha}`, assigned, [assigned, foreign], knownRows),
		).toBe(`R6 row "${assigned}" @ ${sha}`);
		// A label naming a row the receipt is not assigned to must never resolve to it.
		expect(
			getRequirementRowArtifactIdentity(`R6 row "${foreign}" @ ${sha}`, assigned, [assigned, foreign], knownRows),
		).toBeUndefined();
	});
	it("retains Rn-prefixed Git path coverage, file hashes, and deployment probes", () => {
		const row = 'Build; "artifact"';
		const prefix = `R6 row ${JSON.stringify(row)} @ `;
		const commit = "a".repeat(40);
		const sha256 = "b".repeat(64);
		const artifact = [
			`${prefix}git:/tmp/artifact@${commit} paths=["src/a.ts"]`,
			`${prefix}file:/tmp/output@sha256=${sha256}`,
			`${prefix}deploy:https://example.test/version@v1 field=version`,
		].join("; ");
		const scoped = getRequirementRowArtifactIdentity(artifact, row, [row]);
		expect(scoped).toBeDefined();
		expect(parseRequirementReceiptIdentities(scoped!)).toEqual({
			identities: [
				{ kind: "git", repo: "/tmp/artifact", commit, paths: ["src/a.ts"] },
				{ kind: "file", path: "/tmp/output", sha256 },
				{ kind: "deploy", target: "https://example.test/version", value: "v1", field: "version" },
			],
		});
	});
	it("rejects malformed Rn-prefixed typed receipts instead of accepting a legacy SHA", () => {
		const artifact = `R6 row "Build artifact" @ file:/tmp/output@sha256=${"a".repeat(40)}`;
		expect(parseRequirementReceiptIdentities(artifact)).toHaveProperty("error", expect.stringContaining("sha256"));
	});
});

describe("canonical requirements ledger", () => {
	it("preserves three raw asks and allocates stable IDs across synthetic snapshots", () => {
		const manager = SessionManager.inMemory();
		const asks = [" First ask  ", "second\nask", "третий запрос"];
		const requirements = createRequirementCandidates([], asks, AT);
		appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, requirements);
		expect(getLatestRequirements(manager.getBranch()).map(item => [item.id, item.rawText])).toEqual([
			["R1", asks[0]],
			["R2", asks[1]],
			["R3", asks[2]],
		]);
		const next = createRequirementCandidates(getLatestRequirements(manager.getBranch()), ["fourth"], AT);
		expect(next.map(item => item.id)).toEqual(["R1", "R2", "R3", "R4"]);
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, { version: 2, requirements: [] });
		expect(getLatestRequirements(manager.getBranch())).toEqual(requirements);
		manager.appendCustomEntry("other", { version: 1, requirements: [] });
		expect(getLatestRequirements(manager.getBranch())).toEqual(requirements);
	});

	it("accepts a verdict table inside JSON string values but rejects objects without a table", () => {
		const table = [
			"| id | raw words | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- | --- |",
			`| R1 | audit artifact | pass | inspected the build | ${"a".repeat(40)} |`,
		].join("\n");
		expect(parseRequirementReceipt(table, ["R1"])).not.toBeNull();
		expect(parseRequirementReceipt(JSON.stringify({ result: table }), ["R1"])).toEqual(
			parseRequirementReceipt(table, ["R1"]),
		);
		expect(
			parseRequirementReceipt(JSON.stringify({ result: { requirement: "R1", verdict: "pass" } }), ["R1"]),
		).toBeNull();
		expect(
			parseRequirementReceipt(JSON.stringify({ table, report: table.replace("audit artifact", "different ask") }), [
				"R1",
			]),
		).toBeNull();
		expect(
			parseRequirementReceipt(table.replace("| --- | --- | --- | --- | --- |", "| -- | -- | -- | -- | -- |"), [
				"R1",
			]),
		).toBeNull();
	});

	it("preserves auditor verdicts and measurement evidence without a second numeric judgment", () => {
		for (const verdict of ["pass", "fail", "unverifiable"] as const) {
			const table = [
				"| id | raw words | verdict | evidence | claimed | measured | artifact identity |",
				"| --- | --- | --- | --- | --- | --- | --- |",
				`| R1 | audit artifact | ${verdict} | measured exact artifact | 64.57 MB / ≈14× | 64.571309 MB / 14.0000000596× | ${"a".repeat(40)} |`,
			].join("\n");
			const parsed = parseRequirementReceipt(table, ["R1"]);
			expect(parsed?.[0]?.status).toBe(verdict);
			expect(parsed?.[0]?.evidence).toContain("64.57 MB / ≈14×");
			expect(parsed?.[0]?.evidence).toContain("64.571309 MB / 14.0000000596×");
		}
	});

	it("does not treat installed binary hashes as competing row-bound Git commits", () => {
		const commit = "d944615c51337beb482a9a7c34ad1b25e48d21b9";
		const binary = "735156d208bec0dc3c015f1fd2a2555146a53ac6cba35fd84722633fef06f4cc";
		expect(
			parseRequirementReceiptIdentities(`row "Installed repair" @ ${commit}; installed SHA-256 ${binary}`),
		).toEqual({ legacy: true, commits: [commit] });
		expect(parseRequirementReceiptIdentities(`${commit}; ${binary}`)).toEqual({
			legacy: true,
			commits: [commit, binary],
		});
	});

	it("still parses old receipts without claimed and measured columns", () => {
		const table = [
			"| id | raw words | verdict | evidence | artifact identity |",
			"| --- | --- | --- | --- | --- |",
			`| R1 | audit artifact | pass | inspected the build | ${"a".repeat(40)} |`,
		].join("\n");
		expect(parseRequirementReceipt(table, ["R1"])).toEqual([
			{
				id: "R1",
				rawWords: "audit artifact",
				status: "pass",
				evidence: "inspected the build",
				artifact: "a".repeat(40),
			},
		]);
	});

	it("rejects malformed and duplicate IDs without silently deleting asks", () => {
		const requirements = createRequirementCandidates([], ["keep these words"], AT);
		expect(parseRequirementsLedger({ version: 1, requirements: [...requirements, requirements[0]] })).toBeUndefined();
		expect(
			parseRequirementsLedger({ version: 1, requirements: [{ ...requirements[0], at: "yesterday" }] }),
		).toBeUndefined();
		expect(
			parseRequirementsLedger({ version: 1, requirements: [{ ...requirements[0], verdict: { status: "pass" } }] }),
		).toBeUndefined();
		const passVerdict = { status: "pass" as const, evidence: "observed", artifact: "artifact", workerId: "QA" };
		for (const verdict of [
			{ ...passVerdict, evidence: "   " },
			{ ...passVerdict, artifact: "" },
			{ ...passVerdict, workerId: " " },
		]) {
			expect(
				parseRequirementsLedger({
					version: 1,
					requirements: [{ ...requirements[0]!, classification: "linked", rows: ["row"], verdict }],
				}),
			).toBeUndefined();
		}
		expect(
			parseRequirementsLedger({
				version: 1,
				requirements: [{ ...requirements[0]!, classification: "not-a-requirement" }],
			}),
		).toBeUndefined();
		expect(
			parseRequirementsLedger({
				version: 1,
				requirements: [{ ...requirements[0]!, classification: "not-a-requirement", reason: "  " }],
			}),
		).toBeUndefined();
		expect(classifyRequirement(requirements, "R1", "not-a-requirement")).toHaveProperty("error");
		expect(() =>
			appendRequirementsSnapshot(
				{
					appendEntry() {
						throw new Error("must not write");
					},
				},
				[{ ...requirements[0]!, id: "task-1" }],
			),
		).toThrow("Invalid requirements ledger");
	});

	it("merges candidate identities without dropping raw words or linked rows", () => {
		const requirements = createRequirementCandidates([], ["first", "second"], AT);
		requirements[1] = {
			...requirements[1]!,
			classification: "linked",
			rows: ["row B"],
			verdict: { status: "pass", evidence: "old audit", artifact: "old artifact", workerId: "QA" },
		};
		const merged = classifyRequirement(requirements, "R1", "merged", { mergeInto: "R2" });
		if ("error" in merged) throw new Error(merged.error);
		expect(merged.requirements[0]).toEqual({
			...requirements[0]!,
			classification: "merged",
			rows: [],
			mergeInto: "R2",
		});
		expect(merged.requirements[1]?.rows).toEqual(["row B"]);
		expect(merged.requirements[1]?.verdict).toBeUndefined();
		expect(requirements[1]?.verdict?.status).toBe("pass");
		expect(getRequirementAuditSources(merged.requirements, "R2")).toEqual([
			{ id: "R2", at: AT, rawText: "second" },
			{ id: "R1", at: AT, rawText: "first" },
		]);
		expect(classifyRequirement(requirements, "R1", "merged", { mergeInto: "R1" })).toHaveProperty("error");
		expect(classifyRequirement(requirements, "R8", "not-a-requirement")).toHaveProperty("error");
	});

	it("offers row linking or not-a-requirement instead of another merged directive when no merge target is linked", () => {
		const requirements = createRequirementCandidates(
			[],
			Array.from({ length: 21 }, (_, index) => `legacy ask ${index + 1}`),
			AT,
		);
		requirements[18] = {
			...requirements[18]!,
			classification: "not-a-requirement",
			reason: "duplicate of the approval ask",
		};
		const result = classifyRequirement(requirements, "R20", "merged", { mergeInto: "R99" });
		if (!("error" in result)) throw new Error("expected the unknown merge target to block the call");
		const recovery = result.error;
		expect(recovery).not.toContain('classification="merged"');
		expect(recovery).not.toContain("mergeInto=");
		expect(recovery).toContain('classification="linked"');
		expect(recovery).toContain("rows=");
		expect(recovery).toContain('classification="not-a-requirement"');
		expect(recovery).toContain("reason=");
		const directiveIds = [...recovery.matchAll(/id="([^"]*)"/g)].map(match => match[1]);
		expect(directiveIds).toContain("R20");
		expect(directiveIds.filter(directiveId => directiveId !== "R20")).toEqual([]);
	});

	it("lists only linked non-source requirements as available merge targets on invalid-target recovery", () => {
		const row = "Proven ledger row";
		const requirements = createRequirementCandidates(
			[],
			Array.from({ length: 21 }, (_, index) => `legacy ask ${index + 1}`),
			AT,
		);
		requirements[0] = { ...requirements[0]!, classification: "linked", rows: [row] };
		requirements[1] = { ...requirements[1]!, classification: "merged", rows: [], mergeInto: "R1" };
		requirements[18] = {
			...requirements[18]!,
			classification: "not-a-requirement",
			reason: "duplicate of the approval ask",
		};
		const result = classifyRequirement(requirements, "R20", "merged", { mergeInto: "R99" });
		if (!("error" in result)) throw new Error("expected the unknown merge target to block the call");
		const recovery = result.error;
		expect(recovery).toContain('Available active merge targets: ["R1"]');
		const availability = recovery.match(/Available active merge targets: (\[[^\]]*\])/)?.[1];
		expect(JSON.parse(availability ?? "[]")).toEqual(["R1"]);
		expect(recovery).not.toMatch(/mergeInto="R\d+"/);
		expect(recovery).not.toContain(row);
	});

	it("counts candidates and unverifiable verdicts as open, excluding merged and rejected asks", () => {
		const requirements = createRequirementCandidates(
			[],
			["candidate", "pass", "fail", "unverifiable", "rejected", "merged"],
			AT,
		);
		const verdict = (status: "pass" | "fail" | "unverifiable") => ({
			status,
			evidence: "observed",
			artifact: "r2",
			workerId: "QA",
			...(status === "pass" ? { auditor: "qa-auditor" as const } : {}),
		});
		requirements[1] = {
			...requirements[1]!,
			classification: "linked",
			rows: ["B"],
			verdict: { ...verdict("pass"), rawWords: "pass" },
		};
		requirements[2] = { ...requirements[2]!, classification: "linked", rows: ["C"], verdict: verdict("fail") };
		requirements[3] = {
			...requirements[3]!,
			classification: "linked",
			rows: ["D"],
			verdict: verdict("unverifiable"),
		};
		requirements[4] = { ...requirements[4]!, classification: "not-a-requirement", reason: "question" };
		requirements[5] = { ...requirements[5]!, classification: "merged", mergeInto: "R2" };
		expect(countRequirements(requirements)).toEqual({ total: 4, passed: 1, open: 2, failed: 1 });
	});

	it("keeps legacy pass receipts parseable but unproven and open", () => {
		const sha = "a".repeat(40);
		const requirements = createRequirementCandidates([], ["legacy pass"], AT);
		requirements[0] = {
			...requirements[0]!,
			classification: "linked",
			rows: ["Row"],
			verdict: { status: "pass", evidence: "audited", artifact: sha, workerId: "arbitrary-worker" },
		};
		const ledger = parseRequirementsLedger({ version: 1, requirements });
		expect(ledger?.requirements[0]?.rawText).toBe("legacy pass");
		expect(countRequirements(ledger!.requirements)).toEqual({ total: 1, passed: 0, open: 1, failed: 0 });
		expect(getRequirementVerdictStaleness(ledger!.requirements[0]!, [{ row: "Row", head: sha, dirty: false }])).toBe(
			'no authenticated qa-auditor identity for row "Row"',
		);
	});
});

describe("todo requirement classification", () => {
	// The classify op stays outside TodoOperation on purpose (converged with
	// runtime-core's "schedule" rewrite; see tools/todo.ts) and reaches the tool
	// cast-only, exactly as the implementation does.
	function harness(
		cwd = "/tmp",
		initialPhases?: ScheduledTodoPhase[],
		rawTexts = ["  preserve the ask  ", "second ask", "third ask"],
	) {
		const manager = SessionManager.inMemory();
		let phases: ScheduledTodoPhase[] = initialPhases ?? [
			{ name: "Work", tasks: [{ content: "Build artifact", status: "pending" }] },
		];
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], rawTexts, AT),
		});
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			getTodoPhases: () => phases,
			setTodoPhases: next => {
				phases = next;
			},
		};
		// The tests' cast boundary: classify payloads keep their real shape here.
		const rawTool = new TodoTool(session);
		const tool = {
			execute: (name: string, params: Record<string, unknown>) => rawTool.execute(name, params as never),
		};
		return { manager, tool, getPhases: () => phases };
	}

	it("atomically classifies a candidate over existing row resources without a relink cycle", async () => {
		for (const relink of [false, true]) {
			const { manager, tool, getPhases } = harness("/tmp", [
				{
					name: "Work",
					tasks: [
						{ content: "Build artifact", status: "pending", schedule: { resources: ["/tmp/old-artifact"] } },
					],
				},
			]);
			const result = await tool.execute("first-binding", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: ["Build artifact"],
				resources: ["/tmp/new-artifact"],
				relink,
			});
			expect(result.isError).toBeUndefined();
			expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("linked");
			expect(getPhases()[0]?.tasks[0]?.schedule?.resources).toEqual(["/tmp/new-artifact"]);
			const before = getLatestRequirements(manager.getBranch());
			const refused = await tool.execute("linked-binding-without-reason", {
				op: "classify",
				id: "R1",
				classification: "linked",
				rows: ["Build artifact"],
				resources: ["/tmp/third-artifact"],
				relink: true,
			});
			expect(refused.isError).toBe(true);
			expect(getLatestRequirements(manager.getBranch())).toEqual(before);
			expect(getPhases()[0]?.tasks[0]?.schedule?.resources).toEqual(["/tmp/new-artifact"]);
		}
	});

	it("invalidates affected shared-row receipts during first binding while retaining untouched receipts", async () => {
		const { manager, tool } = harness("/tmp", [
			{
				name: "Work",
				tasks: [
					{ content: "Build artifact", status: "pending", schedule: { resources: ["/tmp/old-artifact"] } },
					{ content: "Untouched artifact", status: "pending" },
				],
			},
		]);
		const saved = getLatestRequirements(manager.getBranch());
		const receipt = {
			status: "pass" as const,
			auditor: "qa-auditor" as const,
			workerId: "PreviousAudit",
			evidence: "prior audited artifact",
			artifact: "a".repeat(40),
			receivedAt: AT,
		};
		saved[1] = {
			...saved[1]!,
			classification: "linked",
			rows: ["Build artifact", "Untouched artifact"],
			rowVerdicts: { "Build artifact": receipt, "Untouched artifact": receipt },
		};
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
			saved,
		);
		const result = await tool.execute("shared-first-binding", {
			op: "classify",
			id: "R1",
			classification: "linked",
			rows: ["Build artifact"],
			resources: ["/tmp/new-artifact"],
		});
		expect(result.isError).toBeUndefined();
		const other = getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === "R2")!;
		expect(other.rowVerdicts?.["Build artifact"]).toBeUndefined();
		expect(other.rowVerdicts?.["Untouched artifact"]).toEqual(receipt);
	});

	it("persists classifications and keeps TODO phases unchanged", async () => {
		const { manager, tool, getPhases } = harness();
		const before = getPhases();
		const linked = await tool.execute("link", {
			op: "classify",
			id: "R1",
			classification: "linked",
			rows: ["Build artifact"],
		});
		expect(linked.isError).toBeUndefined();
		const snapshotsBefore = manager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE).length;
		const reclassification = await tool.execute("reclassify", {
			op: "classify",
			id: "R1",
			classification: "not-a-requirement",
			reason: "later change",
		});
		expect(reclassification.isError).toBe(true);
		expect(
			manager
				.getBranch()
				.filter(entry => entry.type === "custom" && entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE),
		).toHaveLength(snapshotsBefore);
		expect(getLatestRequirements(manager.getBranch())[0]?.classification).toBe("linked");
		expect(committedTodoPhases(linked)).toBeUndefined();
		expect(getPhases()).toBe(before);
		await tool.execute("reject", {
			op: "classify",
			id: "R2",
			classification: "not-a-requirement",
			reason: "just a question",
		});
		await tool.execute("merge", { op: "classify", id: "R3", classification: "merged", mergeInto: "R1" });
		const persisted = getLatestRequirements(manager.getBranch());
		expect(persisted.map(item => [item.id, item.classification, item.rawText])).toEqual([
			["R1", "linked", "  preserve the ask  "],
			["R2", "not-a-requirement", "second ask"],
			["R3", "merged", "third ask"],
		]);
		expect(persisted[0]?.rows).toEqual(["Build artifact"]);
		expect(persisted[2]?.mergeInto).toBe("R1");
	});

	it("does not persist unknown IDs, nonexistent rows, or invalid merges", async () => {
		const { manager, tool } = harness();
		const before: RequirementLedgerItem[] = getLatestRequirements(manager.getBranch());
		for (const params of [
			{ op: "classify" as const, id: "R9", classification: "not-a-requirement" as const },
			{ op: "classify" as const, id: "R1", classification: "linked" as const, rows: ["not a row"] },
			{ op: "classify" as const, id: "R1", classification: "merged" as const, mergeInto: "R9" },
		]) {
			expect((await tool.execute("invalid", params as never)).isError).toBe(true);
			expect(getLatestRequirements(manager.getBranch())).toEqual(before);
		}
	});

	it("carries incoming merges along when their target is reclassified", async () => {
		for (const transition of [
			{ classification: "not-a-requirement" as const, reason: "not in scope" },
			{ classification: "merged" as const, mergeInto: "R1" },
		]) {
			const { manager, tool } = harness();
			const merged = classifyRequirement(getLatestRequirements(manager.getBranch()), "R3", "merged", {
				mergeInto: "R2",
			});
			if ("error" in merged) throw new Error(merged.error);
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				merged.requirements,
			);
			const result = await tool.execute("reclassify-merge-target", { op: "classify", id: "R2", ...transition });
			expect(result.isError).toBeFalsy();
			const after = getLatestRequirements(manager.getBranch());
			const dependent = after.find(requirement => requirement.id === "R3")!;
			if (transition.classification === "merged") {
				expect(dependent).toMatchObject({ classification: "merged", mergeInto: "R1" });
			} else {
				expect(dependent.classification).toBe("not-a-requirement");
				expect(dependent.reason).toContain("R2");
			}
			expect(parseRequirementsLedger({ version: 1, requirements: after })).toBeDefined();
		}
	});

	it("blocks direct done for stale commits, fake artifacts, and unproven workers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "omp-requirements-ledger-"));
		function runGit(...args: string[]): string {
			return execFileSync("git", args, { cwd, encoding: "utf8" });
		}
		try {
			runGit("init", "--initial-branch=main");
			runGit("config", "user.email", "tester@example.invalid");
			runGit("config", "user.name", "Ledger Test");
			writeFileSync(join(cwd, "artifact.txt"), "audited\n");
			runGit("add", "artifact.txt");
			runGit("commit", "-m", "audited artifact");
			const auditedHead = runGit("rev-parse", "HEAD").trim();
			writeFileSync(join(cwd, "artifact.txt"), "changed\n");
			runGit("add", "artifact.txt");
			runGit("commit", "-m", "changed artifact");
			const currentHead = runGit("rev-parse", "HEAD").trim();
			const phases = [
				{
					name: "Work",
					tasks: [{ content: "Build artifact", status: "pending", schedule: { owner: "main", resources: [cwd] } }],
				},
			] as unknown as TodoPhase[];
			const { manager, tool, getPhases } = harness(cwd, phases, ["preserve the ask"]);
			const linked = getLatestRequirements(manager.getBranch());
			linked[0] = { ...linked[0]!, classification: "linked", rows: ["Build artifact"] };
			appendRequirementsSnapshot(
				{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
				linked,
			);
			const blocked = await tool.execute("without-pass", { op: "done", task: "Build artifact" });
			expect(blocked.isError).toBe(true);
			function appendPass(artifact: string, workerId: string, auditor?: "qa-auditor") {
				const requirements = getLatestRequirements(manager.getBranch());
				requirements[0] = {
					...requirements[0]!,
					verdict: {
						status: "pass",
						evidence: "audited",
						artifact,
						workerId,
						...(auditor ? { auditor } : {}),
						rawWords: requirements[0]!.rawText,
					},
					rowVerdicts: {
						...requirements[0]!.rowVerdicts,
						["Build artifact"]: {
							status: "pass",
							evidence: "audited",
							artifact,
							workerId,
							...(auditor ? { auditor } : {}),
							rawWords: requirements[0]!.rawText,
							receivedAt: new Date().toISOString(),
						},
					},
				};
				appendRequirementsSnapshot(
					{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
					requirements,
				);
			}
			appendPass(`git:${cwd}@${auditedHead}`, "qa-run", "qa-auditor");
			const stale = await tool.execute("stale-pass", { op: "done", task: "Build artifact" });
			expect(stale.isError).toBe(true);
			expect(getPhases()[0]?.tasks[0]?.status).toBe("pending");
			appendPass("artifact-sha", "arbitrary-worker");
			const fakeArtifact = await tool.execute("fake-artifact", { op: "done", task: "Build artifact" });
			expect(fakeArtifact.isError).toBe(true);
			appendPass(`git:${cwd}@${currentHead}`, "arbitrary-worker");
			const fakeWorker = await tool.execute("fake-worker", { op: "done", task: "Build artifact" });
			expect(fakeWorker.isError).toBe(true);
			appendPass(`git:${cwd}@${currentHead}`, "qa-run", "qa-auditor");
			writeFileSync(join(cwd, "artifact.txt"), "dirty after audit\n");
			const dirty = await tool.execute("dirty-pass", { op: "done", task: "Build artifact" });
			expect(dirty.isError).toBe(true);
			writeFileSync(join(cwd, "artifact.txt"), "changed\n");
			appendPass(`git:${cwd}@${currentHead}`, "qa-run", "qa-auditor");
			const fresh = await tool.execute("fresh-pass", { op: "done", task: "Build artifact" });
			expect(fresh.isError).toBeUndefined();
			expect(getPhases()[0]?.tasks[0]?.status).toBe("completed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not gate todo done when no linked requirement applies", async () => {
		const { tool, getPhases } = harness("/tmp", undefined, []);
		const done = await tool.execute("done-unlinked", { op: "done", task: "Build artifact" });
		expect(done.isError).toBeUndefined();
		expect(getPhases()[0]?.tasks[0]?.status).toBe("completed");
	});

	it("uses exact explicit batches for direct mutation and linked-row gating", async () => {
		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "Row A", status: "pending" },
					{ content: "Row B", status: "pending" },
					{ content: "Row C", status: "pending" },
				],
			},
		];
		const { manager, tool, getPhases } = harness("/tmp", phases, ["preserve the ask"]);
		const requirements = getLatestRequirements(manager.getBranch());
		requirements[0] = { ...requirements[0]!, classification: "linked", rows: ["Row A"] };
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
			requirements,
		);
		const beforeEmptyBatch = structuredClone(getPhases());
		const emptyBatch = await tool.execute("done-empty-batch", { op: "done", items: [] });
		expect(emptyBatch.isError).toBe(true);
		expect(getPhases()).toEqual(beforeEmptyBatch);
		const itemOnly = await tool.execute("done-item-only", { op: "done", items: ["Row B"] });
		expect(itemOnly.isError).toBeUndefined();
		expect(getPhases()[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "completed", "pending"]);
		const mixed = await tool.execute("done-mixed-batch", { op: "done", task: "Row C", items: ["Row B"] });
		expect(mixed.isError).toBeUndefined();
		expect(getPhases()[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "completed", "completed"]);
		const linkedItem = await tool.execute("done-linked-item", { op: "done", items: ["Row A"] });
		expect(linkedItem.isError).toBe(true);
		expect(getPhases()[0]?.tasks[0]?.status).toBe("in_progress");
	});
});

describe("PR41 artifact and restatement boundaries", () => {
	it("rejects an unresolved artifact even when saved row timestamps match", async () => {
		const { getRequirementVerdictStaleness } = ledgerReviewExports;
		const req = {
			...createRequirementCandidates([], ["audit"], "2026-10-01T00:00:00.000Z")[0]!,
			classification: "linked" as const,
			rows: ["row"],
			rowVerdicts: {
				row: {
					status: "pass" as const,
					auditor: "qa-auditor" as const,
					workerId: "worker",
					evidence: "ran tests",
					rawWords: "audit",
					artifact: "anything",
					receivedAt: "2026-10-01T01:00:00.000Z",
					rowChangeId: "change",
				},
			},
		};
		expect(
			getRequirementVerdictStaleness(req, [
				{
					row: "row",
					head: null,
					dirty: true,
					reason: "owner unresolved",
					lastChange: { at: "2026-10-01T00:00:00.000Z", id: "change" },
				},
			]),
		).toBe('row "row": unresolved artifact (owner unresolved)');
		expect(
			getRequirementVerdictStaleness(req, [
				{ row: "row", head: null, dirty: true, lastChange: { at: "2026-10-01T00:00:00.000Z", id: "change" } },
			]),
		).toBeNull();
	});
	it("shortens the home path in artifact refusal output", () => {
		expect(
			ledgerReviewExports.formatRequirementGateArtifact({
				head: null,
				dirty: true,
				cwd: `${reviewOs.homedir()}/checkout`,
			}),
		).toContain("cwd=~/checkout");
	});
	it("allows an explicit image restatement to replace the blocked target while retaining both asks", () => {
		const old = {
			...createRequirementCandidates([], ["Image #1"], "2026-10-01T00:00:00.000Z")[0]!,
			classification: "linked" as const,
			rows: ["row"],
			imageState: "needs-user-restatement" as const,
		};
		const requirements = createRequirementCandidates(
			[old],
			["R1 restatement: make the frame blue"],
			"2026-10-01T01:00:00.000Z",
		);
		expect(
			"error" in
				classifyRequirement(
					createRequirementCandidates([old], ["unrelated work"], "2026-10-01T01:00:00.000Z"),
					"R1",
					"merged",
					{ mergeInto: "R2" },
				),
		).toBe(true);
		expect(
			"error" in
				classifyRequirement(
					createRequirementCandidates([old], ["R1 restatement"], "2026-09-30T00:00:00.000Z"),
					"R1",
					"merged",
					{ mergeInto: "R2" },
				),
		).toBe(true);
		const result = classifyRequirement(requirements, "R1", "merged", { mergeInto: "R2" });
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.requirements[0]?.rawText).toBe("Image #1");
		expect(result.requirements[0]?.classification).toBe("merged");
		expect(result.requirements[1]?.classification).toBe("linked");
		expect(result.requirements[1]?.rows).toEqual(["row"]);
		expect(result.requirements[1]?.imageState).toBeUndefined();
		expect(result.requirements[1]?.verdict).toBeUndefined();
	});
});

useFastGitStatusCoordinator();
