import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ToolSession } from "../../src/tools";
import { SessionManager } from "../../src/session/session-manager";
import { RequirementsLedgerRuntime } from "../../src/session/requirements-ledger-runtime";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
	parseRequirementCollateral,
	collateralFollowUpRow,
} from "../../src/tools/requirements-ledger";
import { getLatestTodoPhasesFromEntries, TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import { requirementAuditReadImage, requirementTouchesRenderedFiles } from "../../src/utils/requirement-artifact";
import qaAuditorPrompt from "../../src/prompts/agents/qa-auditor.md" with { type: "text" };

const ROW = "Merge overlapping UPS decisions into one UPS decision";
const DEFECT = "Group headers are indistinguishable from data rows";
const SECOND = "Dividers appear on only some sibling rows";
const HEADER = "| id | verdict | evidence | artifact identity |\n| --- | --- | --- | --- |";

async function fixture(gitArtifact: "ui" | "cli" | undefined = undefined) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collateral-"));
	await Bun.write(path.join(cwd, ".omp/agents/qa-auditor.md"), qaAuditorPrompt);
	const artifact = path.join(cwd, "artifact.txt");
	await Bun.write(artifact, "audited artifact");
	const sha = new Bun.CryptoHasher("sha256").update("audited artifact").digest("hex");
	const screenshot = path.join(cwd, "after-power-group-1568.png");
	await Bun.write(
		screenshot,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=",
			"base64",
		),
	);
	let identity = `file:${artifact}@sha256=${sha}`;
	if (gitArtifact) {
		await $`git init --initial-branch=main ${cwd}`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m base`.quiet();
		if (gitArtifact === "ui") await Bun.write(path.join(cwd, "Facility.tsx"), "export const Facility = <div />;");
		await $`git -C ${cwd} add artifact.txt .omp`.quiet();
		if (gitArtifact === "ui") await $`git -C ${cwd} add Facility.tsx`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit -m artifact`.quiet();
		const commit = (await $`git -C ${cwd} rev-parse HEAD`.quiet()).text().trim();
		identity = `git:${cwd}@${commit}`;
		await fs.rm(screenshot); // screenshots must not dirty a whole-checkout identity
	}
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Work",
				tasks: [
					{
						content: ROW,
						status: "pending",
						schedule: { owner: "main", resources: [gitArtifact ? cwd : artifact] },
					},
				],
			},
		],
	});
	appendRequirementsSnapshot(
		{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
		createRequirementCandidates(
			[],
			["merge UPS decisions", "show sourced UPS ratings"],
			"2026-11-03T00:00:00.000Z",
		).map((item, i) => ({ ...item, id: `R${98 + i}`, classification: "linked", rows: [ROW] })),
	);
	const runtime = new RequirementsLedgerRuntime({
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
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
	const table = (evidence = screenshot) =>
		`${HEADER}\n${[98, 99].map(id => `| R${id} | pass | Observed ${evidence} | row ${JSON.stringify(ROW)} @ ${identity} |`).join("\n")}`;
	let attempt = 0;
	const audit = async (output: string) => {
		const id = `AuditSingleUps-${++attempt}`;
		await runtime.prepareAuditorTaskCall("task", id, {
			name: "main",
			agent: "qa-auditor",
			requirementIds: ["R98", "R99"],
			task: `Audit R98 R99 for ${ROW}`,
		});
		return runtime.afterToolCall({
			toolCall: { id, name: "task" },
			result: { content: [], details: { results: [{ index: 0, agent: "qa-auditor", id, exitCode: 0, output }] } },
			isError: false,
		} as never);
	};
	return { cwd, manager, tool, table, audit, screenshot };
}

describe("collateral receipt grammar", () => {
	it("parses defects with escaped pipes and a no-defect declaration", () => {
		const text = `${HEADER}\n| R1 | pass | exercised | artifact |\n\n| screenshot | region | defect |\n| --- | --- | --- |\n| /tmp/a.png | Power | Grid \\| Solar overlap |`;
		expect(parseRequirementCollateral(text)?.defects).toEqual([
			{ screenshot: "/tmp/a.png", region: "Power", defect: "Grid | Solar overlap" },
		]);
		expect(parseRequirementCollateral(`${HEADER}\n\nCollateral: none\n- /tmp/a.png`)?.defects).toEqual([]);
		expect(parseRequirementCollateral(JSON.stringify({ result: text }))?.defects[0]?.region).toBe("Power");
	});
	it("rejects empty, malformed, duplicate, and misplaced sections", () => {
		for (const section of [
			"Collateral: none",
			"| screenshot | region | defect |\n| --- | --- | --- |",
			"| screenshot | region | defect |\n| --- | --- | --- |\n| a.png | region | |",
			"Collateral: none\n- a.png\n\nCollateral: none\n- b.png",
		]) {
			expect(() => parseRequirementCollateral(`${HEADER}\n\n${section}`)).toThrow();
		}
		expect(() => parseRequirementCollateral(`Collateral: none\n- a.png\n\n${HEADER}`)).toThrow(
			"follow the verdict table",
		);
	});
});

it("rejects AuditSingleUps-shaped all-pass receipts naming an existing screenshot without collateral", async () => {
	const f = await fixture();
	try {
		const result = await f.audit(f.table());
		expect(JSON.stringify(result)).toContain("missing collateral section for rendered UI audit");
		for (const requirement of getLatestRequirements(f.manager.getBranch()))
			expect(requirement.rowVerdicts).toBeUndefined();
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("keeps non-UI audits unaffected even when their prose mentions visual UI", async () => {
	const f = await fixture();
	try {
		expect(await f.audit(f.table("CLI visual UI diagnostic, no image read"))).toBeUndefined();
		const done = await f.tool.execute("done", { op: "done", task: ROW });
		expect(done.isError).not.toBe(true);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("accepts Collateral: none and rejects a nonexistent inspected path", async () => {
	const f = await fixture();
	try {
		expect(JSON.stringify(await f.audit(`${f.table()}\n\nCollateral: none\n- /missing/capture.png`))).toContain(
			"collateral screenshot does not exist",
		);
		expect(await f.audit(`${f.table()}\n\nCollateral: none\n- ${f.screenshot}`)).toBeUndefined();
		expect((await f.tool.execute("done", { op: "done", task: ROW })).isError).not.toBe(true);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("persists collateral, blocks closure, requires a linked follow-up for every defect, and allows re-audit", async () => {
	const f = await fixture();
	try {
		const defects = `${f.table()}\n\n| screenshot | region | defect |\n| --- | --- | --- |\n| ${f.screenshot} | Power | ${DEFECT} |\n| ${f.screenshot} | Power | ${SECOND} |`;
		expect(await f.audit(defects)).toBeUndefined();
		expect(getLatestRequirements(f.manager.getBranch())[0]?.rowVerdicts?.[ROW]?.collateral?.defects).toHaveLength(2);
		const done = () => f.tool.execute("done", { op: "done", task: ROW });
		expect(JSON.stringify(await done())).toContain("collateral defects block closure");
		const phases = getLatestTodoPhasesFromEntries(f.manager.getBranch());
		phases[0]!.tasks.push({ content: collateralFollowUpRow(ROW, DEFECT), status: "pending" });
		f.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		expect((await done()).isError).toBe(true);
		phases[0]!.tasks.push({ content: collateralFollowUpRow(ROW, SECOND), status: "pending" });
		f.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		expect((await done()).isError).not.toBe(true);
		// Re-audit clears the findings rather than retaining an old failure forever.
		expect(await f.audit(`${f.table()}\n\nCollateral: none\n- ${f.screenshot}`)).toBeUndefined();
		expect(getLatestRequirements(f.manager.getBranch())[0]?.rowVerdicts?.[ROW]?.collateral?.defects).toEqual([]);
		const cleared = getLatestTodoPhasesFromEntries(f.manager.getBranch());
		cleared[0]!.tasks = cleared[0]!.tasks.filter(task => task.content === ROW);
		f.manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: cleared });
		expect((await done()).isError).not.toBe(true);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("uses Git diff paths and the worker's image results as independent visual signals", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rendered-diff-"));
	try {
		await $`git init --initial-branch=main ${cwd}`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m base`.quiet();
		await Bun.write(path.join(cwd, "Facility.tsx"), "export const Facility = <div />;");
		await $`git -C ${cwd} add Facility.tsx`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit -m UI`.quiet();
		const commit = (await $`git -C ${cwd} rev-parse HEAD`.quiet()).text().trim();
		expect(await requirementTouchesRenderedFiles([{ kind: "git", repo: cwd, commit }])).toBe(true);
		expect(await requirementTouchesRenderedFiles([{ kind: "git", repo: cwd, commit, paths: ["backend.txt"] }])).toBe(
			false,
		);
		const history = path.join(cwd, "AuditSingleUps.jsonl");
		await Bun.write(
			history,
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "screenshot.png" }] },
			}) + "\n",
		);
		expect(await requirementAuditReadImage(history)).toBe(false);
		await Bun.write(
			history,
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
				},
			}) + "\n",
		);
		expect(await requirementAuditReadImage(history)).toBe(true);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

it("rejects a missing collateral section when only the auditor's tool history reveals an image read", async () => {
	const f = await fixture();
	const directory = spyOn(f.manager, "getArtifactsDir").mockReturnValue(f.cwd);
	try {
		await Bun.write(
			path.join(f.cwd, "AuditSingleUps-1.jsonl"),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
				},
			}) + "\n",
		);
		expect(JSON.stringify(await f.audit(f.table("exercised artifact")))).toContain("missing collateral section");
	} finally {
		directory.mockRestore();
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it.each(["ui", "cli"] as const)(
	"gates a %s Git artifact from its changed paths without screenshot evidence",
	async kind => {
		const f = await fixture(kind);
		try {
			const result = await f.audit(f.table("exercised artifact"));
			if (kind === "ui") expect(JSON.stringify(result)).toContain("missing collateral section");
			else expect(result).toBeUndefined();
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	},
);
