import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { ToolSession } from "../../src/tools";
import { SessionManager } from "../../src/session/session-manager";
import {
	RequirementsLedgerRuntime,
	type RequirementsLedgerRuntimeHost,
} from "../../src/session/requirements-ledger-runtime";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
	parseRequirementCollateral,
	collateralFollowUpRow,
} from "../../src/tools/requirements-ledger";
import { getLatestTodoPhasesFromEntries, TodoTool, USER_TODO_EDIT_CUSTOM_TYPE } from "../../src/tools/todo";
import {
	requirementArtifactBase,
	requirementAuditReadImage,
	requirementTouchesRenderedFiles,
} from "../../src/utils/requirement-artifact";
import { useFastGitStatusCoordinator } from "../helpers/fast-status-coordinator";
import qaAuditorPrompt from "../../src/prompts/agents/qa-auditor.md" with { type: "text" };

useFastGitStatusCoordinator();

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
	const before = path.join(cwd, "before-power-group-1568.png");
	await Bun.write(
		before,
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
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
		await fs.rm(screenshot);
		await fs.rm(before); // screenshots must not dirty a whole-checkout identity
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
	const host: RequirementsLedgerRuntimeHost = {
		agent: {} as never,
		agentKind: () => "main",
		cwd: () => cwd,
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
	};
	let runtime = new RequirementsLedgerRuntime(host);
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
	let lastTask: { task: string } | undefined;
	const historyDirectory = gitArtifact ? path.join(cwd, ".git/audits") : cwd;
	spyOn(manager, "getArtifactsDir").mockReturnValue(historyDirectory);
	const audit = async (
		output: string,
		activity:
			| "capture"
			| "read"
			| "touch"
			| "none"
			| "failed"
			| "old"
			| "output"
			| "computed"
			| "computed-start"
			| "computed-end"
			| "outside-named"
			| "outside" = "capture",
		stale = false,
		resume = false,
	) => {
		const id = `AuditSingleUps-${++attempt}`;
		const prepared = await runtime.prepareAuditorTaskCall("task", id, {
			name: "main",
			agent: "qa-auditor",
			requirementIds: ["R98", "R99"],
			task: `Audit R98 R99 for ${ROW}`,
		});
		lastTask = prepared as { task: string };
		const paths = [before, screenshot, path.join(cwd, "copy.png")];
		const now = new Date();
		for (const file of paths) {
			if (!(await Bun.file(file).exists())) continue;
			if (!["touch", "none", "read"].includes(activity)) await Bun.write(file, await Bun.file(file).bytes());
			const at = stale
				? new Date(0)
				: new Date(
						now.getTime() + (activity.startsWith("outside") ? 20000 : activity.startsWith("computed") ? 5000 : 0),
					);
			await fs.utimes(file, at, at);
		}
		if (activity !== "none") {
			const timestamp = (activity === "old" ? new Date(0) : now).toISOString();
			const toolName = activity === "read" ? "read" : "bash";
			const command = ["computed", "computed-start", "computed-end", "outside"].includes(activity)
				? `python -c 'from pathlib import Path; out=Path("${cwd}"); [capture(out/f"{kind}-power-group-1568.png") for kind in ["before", "after"]]'`
				: activity === "output"
					? "./capture.sh"
					: activity === "touch"
						? `touch ${paths.join(" ")}`
						: `bun -e 'await page.screenshot({path: "${before}"}); await page.screenshot({path: "${screenshot}"});' ${paths[2]}`;
			await Bun.write(
				path.join(historyDirectory, `${id}.jsonl`),
				[
					{
						timestamp,
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "capture", name: toolName, arguments: { command } }],
						},
					},
					...(["computed-start", "computed-end"].includes(activity)
						? [
								{
									customType: "tool_execution_start",
									timestamp: new Date(now.getTime() + 3000).toISOString(),
									data: { toolCallId: "capture", toolName, args: { command } },
								},
							]
						: []),
					{
						timestamp: ["computed", "computed-start", "computed-end", "outside", "outside-named"].includes(
							activity,
						)
							? new Date(now.getTime() + 9000).toISOString()
							: timestamp,
						...(activity === "computed-end"
							? {
									customType: "tool_execution_end",
									data: { toolCallId: "capture", toolName, isError: false, result: { content: [] } },
								}
							: {
									message: {
										role: "toolResult",
										toolCallId: "capture",
										toolName,
										isError: activity === "failed",
										content: [{ type: "text", text: activity === "output" ? paths.join("\n") : "ok" }],
									},
								}),
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n") + "\n",
			);
		}
		if (resume) {
			await runtime.afterToolCall({
				toolCall: { id, name: "task" },
				result: { content: [], details: { progress: [{ index: 0, agent: "qa-auditor", id }] } },
				isError: false,
			} as never);
			runtime = new RequirementsLedgerRuntime(host);
			await runtime.afterToolCall({
				toolCall: { id: "wait", name: "wait" },
				result: {
					content: [
						{
							type: "text",
							text: `<task-result id="${id}" agent="qa-auditor" status="completed">\n<output>\n${output}\n</output>\n</task-result>`,
						},
					],
				},
				isError: false,
			} as never);
			return undefined;
		}
		return runtime.afterToolCall({
			toolCall: { id, name: "task" },
			result: { content: [], details: { results: [{ index: 0, agent: "qa-auditor", id, exitCode: 0, output }] } },
			isError: false,
		} as never);
	};
	return {
		cwd,
		manager,
		tool,
		table,
		audit,
		screenshot,
		before,
		get lastTask() {
			return lastTask;
		},
	};
}

