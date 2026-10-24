import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { afterEach, describe, expect, it } from "bun:test";
import { currentRequirementIdentity, formatRequirementIdentity } from "../../src/utils/requirement-artifact";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import {
	getLatestTodoPhasesFromEntries,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";

const SHA_A = "5a891ef1d6ae3c0e6d257f311432f881b00aef89";
const SHA_B = "123456789abcdef0123456789abcdef012345678";
const AT = "2026-09-28T12:00:00.000Z";
const RAW = "Confirm the release is live and the skill bundle is current";
const ROW = "Close release checklist item 17";
const ROW_B = "Announce the release";
const AUDIT_CALL = "typed-audit";

/** Every fixture resource lives under its own mkdtemp root and is removed here; no global env or module is mutated. */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Result shape of a TodoTool execution, as read by these fixtures. */
interface TodoToolResult {
	isError?: boolean;
	content?: unknown[];
}

/**
 * Clones this checkout into a fresh temp root with the native VCS clone, then commits fixture files on top.
 * The source checkout is only read; the clone is removed with its temp root in afterEach.
 */
async function initRepo(files: Record<string, string>): Promise<{ root: string; head: string }> {
	const source = vcs.requireGit(import.meta.dir);
	const sourceHead = await source.headSha();
	if (!sourceHead) throw new Error("source checkout has no HEAD");
	const root = path.join(tempDir("omp-typed-git-"), "repo");
	// Checkout exceeds Bun's 5-second test default on this repository; bound it inside the test deadline.
	await vcs.clone(source.info().repoRoot, root, { sha: sourceHead, timeoutMs: 20_000 });
	for (const [file, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), text);
	}
	const repo = vcs.requireGit(root);
	await repo.configSet("user.email", "tester@example.invalid");
	await repo.configSet("user.name", "Typed Identity Fixture");
	await repo.stageFiles(Object.keys(files));
	await repo.commitCreate("release sources", {});
	const head = await repo.headSha();
	if (!head) throw new Error("fixture commit has no HEAD");
	return { root, head };
}

