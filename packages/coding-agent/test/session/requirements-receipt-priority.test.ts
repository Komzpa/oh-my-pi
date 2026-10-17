import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
	requirementSourceDigest,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import {
	getLatestTodoPhasesFromEntries,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import header from "../../src/prompts/session/requirements-ledger-receipt-header.md" with { type: "text" };
import liveTable from "../fixtures/qa-pipe-924-bare-table.txt" with { type: "text" };

const ROW = "Fix audit receipt rejecting foreign cited Rn in #41";
const OTHER_ROW = "Rebuild unrelated artifact";
const PUBLISH_ROW = "Publish the DCE evidence and standup intake PR";
const RAW42 = "[Image #1, 1568x1185] some red shit";
const RAW43 = "[Image #1, 1568x728] some more red shit again";
const LIVE_ARTIFACT = `row "${ROW}" @ cfd747275215622b5d3a7b9c488f82ef9028da77`;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(extra: "unlinked" | "different row" | "same row" | "shared publish" = "unlinked") {
	const root = mkdtempSync(join(tmpdir(), "omp-receipt-priority-"));
	roots.push(root);
	const file = join(root, "artifact.txt");
	writeFileSync(file, "current artifact\n");
	const identity = () => `file:${file}@sha256=${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
	mkdirSync(join(root, ".omp", "agents"), { recursive: true });
	writeFileSync(
		join(root, ".omp", "agents", "qa-auditor.md"),
		readFileSync(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url)),
	);
	const manager = SessionManager.inMemory(root);
	appendRequirementsSnapshot(
		{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
		createRequirementCandidates([], [RAW42, RAW43], "2026-10-12T06:34:37.830Z").map((requirement, index) => ({
			...requirement,
			id: index === 0 ? "R42" : "R43",
			classification: index === 0 || extra !== "unlinked" ? ("linked" as const) : ("not-a-requirement" as const),
			rows:
				extra === "shared publish"
					? [index === 0 ? ROW : OTHER_ROW, PUBLISH_ROW]
					: index === 0 || extra === "same row"
						? [ROW]
						: extra === "different row"
							? [OTHER_ROW]
							: [],
			...(index === 1 && extra === "unlinked" ? { reason: "No assigned deliverable" } : {}),
		})),
	);
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Work",
				tasks: (extra === "shared publish" ? [ROW, OTHER_ROW, PUBLISH_ROW] : [ROW, OTHER_ROW]).map(content => ({
					content,
					status: "pending",
					resources: [file],
					schedule: { owner: content === OTHER_ROW ? "OtherAudit" : "main", resources: [file] },
				})),
			},
		],
	});
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => root,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
	});
	const tool = new TodoTool({
		cwd: root,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		sessionManager: manager,
		getTodoPhases: () => getLatestTodoPhasesFromEntries(manager.getBranch()),
		setTodoPhases: (phases: TodoPhase[]) => manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases }),
	} as unknown as ToolSession);
	let call = 0;
	return {
		manager,
		runtime,
		tool,
		file,
		identity,
		verdict: (id = "R42", row = ROW) =>
			getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === id)?.rowVerdicts?.[row],
		async receive(output: string | ((auditInput: string) => string), requirementIds?: string[]) {
			const callId = `priority-${++call}`;
			const prepared = await runtime.prepareAuditorTaskCall("task", callId, {
				name: requirementIds ? `RetryAudit${call}` : "main",
				...(requirementIds ? { requirementIds } : {}),
				agent: "qa-auditor",
				task: `Audit R42 for ${JSON.stringify(ROW)}`,
				context: "",
			});
			if (!prepared || typeof prepared.task !== "string") throw new Error("Missing authenticated audit input");
			const receiptOutput = typeof output === "string" ? output : output(prepared.task);
			return runtime.afterToolCall({
				toolCall: { id: callId, name: "task" },
				result: {
					content: [],
					details: {
						results: [
							{
								index: 0,
								agent: "qa-auditor",
								id: `PriorityAuditor-${call}`,
								exitCode: 0,
								output: receiptOutput,
							},
						],
					},
				},
				isError: false,
			} as never);
		},
	};
}

function receipt(identity: string, status = "pass", extra = "", raw = RAW42, row = ROW): string {
	return `| ${header.trim()} |\n| --- | --- | --- | --- | --- |\n| R42 | ${requirementSourceDigest(raw)} | ${status} | inspected regex a\\|b | row "${row}" @ ${identity} |${extra ? `\n${extra}` : ""}`;
}

function refusalText(result: unknown): string {
	return JSON.stringify(result) ?? "";
}

describe("receipt priority #924: real runtime intake", () => {
	it("rejects an unbound renamed auditor before dispatch and permits an explicitly bound retry", async () => {
		const fx = setup();
		await expect(
			fx.runtime.prepareAuditorTaskCall("task", "unbound-retry", {
				name: "main-2",
				agent: "qa-auditor",
				task: `Audit R42 for ${JSON.stringify(ROW)}`,
			}),
		).rejects.toThrow("Set requirementIds");
		expect(fx.verdict()).toBeUndefined();
		await fx.receive(receipt(fx.identity()), ["R42"]);
		expect((await fx.tool.execute("bound-retry", { op: "done", task: ROW })).isError).not.toBe(true);
	});

	it("accepts a corrected explicitly scoped retry under a new worker name", async () => {
		const fx = setup();
		await fx.receive(receipt("invalid typed identity"));
		expect((await fx.tool.execute("old-receipt", { op: "done", task: ROW })).isError).toBe(true);
		await fx.receive(receipt(fx.identity()), ["R42"]);
		expect(fx.verdict()?.status).toBe("pass");
		expect(fx.verdict("R43")).toBeUndefined();
		expect((await fx.tool.execute("corrected-receipt", { op: "done", task: ROW })).isError).not.toBe(true);
	});

	for (const ids of [["R42"], ["R43"], ["R42", "R43"], undefined]) {
		it(`keeps ${ids?.join(",") ?? "implicit"} audit scope across a shared publish row`, async () => {
			const fx = setup("shared publish");
			const expectedIds = ids ?? ["R42", "R43"];
			const receiptRow = (id: string) => (id === "R42" ? ROW : ids ? OTHER_ROW : PUBLISH_ROW);
			expect(
				await fx.receive(auditInput => {
					for (const id of ["R42", "R43"]) {
						const assertion = expect(auditInput);
						if (expectedIds.includes(id)) assertion.toContain(`${id} (said at`);
						else assertion.not.toContain(`${id} (said at`);
					}
					return `| ${header.trim()} |\n| --- | --- | --- | --- | --- |\n${expectedIds
						.map(id => {
							const row = receiptRow(id);
							const raw = id === "R42" ? RAW42 : RAW43;
							return `| ${id} | ${requirementSourceDigest(raw)} | pass | inspected current file | row "${row}" @ ${fx.identity()} |`;
						})
						.join("\n")}`;
				}, ids),
			).toBeUndefined();
			for (const id of ["R42", "R43"]) {
				expect(fx.verdict(id, receiptRow(id))?.status).toBe(expectedIds.includes(id) ? "pass" : undefined);
				if (ids || id === "R42") expect(fx.verdict(id, PUBLISH_ROW)).toBeUndefined();
			}
			// Receipt scope does not remove the independent publication gate.
			expect((await fx.tool.execute("publish-without-audit", { op: "done", task: PUBLISH_ROW })).isError).toBe(true);
		});
	}

	it("rejects explicit unknown or unlinked scope before running an auditor", async () => {
		const fx = setup();
		for (const ids of [["R999"], ["R43"], []]) {
			await expect(fx.receive(receipt(fx.identity()), ids)).rejects.toThrow();
		}
		expect(fx.verdict()).toBeUndefined();
	});

	it("keeps artifact freshness checks for explicitly scoped retries", async () => {
		const fx = setup();
		const oldIdentity = fx.identity();
		writeFileSync(fx.file, "changed artifact\n");
		await fx.receive(receipt(oldIdentity), ["R42"]);
		expect(fx.verdict()?.status).not.toBe("pass");
		expect((await fx.tool.execute("stale-retry", { op: "done", task: ROW })).isError).toBe(true);
	});
	for (const extra of ["unlinked", "different row"] as const) {
		it(`records a newer same-artifact pass over an older fail and ignores ${extra} R43`, async () => {
			const fx = setup(extra);
			const artifact = fx.identity();
			// Runtime variant: only the R42 artifact cell is rebound to the real temporary file.
			// The unchanged byte-exact table is the independent parser consumer oracle.
			const current = liveTable.replace(LIVE_ARTIFACT, `row "${ROW}" @ ${artifact}`);
			expect(await fx.receive(current.replace("| pass |", "| fail |"))).toBeUndefined();
			expect(fx.verdict()?.status).toBe("fail");
			expect((await fx.tool.execute("blocked-old-fail", { op: "done", task: ROW })).isError).toBe(true);
			expect(await fx.receive(current)).toBeUndefined();
			expect(fx.verdict()?.status).toBe("pass");
			expect(fx.verdict()?.rawWords).toBe(RAW42);
			expect(fx.verdict()?.evidence).toContain('/^\\s*(?:(?:TODO|R[1-9]\\d*)\\s+)?row\\s+"\u2026"\\s*@/i');
			expect(fx.verdict("R43", extra === "different row" ? OTHER_ROW : ROW)).toBeUndefined();
			expect((await fx.tool.execute("done-new-pass", { op: "done", task: ROW })).isError).not.toBe(true);
		});
	}

	it("round-trips the canonical header rendered in the actual audit input through receipt intake", async () => {
		const fx = setup();
		expect(
			await fx.receive(auditInput => {
				const columns = /Return one complete Markdown table with columns ([^.]+)\./.exec(auditInput)?.[1];
				if (!columns) throw new Error("Rendered receipt header missing");
				const fields: Record<string, string> = {
					id: "R42",
					"source sha256": requirementSourceDigest(RAW42),
					verdict: "pass",
					evidence: "exercised current file",
					"artifact identity": `row "${ROW}" @ ${fx.identity()}`,
				};
				const names = columns.split("|").map(name => name.trim());
				return `| ${columns} |\n| ${names.map(() => "---").join(" | ")} |\n| ${names.map(name => fields[name]).join(" | ")} |`;
			}),
		).toBeUndefined();
		expect(fx.verdict()?.status).toBe("pass");
	});

	it("captures a real file identity, formats its labeled wire in dispatch, and accepts that exact wire at intake", async () => {
		const fx = setup();
		expect(
			await fx.receive(auditInput => {
				const prefix = `R42 row "${ROW}" @ `;
				const identityLine = auditInput.split("\n").find(line => line.startsWith(prefix));
				if (!identityLine) throw new Error("Captured file identity missing from audit dispatch");
				const capturedWire = identityLine.slice(prefix.length);
				expect(capturedWire).toBe(fx.identity());
				return receipt(capturedWire);
			}),
		).toBeUndefined();
		expect(fx.verdict()?.artifact).toBe(`row "${ROW}" @ ${fx.identity()}`);
		expect((await fx.tool.execute("done-captured-wire", { op: "done", task: ROW })).isError).not.toBe(true);
	});

	for (const defect of [
		"unlabeled digest",
		"short digest",
		"nonhex digest",
		"wrong label",
		"file attribute",
	] as const) {
		it(`rejects ${defect} without replacing an authenticated file verdict`, async () => {
			const fx = setup();
			const identity = fx.identity();
			expect(await fx.receive(receipt(identity, "fail"))).toBeUndefined();
			const prior = fx.verdict();
			let malformed = identity;
			if (defect === "unlabeled digest") malformed = identity.replace("@sha256=", "@");
			if (defect === "short digest") malformed = identity.slice(0, -1);
			if (defect === "nonhex digest") malformed = `${identity.slice(0, -1)}z`;
			if (defect === "wrong label") malformed = identity.replace("@sha256=", "@SHA256=");
			if (defect === "file attribute") malformed = `${identity} paths=["artifact.txt"]`;
			expect(refusalText(await fx.receive(receipt(malformed)))).toContain("Blocked");
			expect(fx.verdict()).toEqual(prior);
		});
	}

	it("assigns and records additional R43 only on the same TODO row, not its foreign linked sibling", async () => {
		const fx = setup("same row");
		// R43 also links a sibling row, but that sibling must not enter this assignment.
		appendRequirementsSnapshot(
			{ appendEntry: (type, data) => fx.manager.appendCustomEntry(type, data) },
			getLatestRequirements(fx.manager.getBranch()).map(requirement =>
				requirement.id === "R43" ? { ...requirement, rows: [ROW, OTHER_ROW] } : requirement,
			),
		);
		const artifact = fx.identity();
		const current = liveTable
			.replace(LIVE_ARTIFACT, `row "${ROW}" @ ${artifact}`)
			.replace("| no linked row |", `| row "${ROW}" @ ${artifact} |`);
		expect(await fx.receive(current)).toBeUndefined();
		expect(fx.verdict()?.status).toBe("pass");
		expect(fx.verdict("R43")?.status).toBe("unverifiable");
		expect(fx.verdict("R43", OTHER_ROW)).toBeUndefined();
		expect((await fx.tool.execute("blocked-r43", { op: "done", task: ROW })).isError).toBe(true);
	});

	for (const defect of [
		"missing",
		"duplicate",
		"wrong row",
		"changed identity",
		"malformed verdict",
		"suffix",
	] as const) {
		it(`refuses ${defect} requested receipt without erasing the prior fail`, async () => {
			const fx = setup();
			const artifact = fx.identity();
			expect(await fx.receive(receipt(artifact, "fail"))).toBeUndefined();
			const prior = fx.verdict();
			let output = receipt(artifact);
			if (defect === "missing") output = output.replace(/\n\| R42 \|[^\n]*/, "");
			if (defect === "duplicate") output += `\n${output.split("\n")[2]}`;
			if (defect === "wrong row") output = receipt(artifact, "pass", "", RAW42, OTHER_ROW);
			if (defect === "changed identity") writeFileSync(fx.file, "changed artifact\n");
			if (defect === "malformed verdict") output = receipt(artifact, "approved");
			if (defect === "suffix")
				output += `\n| R42a | ${requirementSourceDigest(RAW42)} | pass | inspected | row "${ROW}" @ ${artifact} |`;
			const result = await fx.receive(output);
			expect(refusalText(result)).toContain("Blocked");
			expect(fx.verdict()).toEqual(prior);
		});
	}

	it("does not let an older artifact pass overwrite a newer artifact fail", async () => {
		const fx = setup();
		const old = fx.identity();
		writeFileSync(fx.file, "newer artifact\n");
		expect(await fx.receive(receipt(fx.identity(), "fail"))).toBeUndefined();
		const newerFail = fx.verdict();
		expect(refusalText(await fx.receive(receipt(old)))).toContain("Blocked");
		expect(fx.verdict()).toEqual(newerFail);
	});

	it("keeps a typed file receipt fresh across schedule-only metadata edits", async () => {
		const fx = setup();
		expect(await fx.receive(receipt(fx.identity()))).toBeUndefined();
		const phases = getLatestTodoPhasesFromEntries(fx.manager.getBranch());
		const task = phases.flatMap(phase => phase.tasks).find(task => task.content === ROW)!;
		Object.assign(task, {
			notes: "scope reviewed",
			schedule: { owner: "main", resources: [fx.file], estimate: 25, evidence: "schedule-review" },
		});
		fx.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		expect((await fx.tool.execute("done-after-metadata", { op: "done", task: ROW })).isError).not.toBe(true);
	});
});