describe("collateral receipt grammar", () => {
	it("parses paired defects with escaped pipes and clean pairs", () => {
		const text = `${HEADER}\n| R1 | pass | exercised | artifact |\n\n| before | after | region | defect |\n| --- | --- | --- | --- |\n| /tmp/b.png | /tmp/a.png | Power | Grid \\| Solar overlap |`;
		expect(parseRequirementCollateral(text)?.defects).toEqual([
			{ screenshot: "/tmp/a.png", region: "Power", defect: "Grid | Solar overlap" },
		]);
		expect(
			parseRequirementCollateral(
				`${HEADER}\n\n| before | after | region | defect |\n| --- | --- | --- | --- |\n| /tmp/b.png | /tmp/a.png | Power | none |`,
			)?.defects,
		).toEqual([]);
		expect(parseRequirementCollateral(JSON.stringify({ result: text }))?.defects[0]?.region).toBe("Power");
	});
	it("rejects empty, malformed, duplicate, and misplaced sections", () => {
		for (const section of [
			"Collateral: none",
			"| before | after | region | defect |\n| --- | --- | --- |",
			"| before | after | region | defect |\n| --- | --- | --- |\n| a.png | region | |",
			"| before | after | region | defect |\n| --- | --- | --- | --- |\n| b.png | a.png | Power | none |\n\n| before | after | region | defect |\n| --- | --- | --- | --- |\n| b.png | a.png | Power | none |",
		]) {
			expect(() => parseRequirementCollateral(`${HEADER}\n\n${section}`)).toThrow();
		}
		expect(() =>
			parseRequirementCollateral(
				`| before | after | region | defect |\n| --- | --- | --- | --- |\n| b.png | a.png | Power | none |\n\n${HEADER}`,
			),
		).toThrow("follow the verdict table");
	});
});