/** Git blob ID of a file's bytes: SHA-1 over `blob <len>\0` plus the content, computed without a git process. */
function blobIdOf(file: string): string {
	const bytes = fs.readFileSync(file);
	return new Bun.CryptoHasher("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** Typed `file:` identity for one absolute file: the SHA-256 of its bytes, the formula the wire carries. */
function fileId(file: string): string {
	return `file:${file}@sha256=${new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

/** Row-scoped typed artifact cell: `row "<exact TODO row>" @ <identity>`. */
function artifactCell(row: string, identities: string[]): string {
	return `row "${row}" @ ${identities.join("; ")}`;
}

/** True when `value`'s serialized form contains `text` (quotes and escapes compared in the same encoding). */
function containsText(value: unknown, text: string): boolean {
	const serialized = JSON.stringify(value);
	return serialized !== undefined && serialized.includes(JSON.stringify(text).slice(1, -1));
}

function textOf(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return "";
	return result.content
		.map(part =>
			part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
		)
		.join("\n");
}

/**
 * Serves `GET /v1/version` only. Any other method is 405, any other path is 404, so a probe that
 * hits the wrong endpoint cannot pass by accident.
 */
function versionServer(initial: string): { url: string; set(commit: string): void } {
	let commit = initial;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
			if (new URL(request.url).pathname !== "/v1/version") return new Response("not found", { status: 404 });
			return Response.json({ commit });
		},
	});
	cleanups.push(() => server.stop(true));
	return {
		url: `http://127.0.0.1:${server.port}/v1/version`,
		set(next) {
			commit = next;
		},
	};
}

interface ClassifyTarget {
	resources?: string[];
	/** Typed deployment declaration: `deploy:<endpoint>@<commit> field=<name>`. */
	deployment?: string;
}

interface Harness {
	cwd: string;
	manager: SessionManager;
	classifyResult: TodoToolResult;
	/** Real auditor dispatch preparation for the assigned row. */
	prepare(row: string): Promise<unknown>;
	/** Real auditor receipt intake, fed one receipt table. */
	receive(artifact: string, rawWords?: string): Promise<unknown>;
	/** Persist a schedule/evidence edit through the saved TODO history. */
	mutateSchedule(row: string): void;
	/** Real TodoTool done execution for one row. */
	done(label: string, row: string): Promise<TodoToolResult>;
}

/**
 * Ordinary setup: every row's schedule owner ("AuditTyped-1") is never registered, so the owner is gone.
 * Per-row schedule resources are seeded through the persisted TODO phases the public tool reads back.
 * The classify call uses the public payload: `resources` for files and checkouts, `deployment` for endpoints.
 */
async function harness(
	rows: string[],
	target: ClassifyTarget,
	scheduleResources: Record<string, string[]> = {},
	mappedCwd?: string,
): Promise<Harness> {
	const cwd = mappedCwd ?? tempDir("omp-typed-identity-");
	const agents = path.join(cwd, ".omp", "agents");
	fs.mkdirSync(agents, { recursive: true });
	fs.writeFileSync(
		path.join(agents, "qa-auditor.md"),
		fs.readFileSync(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url)),
	);
	const manager = SessionManager.inMemory(cwd);
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], [RAW], AT),
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Release",
				tasks: rows.map(content => ({
					content,
					status: "pending",
					schedule: mappedCwd
						? { owner: "main" }
						: { owner: "AuditTyped-1", resources: scheduleResources[content] ?? [] },
				})),
			},
		],
	});
	const tool = new TodoTool({
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		sessionManager: manager,
		getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
		setTodoPhases: (phases: TodoPhase[]) => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
	} as unknown as ToolSession);
	const classifyResult = await tool.execute("classify-typed", {
		op: "classify",
		id: "R1",
		classification: "linked",
		rows,
		...(target.resources !== undefined ? { resources: target.resources } : {}),
		...(target.deployment !== undefined ? { deployment: target.deployment } : {}),
	} as never);
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
	});
	return {
		cwd,
		manager,
		classifyResult,
		async prepare(row) {
			const phases = getLatestTodoPhasesFromEntries(manager.getBranch());
			for (const task of phases.flatMap(phase => phase.tasks)) {
				const schedule =
					"schedule" in task && typeof task.schedule === "object" && task.schedule !== null ? task.schedule : {};
				const owner = mappedCwd ? "main" : "AuditTyped-1";
				Object.assign(task, { schedule: { ...schedule, owner: task.content === row ? owner : "OtherAudit" } });
			}
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
			return runtime.prepareAuditorTaskCall("task", AUDIT_CALL, {
				name: mappedCwd ? "main" : "AuditTyped-1",
				agent: "qa-auditor",
				task: `Audit R1 for ${row}`,
				context: "",
			});
		},
		async receive(artifact, rawWords = RAW) {
			const output = [
				"| id | raw words | verdict | evidence | artifact identity |",
				"| --- | --- | --- | --- | --- |",
				`| R1 | ${rawWords} | pass | inspected declared artifacts | ${artifact} |`,
			].join("\n");
			return runtime.afterToolCall({
				toolCall: { id: AUDIT_CALL, name: "task" },
				result: {
					content: [],
					details: { results: [{ index: 0, agent: "qa-auditor", id: "AuditTyped-1", exitCode: 0, output }] },
				},
				isError: false,
			} as never);
		},
		mutateSchedule(row) {
			const phases = getLatestTodoPhasesFromEntries(manager.getBranch());
			const task = phases.flatMap(phase => phase.tasks).find(candidate => candidate.content === row);
			if (!task) throw new Error(`TODO row not found: ${row}`);
			const schedule = (task as typeof task & { schedule?: Record<string, unknown> }).schedule ?? {};
			Object.assign(task, { schedule: { ...schedule, estimate: 25, evidence: "schedule-review" } });
			manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		},
		async done(label, row) {
			return tool.execute(`done-${label}`, { op: "done", task: row } as never);
		},
	};
}

