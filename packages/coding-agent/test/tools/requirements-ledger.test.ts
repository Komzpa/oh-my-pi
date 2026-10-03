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
	isFreshRequirementVerdict,
	parseRequirementsLedger,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

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
				expect(artifact).toEqual({
					cwd,
					dirty: false,
					head: execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
				});
			}
		} finally {
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
				},
			};
			appendRequirementsSnapshot({ appendEntry: (type, data) => manager.appendCustomEntry(type, data) }, [
				requirement,
			]);
			const done = await tool.execute("done", { op: "done", task: "Build artifact" });
			expect(done.isError).toBeUndefined();
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			await tool.execute("next-plan", { op: "init", items: ["New plan"] });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			const archived = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases);
			expect(isFreshRequirementVerdict(requirement, [{ row: "Build artifact", ...archived }])).toBe(true);
			const unknown = await getRequirementRowArtifact({ cwd }, "legacy row", [
				{
					name: "Legacy",
					tasks: [
						{
							content: "legacy row",
							status: "completed",
							schedule: { resources: [] },
						} as TodoPhase["tasks"][number],
					],
				},
			]);
			expect(unknown.head).toBeNull();
			writeFileSync(join(cwd, "artifact.txt"), "committed change\n");
			const dirty = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases);
			expect(dirty).toMatchObject({ cwd, head, dirty: true });
			expect(isFreshRequirementVerdict(requirement, [{ row: "Build artifact", ...dirty }])).toBe(false);
			execFileSync("git", ["add", "artifact.txt"], { cwd });
			execFileSync(
				"git",
				["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "changed"],
				{ cwd },
			);
			const changed = await getRequirementRowArtifact({ cwd, sessionManager: manager }, "Build artifact", phases);
			expect(changed.head).not.toBe(head);
			expect(isFreshRequirementVerdict(requirement, [{ row: "Build artifact", ...changed }])).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
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
		requirements[1] = { ...requirements[1]!, classification: "linked", rows: ["B"], verdict: verdict("pass") };
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
		expect(isFreshRequirementVerdict(ledger!.requirements[0]!, [{ row: "Row", head: sha, dirty: false }])).toBe(
			false,
		);
	});
});

describe("todo requirement classification", () => {
	function harness(cwd = "/tmp", initialPhases?: TodoPhase[]) {
		const manager = SessionManager.inMemory();
		let phases: TodoPhase[] = initialPhases ?? [
			{ name: "Work", tasks: [{ content: "Build artifact", status: "pending" }] },
		];
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], ["  preserve the ask  ", "second ask", "third ask"], AT),
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
		return { manager, tool: new TodoTool(session), getPhases: () => phases };
	}

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
			expect((await tool.execute("invalid", params)).isError).toBe(true);
			expect(getLatestRequirements(manager.getBranch())).toEqual(before);
		}
	});

	it("rejects reclassifying a candidate with incoming merge references before persistence", async () => {
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
			const before = getLatestRequirements(manager.getBranch());
			const result = await tool.execute("invalid-merge-target", { op: "classify", id: "R2", ...transition });
			expect(result.isError).toBe(true);
			const first = result.content[0];
			expect(first?.type === "text" ? first.text : undefined).toContain("R3 is merged into it");
			expect(parseRequirementsLedger({ version: 1, requirements: before })).toBeDefined();
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
			const { manager, tool, getPhases } = harness(cwd, phases);
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
					},
				};
				appendRequirementsSnapshot(
					{ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) },
					requirements,
				);
			}
			appendPass(auditedHead, "qa-run", "qa-auditor");
			const stale = await tool.execute("stale-pass", { op: "done", task: "Build artifact" });
			expect(stale.isError).toBe(true);
			expect(getPhases()[0]?.tasks[0]?.status).toBe("pending");
			appendPass("artifact-sha", "arbitrary-worker");
			const fakeArtifact = await tool.execute("fake-artifact", { op: "done", task: "Build artifact" });
			expect(fakeArtifact.isError).toBe(true);
			appendPass(currentHead, "arbitrary-worker");
			const fakeWorker = await tool.execute("fake-worker", { op: "done", task: "Build artifact" });
			expect(fakeWorker.isError).toBe(true);
			appendPass(currentHead, "qa-run", "qa-auditor");
			writeFileSync(join(cwd, "artifact.txt"), "dirty after audit\n");
			const dirty = await tool.execute("dirty-pass", { op: "done", task: "Build artifact" });
			expect(dirty.isError).toBe(true);
			writeFileSync(join(cwd, "artifact.txt"), "changed\n");
			const fresh = await tool.execute("fresh-pass", { op: "done", task: "Build artifact" });
			expect(fresh.isError).toBeUndefined();
			expect(getPhases()[0]?.tasks[0]?.status).toBe("completed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not gate todo done when no linked requirement applies", async () => {
		const { tool, getPhases } = harness();
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
		const { manager, tool, getPhases } = harness("/tmp", phases);
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