it("rejects AuditSingleUps-shaped all-pass receipts naming an existing screenshot without collateral", async () => {
	const f = await fixture();
	try {
		const result = await f.audit(f.table());
		expect(JSON.stringify(result)).toContain("missing collateral pair for rendered UI audit");
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

const pair = (before: string, after: string, defect = "none") =>
	`| before | after | region | defect |\n| --- | --- | --- | --- |\n| ${before} | ${after} | Power | ${defect} |`;

it("accepts a distinct pair and rejects nonexistent paths, missing before, and identical bytes", async () => {
	const f = await fixture();
	try {
		expect(JSON.stringify(await f.audit(`${f.table()}\n\n${pair("/missing/capture.png", f.screenshot)}`))).toContain(
			"does not exist or cannot be read",
		);
		expect(JSON.stringify(await f.audit(`${f.table()}\n\n${pair("", f.screenshot)}`))).toContain(
			"requires before, after",
		);
		const copy = path.join(f.cwd, "copy.png");
		await Bun.write(copy, await Bun.file(f.screenshot).bytes());
		expect(JSON.stringify(await f.audit(`${f.table()}\n\n${pair(copy, f.screenshot)}`))).toContain(
			"byte-identical (sha256)",
		);
		expect(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`)).toBeUndefined();
		expect((await f.tool.execute("done", { op: "done", task: ROW })).isError).not.toBe(true);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("rejects RackTilesQA recycled report images even with an all-pass paired receipt", async () => {
	const f = await fixture();
	try {
		const report = path.join(f.cwd, "playwright-report/data/rack.png");
		await Bun.write(report, await Bun.file(f.screenshot).bytes());
		for (const file of [f.before, report]) await fs.utimes(file, new Date(0), new Date(0));
		const output = `${f.table(`aligned specification rows ${report}`)}\n\n${pair(f.before, report)}`;
		expect(JSON.stringify(await f.audit(output, "read", true))).toContain("capture your own before/after");
		for (const requirement of getLatestRequirements(f.manager.getBranch()))
			expect(requirement.rowVerdicts).toBeUndefined();
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it.each(["none", "read", "failed", "old"] as const)(
	"rejects fresh files without successful current auditor activity: %s",
	async activity => {
		const f = await fixture();
		try {
			expect(JSON.stringify(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, activity))).toContain(
				"lacks auditor activity after task start",
			);
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	},
);

it("rejects old mtimes even when a successful auditor call names both paths", async () => {
	const f = await fixture();
	try {
		expect(
			JSON.stringify(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, "capture", true)),
		).toContain("lacks auditor activity after task start");
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("accepts paths reported by the auditor's successful capture output", async () => {
	const f = await fixture();
	try {
		expect(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, "output")).toBeUndefined();
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it.each(["computed", "computed-start", "computed-end"] as const)(
	"accepts ReauditCooling captures built in Python within a successful call window: %s",
	async activity => {
		const f = await fixture();
		try {
			expect(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, activity)).toBeUndefined();
			expect((await f.tool.execute("done", { op: "done", task: ROW })).isError).not.toBe(true);
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	},
);

it.each(["outside", "outside-named"] as const)(
	"rejects a file written during the audit outside every successful auditor call window: %s",
	async activity => {
		const f = await fixture();
		try {
			expect(JSON.stringify(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, activity))).toContain(
				"lacks auditor activity after task start",
			);
			expect((await f.tool.execute("done", { op: "done", task: ROW })).isError).toBe(true);
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	},
);

it("tells the lead to re-audit with absolute collateral paths for report shorthand", async () => {
	const f = await fixture();
	try {
		const result = JSON.stringify(
			await f.audit(`${f.table()}\n\n${pair("L/crops/before-1440-panel-crop.png", f.screenshot)}`),
		);
		expect(result).toContain("relative or shorthand");
		expect(result).toContain("re-audit and use absolute paths in the collateral table");
		expect((await f.tool.execute("done", { op: "done", task: ROW })).isError).toBe(true);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("retains capture provenance across an async auditor handoff and runtime resume", async () => {
	const f = await fixture();
	try {
		await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, "capture", false, true);
		for (const requirement of getLatestRequirements(f.manager.getBranch()))
			expect(requirement.rowVerdicts?.[ROW]?.status).toBe("pass");
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("accepts own touch activity: provenance does not interpret arbitrary shell capture semantics", async () => {
	const f = await fixture();
	try {
		for (const file of [f.before, f.screenshot]) await fs.utimes(file, new Date(0), new Date(0));
		expect(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`, "touch")).toBeUndefined();
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("accepts and retains an unbuildable-base reason only with an explicit matching declaration", async () => {
	const f = await fixture();
	try {
		const reason = "bun run build: missing base entry point";
		const section = pair(`before: unavailable (${reason})`, f.screenshot);
		expect(JSON.stringify(await f.audit(`${f.table()}\n\n${section}`))).toContain(
			"requires a matching Base: unbuildable",
		);
		expect(await f.audit(`${f.table()}\n\nBase: unbuildable (${reason})\n${section}`)).toBeUndefined();
		const saved = getLatestRequirements(f.manager.getBranch())[0]?.rowVerdicts?.[ROW]?.collateral;
		expect(saved?.baseUnbuildable).toBe(reason);
		expect(getLatestRequirements(f.manager.getBranch())[0]?.rowVerdicts?.[ROW]?.evidence).toContain(
			`Before comparison unavailable: base unbuildable (${reason})`,
		);
		expect(saved?.pairs?.[0]?.beforeUnavailable).toBe(reason);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("rejects the AuditSingleUps after-only collateral replay", async () => {
	const f = await fixture();
	try {
		expect(JSON.stringify(await f.audit(`${f.table()}\n\nCollateral: none\n- ${f.screenshot}`))).toContain(
			"after-only collateral is not a comparison",
		);
	} finally {
		await fs.rm(f.cwd, { recursive: true, force: true });
	}
});

it("persists collateral, blocks closure, requires a linked follow-up for every defect, and allows re-audit", async () => {
	const f = await fixture();
	try {
		const defects = `${f.table()}\n\n${pair(f.before, f.screenshot, DEFECT)}\n| ${f.before} | ${f.screenshot} | Power | ${SECOND} |`;
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
		expect(await f.audit(`${f.table()}\n\n${pair(f.before, f.screenshot)}`)).toBeUndefined();
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
		expect((await requirementArtifactBase({ kind: "git", repo: cwd, commit })).base).toBe(
			(await $`git -C ${cwd} rev-parse HEAD^`.quiet()).text().trim(),
		);
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

it("rejects a missing collateral pair when only the auditor's tool history reveals an image read", async () => {
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
		expect(JSON.stringify(await f.audit(f.table("exercised artifact"), "none"))).toContain("missing collateral pair");
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
			const base = (await $`git -C ${f.cwd} rev-parse HEAD^`.quiet()).text().trim();
			expect(f.lastTask?.task).toContain(`base=${base}`);
			if (kind === "ui") expect(JSON.stringify(result)).toContain("missing collateral pair");
			else expect(result).toBeUndefined();
		} finally {
			await fs.rm(f.cwd, { recursive: true, force: true });
		}
	},
);

it("uses the default-branch merge base for a multi-commit artifact and resolves tree pins to the same base", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-comparison-base-"));
	try {
		await $`git init --initial-branch=main ${cwd}`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -m base`.quiet();
		const base = (await $`git -C ${cwd} rev-parse HEAD`.quiet()).text().trim();
		await $`git -C ${cwd} update-ref refs/remotes/origin/main ${base}`.quiet();
		await $`git -C ${cwd} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`.quiet();
		await $`git -C ${cwd} switch -c feature`.quiet();
		await Bun.write(path.join(cwd, "View.tsx"), "export const View = <div />;");
		await $`git -C ${cwd} add View.tsx`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit -m UI`.quiet();
		await Bun.write(path.join(cwd, "backend.txt"), "backend change");
		await $`git -C ${cwd} add backend.txt`.quiet();
		await $`git -C ${cwd} -c user.name=Test -c user.email=test@example.invalid commit -m backend`.quiet();
		const commit = (await $`git -C ${cwd} rev-parse HEAD`.quiet()).text().trim();
		const tree = (await $`git -C ${cwd} rev-parse 'HEAD^{tree}'`.quiet()).text().trim();
		for (const pin of [commit, tree]) {
			const identity = { kind: "git" as const, repo: cwd, commit: pin };
			expect(await requirementArtifactBase(identity)).toEqual({ revision: commit, base });
			// Parent-only comparison would miss the rendered change from the first commit.
			expect(await requirementTouchesRenderedFiles([identity])).toBe(true);
		}
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