function verdictOf(fx: Harness, row: string) {
	return getLatestRequirements(fx.manager.getBranch())[0]?.rowVerdicts?.[row];
}

function statusOf(fx: Harness, row: string) {
	return getLatestTodoPhasesFromEntries(fx.manager.getBranch())[0]?.tasks.find(task => task.content === row)?.status;
}

describe("typed identity: accepted receipts", () => {
	it("P1 accepts a typed deploy receipt from a live Bun HTTP version endpoint after its owner is gone", async () => {
		const live = versionServer(SHA_A);
		const deployment = `deploy:${live.url}@${SHA_A} field=commit`;
		const fx = await harness([ROW], { deployment });
		expect(fx.classifyResult.isError).not.toBe(true);
		const prepared = await fx.prepare(ROW);
		expect(prepared).toBeDefined();
		expect(containsText(prepared, artifactCell(ROW, [deployment]))).toBe(true);
		expect(await fx.receive(artifactCell(ROW, [deployment]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		const done = await fx.done("p1", ROW);
		expect(done.isError).not.toBe(true);
		expect(statusOf(fx, ROW)).toBe("completed");
	});

	it("P4 accepts a typed deploy receipt from a live endpoint without optional row pins after its owner is gone", async () => {
		const live = versionServer(SHA_A);
		const deployment = `deploy:${live.url}@${SHA_A} field=commit`;
		const fx = await harness([ROW], {});
		expect(fx.classifyResult.isError).not.toBe(true);
		const prepared = await fx.prepare(ROW);
		expect(prepared).toBeDefined();
		expect(await fx.receive(artifactCell(ROW, [deployment]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		const done = await fx.done("p4", ROW);
		expect(done.isError).not.toBe(true);
		expect(statusOf(fx, ROW)).toBe("completed");
	});

	it("rejects a changed assigned source snapshot before probing the declared deployment", async () => {
		let hits = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				hits++;
				return Response.json({ commit: SHA_A });
			},
		});
		cleanups.push(() => server.stop(true));
		const deployment = `deploy:http://127.0.0.1:${server.port}/v1/version@${SHA_A} field=commit`;
		const fx = await harness([ROW], { deployment });
		await fx.prepare(ROW);
		const requirements = getLatestRequirements(fx.manager.getBranch());
		requirements[0]!.rawText += " changed";
		appendRequirementsSnapshot(
			{ appendEntry: (type, data) => fx.manager.appendCustomEntry(type, data) },
			requirements,
		);
		const before = hits;
		await fx.receive(artifactCell(ROW, [deployment]));
		expect(hits).toBe(before);
		expect(verdictOf(fx, ROW)).toBeUndefined();
		await fx.prepare(ROW);
		const beforeControl = hits;
		expect(await fx.receive(artifactCell(ROW, [deployment]))).toBeUndefined();
		expect(hits).toBe(beforeControl + 1);
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
	});

	it("P2 accepts typed file receipts for explicit resources in a non-Git skill directory", async () => {
		const skillDir = tempDir("omp-typed-skill-");
		const skill = path.join(skillDir, "SKILL.md");
		const helper = path.join(skillDir, "helper.md");
		fs.writeFileSync(skill, "# Release skill\nRun the checklist.\n");
		fs.writeFileSync(helper, "Helper notes for the release skill.\n");
		const identities = [fileId(skill), fileId(helper)];
		const fx = await harness([ROW], { resources: [skill, helper] });
		expect(fx.classifyResult.isError).not.toBe(true);
		const prepared = await fx.prepare(ROW);
		expect(containsText(prepared, artifactCell(ROW, identities))).toBe(true);
		expect(await fx.receive(artifactCell(ROW, identities))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		const done = await fx.done("p2", ROW);
		expect(done.isError).not.toBe(true);
		expect(statusOf(fx, ROW)).toBe("completed");
	});

	it("completes QA for a skill directory with linked Markdown and refuses a later link retarget", async () => {
		const root = tempDir("omp-linked-skill-");
		const skillDir = path.join(root, "skill");
		fs.mkdirSync(skillDir);
		fs.writeFileSync(path.join(root, "source.md"), "# Skill\n");
		fs.symlinkSync("../source.md", path.join(skillDir, "SKILL.md"));
		const captured = await currentRequirementIdentity({ kind: "file", path: skillDir });
		if ("error" in captured) throw new Error(captured.error);
		const receipt = artifactCell(ROW, [formatRequirementIdentity(captured.identity)]);
		const fx = await harness([ROW], { resources: [skillDir] });
		expect(fx.classifyResult.isError).not.toBe(true);
		expect(containsText(await fx.prepare(ROW), receipt)).toBe(true);
		expect(await fx.receive(receipt)).toBeUndefined();
		expect((await fx.done("linked-skill", ROW)).isError).not.toBe(true);
		expect(statusOf(fx, ROW)).toBe("completed");
		fs.unlinkSync(path.join(skillDir, "SKILL.md"));
		fs.symlinkSync("../other.md", path.join(skillDir, "SKILL.md"));
		const stale = await fx.done("retargeted-skill", ROW);
		expect(stale.isError).toBe(true);
		expect(textOf(stale)).toContain("stale file");
	});

	for (const changed of [false, true]) {
		it(`${changed ? "rejects changed" : "accepts fresh"} readback receipt without checkout mapping`, async () => {
			const receipt = path.join(tempDir("omp-production-receipt-"), "readback.json");
			fs.writeFileSync(receipt, JSON.stringify({ source: "litterbox cards readback", at: AT, rows: 8, open: 8 }));
			const identity = fileId(receipt);
			const row = "Curated news cards published to Litterbox";
			const fx = await harness([row], {}, { [row]: ["litterbox prod ingest"] });
			await fx.prepare(row);
			expect(await fx.receive(artifactCell(row, [identity]))).toBeUndefined();
			expect(verdictOf(fx, row)?.status).toBe("pass");
			if (changed) {
				fs.writeFileSync(receipt, JSON.stringify({ source: "litterbox cards readback", at: AT, rows: 7, open: 7 }));
			}
			const done = await fx.done("production-receipt", row);
			if (changed) {
				expect(done.isError).toBe(true);
				const text = textOf(done);
				expect(text).toContain("stale file");
				expect(text).toContain(identity.split("@sha256=")[1]!);
				expect(text).toContain(fileId(receipt).split("@sha256=")[1]!);
				expect(statusOf(fx, row)).toBe("pending");
			} else {
				expect(done.isError).not.toBe(true);
				expect(statusOf(fx, row)).toBe("completed");
			}
		});
	}

	it("P3 accepts a git receipt scoped to a listed path and ignores unrelated dirt in the same repo", async () => {
		const { root: repo, head } = await initRepo({
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 1;\n",
		});
		// Unrelated dirt: a dirty unlisted file and an untracked scratch file.
		fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 2;\n");
		fs.writeFileSync(path.join(repo, "scratch.txt"), "scratch\n");
		const identity = `git:${repo}@${head} paths=["src/a.ts"]`;
		const fx = await harness([ROW], { resources: [repo] });
		expect(fx.classifyResult.isError).not.toBe(true);
		const prepared = await fx.prepare(ROW);
		expect(prepared).toBeDefined();
		expect(await fx.receive(artifactCell(ROW, [identity]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		const done = await fx.done("p3", ROW);
		expect(done.isError).not.toBe(true);
		expect(statusOf(fx, ROW)).toBe("completed");
	}, 30_000);
});

describe("typed identity: artifact cell holds only the row-qualified identity", () => {
	it("rejects trailing prose after paths= but accepts the same cell with only the identity", async () => {
		const { root: repo, head } = await initRepo({
			"src/a.ts": "export const a = 1;\n",
		});
		const identity = `git:${repo}@${head} paths=["src/a.ts"]`;
		const fx = await harness([ROW], { resources: [repo] });
		expect(fx.classifyResult.isError).not.toBe(true);
		await fx.prepare(ROW);
		// 21:18 defect shape: prose appended after the typed identity makes the
		// `paths=` JSON suffix unparseable, so an otherwise passing audit is rejected.
		const proseCell = `${artifactCell(ROW, [identity])}. Repo HEAD is now ${head}; src/a.ts is unchanged.`;
		await fx.receive(proseCell);
		expect(verdictOf(fx, ROW)).toBeUndefined();
		await fx.prepare(ROW);
		expect(await fx.receive(artifactCell(ROW, [identity]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
	}, 30_000);
});

describe("typed identity: stale receipts block done with expected and observed values", () => {
	it("N1 blocks done after a listed git path changes and names the expected and observed Git blob IDs", async () => {
		const { root: repo, head } = await initRepo({
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 1;\n",
		});
		const aPath = path.join(repo, "src", "a.ts");
		const expectedBlob = blobIdOf(aPath);
		const identity = `git:${repo}@${head} paths=["src/a.ts"]`;
		const fx = await harness([ROW], { resources: [repo] });
		expect(fx.classifyResult.isError).not.toBe(true);
		await fx.prepare(ROW);
		expect(await fx.receive(artifactCell(ROW, [identity]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		// The audit stored a pass while the row is still pending: the listed bytes change before the first done.
		expect(statusOf(fx, ROW)).toBe("pending");
		fs.writeFileSync(aPath, "export const a = 2;\n");
		const observedBlob = blobIdOf(aPath);
		expect(observedBlob).not.toBe(expectedBlob);
		const done = await fx.done("n1-stale", ROW);
		expect(done.isError).toBe(true);
		const text = textOf(done);
		expect(text).toContain(expectedBlob);
		expect(text).toContain(observedBlob);
		expect(statusOf(fx, ROW)).toBe("pending");
	}, 30_000);
	it("keeps a whole-checkout receipt fresh after a persisted TODO schedule/evidence edit", async () => {
		const agentPrompt = fs.readFileSync(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url), "utf8");
		const { root: repo, head } = await initRepo({
			"src/a.ts": "export const a = 1;\n",
			".omp/agents/qa-auditor.md": agentPrompt,
		});
		const checkout = vcs.requireGit(repo);
		const fx = await harness([ROW], {}, {}, repo);
		expect(await checkout.isDirty()).toBe(false);
		expect(await checkout.headSha()).toBe(head);
		expect(fx.classifyResult.isError).not.toBe(true);
		const prepared = await fx.prepare(ROW);
		expect(containsText(prepared, head)).toBe(true);
		expect(await fx.receive(artifactCell(ROW, [head]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		fx.mutateSchedule(ROW);
		const done = await fx.done("schedule-edit", ROW);
		expect(done.isError).not.toBe(true);
		expect(statusOf(fx, ROW)).toBe("completed");
	}, 30_000);

	it("blocks a whole-checkout receipt after a new Git commit", async () => {
		const agentPrompt = fs.readFileSync(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url), "utf8");
		const { root: repo, head } = await initRepo({
			"src/a.ts": "export const a = 1;\n",
			".omp/agents/qa-auditor.md": agentPrompt,
		});
		const checkout = vcs.requireGit(repo);
		const fx = await harness([ROW], {}, {}, repo);
		expect(await checkout.isDirty()).toBe(false);
		expect(await checkout.headSha()).toBe(head);
		expect(fx.classifyResult.isError).not.toBe(true);
		const prepared = await fx.prepare(ROW);
		expect(containsText(prepared, head)).toBe(true);
		expect(await fx.receive(artifactCell(ROW, [head]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
		await checkout.stageFiles(["src/a.ts"]);
		await checkout.commitCreate("change audited checkout", {});
		const observed = await checkout.headSha();
		expect(observed).toBeDefined();
		expect(observed).not.toBe(head);
		const done = await fx.done("new-commit", ROW);
		expect(done.isError).toBe(true);
		expect(textOf(done)).toContain(head);
		expect(textOf(done)).toContain(observed!);
		expect(statusOf(fx, ROW)).toBe("pending");
	}, 30_000);

	it("N4 rejects a bare-SHA receipt for a typed declaration and names the own typed retry form", async () => {
		const skill = path.join(tempDir("omp-typed-retry-"), "SKILL.md");
		fs.writeFileSync(skill, "# Release skill\nRun the checklist.\n");
		const fx = await harness([ROW], { resources: [skill] });
		expect(fx.classifyResult.isError).not.toBe(true);
		await fx.prepare(ROW);
		const refusal = await fx.receive(SHA_A);
		const done = await fx.done("n4-bare-sha", ROW);
		expect(done.isError).toBe(true);
		const text = `${textOf(refusal)}\n${textOf(done)}`;
		expect(text).toContain(artifactCell(ROW, [fileId(skill)]));
		expect(text).not.toContain("saved TODO change");
		expect(statusOf(fx, ROW)).toBe("pending");
	});

	it("N2 blocks done after the live deploy version changes and names the expected and observed versions", async () => {
		const live = versionServer(SHA_A);
		const deployment = `deploy:${live.url}@${SHA_A} field=commit`;
		const fx = await harness([ROW], { deployment });
		expect(fx.classifyResult.isError).not.toBe(true);
		await fx.prepare(ROW);
		expect(await fx.receive(artifactCell(ROW, [deployment]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.status).toBe("pass");
		// The audit stored a pass while the row is still pending: the live version moves before the first done.
		expect(statusOf(fx, ROW)).toBe("pending");
		live.set(SHA_B);
		const done = await fx.done("n2-stale", ROW);
		expect(done.isError).toBe(true);
		const text = textOf(done);
		expect(text).toContain("deploy");
		expect(text).toContain(SHA_A);
		expect(text).toContain(SHA_B);
		expect(statusOf(fx, ROW)).toBe("pending");
	});

	/**
	 * One requirement linked to rows A and B with distinct declared file resources per row. The assignment is
	 * dispatched for A; each variant sends a receipt that differs from A's declaration.
	 */
	async function assignmentFixture() {
		const dirA = tempDir("omp-typed-assign-a-");
		const skillA = path.join(dirA, "SKILL.md");
		const helperA = path.join(dirA, "helper.md");
		fs.writeFileSync(skillA, "# Release skill A\nRun the checklist.\n");
		fs.writeFileSync(helperA, "Helper notes for release A.\n");
		const dirB = tempDir("omp-typed-assign-b-");
		const skillB = path.join(dirB, "SKILL.md");
		const helperB = path.join(dirB, "helper.md");
		fs.writeFileSync(skillB, "# Release skill B\nAnnounce the release.\n");
		fs.writeFileSync(helperB, "Helper notes for release B.\n");
		const idsA = [fileId(skillA), fileId(helperA)];
		const idsB = [fileId(skillB), fileId(helperB)];
		const fx = await harness([ROW, ROW_B], {}, { [ROW]: [skillA, helperA], [ROW_B]: [skillB, helperB] });
		expect(fx.classifyResult.isError).not.toBe(true);
		await fx.prepare(ROW);
		return { fx, idsA, idsB };
	}

	it("N3 rejects a foreign row label B for assignment A, stores no A pass, and names A's typed retry form", async () => {
		const { fx, idsA, idsB } = await assignmentFixture();
		const refusal = await fx.receive(artifactCell(ROW_B, idsB));
		const done = await fx.done("n3-foreign-row", ROW);
		expect(verdictOf(fx, ROW)).toBeUndefined();
		expect(statusOf(fx, ROW)).toBe("pending");
		expect(done.isError).toBe(true);
		expect(`${textOf(refusal)}\n${textOf(done)}`).toContain(artifactCell(ROW, idsA));
	});

	it("N3 rejects a receipt labeled A that names B's declared file, stores no A pass, and names A's typed retry form", async () => {
		const { fx, idsA, idsB } = await assignmentFixture();
		const refusal = await fx.receive(artifactCell(ROW, idsB));
		const done = await fx.done("n3-mislabeled", ROW);
		expect(verdictOf(fx, ROW)).toBeUndefined();
		expect(statusOf(fx, ROW)).toBe("pending");
		expect(done.isError).toBe(true);
		expect(`${textOf(refusal)}\n${textOf(done)}`).toContain(artifactCell(ROW, idsA));
	});

	it("accepts a row-bound bare Git commit through the declared-root probe and rejects its boundaries", async () => {
		const { root: repo, head } = await initRepo({ "artifact.txt": "audited\n" });
		const fx = await harness([ROW], { resources: [repo] });
		await fx.prepare(ROW);
		expect(await fx.receive(artifactCell(ROW, [head]))).toBeUndefined();
		expect(verdictOf(fx, ROW)?.artifact).toBe(artifactCell(ROW, [head]));
		await fx.prepare(ROW);
		const binaryEvidence = artifactCell(ROW, [head, `installed SHA-256 ${"a".repeat(64)}`]);
		expect(await fx.receive(binaryEvidence)).toBeUndefined();
		expect(verdictOf(fx, ROW)?.artifact).toBe(binaryEvidence);
		const authenticatedVerdict = verdictOf(fx, ROW);
		for (const artifact of [
			artifactCell(ROW, ["f".repeat(40)]),
			artifactCell(ROW_B, [head]),
			artifactCell(ROW, [head, "f".repeat(40)]),
			artifactCell(ROW, [head, head]),
		]) {
			await fx.prepare(ROW);
			expect(textOf(await fx.receive(artifact))).toContain("Blocked");
			expect(verdictOf(fx, ROW)).toEqual(authenticatedVerdict);
		}
		fs.writeFileSync(path.join(repo, "artifact.txt"), "dirty\n");
		await fx.prepare(ROW);
		expect(textOf(await fx.receive(artifactCell(ROW, [head])))).toContain("dirty");
		expect((await fx.done("bare-dirty", ROW)).isError).toBe(true);
		fs.writeFileSync(path.join(repo, "artifact.txt"), "audited\n");
		const file = path.join(tempDir("omp-bare-file-"), "artifact.txt");
		fs.writeFileSync(file, "file\n");
		const live = versionServer(SHA_A);
		for (const target of [
			{ resources: [repo, file] },
			{ resources: [file] },
			{ deployment: `deploy:${live.url}@${SHA_A} field=commit` },
		]) {
			const other = await harness([ROW], target);
			await other.prepare(ROW);
			expect(textOf(await other.receive(artifactCell(ROW, [head])))).toContain("Blocked");
		}
		fs.writeFileSync(path.join(repo, "artifact.txt"), "advanced\n");
		const gitRepo = vcs.requireGit(repo);
		await gitRepo.stageFiles(["artifact.txt"]);
		await gitRepo.commitCreate("advance audited artifact", {});
		await fx.prepare(ROW);
		expect(textOf(await fx.receive(artifactCell(ROW, [head])))).toContain("stale");
		expect((await fx.done("bare-moved", ROW)).isError).toBe(true);
		const advanced = await gitRepo.headSha();
		if (!advanced) throw new Error("advanced fixture has no commit");
		await fx.prepare(ROW);
		expect(await fx.receive(artifactCell(ROW, [advanced]))).toBeUndefined();
		expect((await fx.done("bare-clean", ROW)).isError).not.toBe(true);
	}, 30_000);
});
