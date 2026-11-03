import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import agentRouter, { createRouterState, routeSubagentSpawn } from "./agent_router";
import { heavyTestRefusal, probeHostTestResources, ramThresholdGiB, uncoveredWriteTargets } from "./dispatch_preflight";

const cwd = "/project";
const context = {
	cwd,
	getAsyncJobSnapshot: () => ({ running: [], recent: [], delivery: {} }),
} as unknown as ExtensionContext;
const mismatch =
	"ROOT=/project\nWrite roots: src/slides/r14/, src/charts/\nChange src/r14/slides/s05.jsx and src/charts/cohorts.ts.";

describe("dispatch preflight", () => {
	test("registered spawn hook probes heavy briefs before recording or spawning, while ordinary dispatch stays synchronous", async () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
		let probes = 0;
		agentRouter(
			{
				on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
					handlers.set(name, handler),
			} as unknown as ExtensionAPI,
			{
				meminfo: async () => {
					probes++;
					return "MemAvailable: 1024 kB\n";
				},
				processes: async () => [],
			},
		);
		const hook = handlers.get("before_subagent_spawn")!;
		// Missing agent is admitted without a spawn record or touching the live state file.
		expect(hook({}, context)).toBeUndefined();
		expect(probes).toBe(0);
		expect(await hook({ agent: "gate-runner", assignment: "Run e2e" }, context)).toMatchObject({
			block: true,
			reason: expect.stringContaining("MemAvailable="),
		});
		expect(probes).toBe(1);
	});

	test("refuses named change targets outside the roots, retaining path boundaries and ROOT resolution", () => {
		expect(uncoveredWriteTargets(mismatch, "/elsewhere", "ui-coder")).toEqual(["/project/src/r14/slides/s05.jsx"]);
		expect(uncoveredWriteTargets("Write only /project/src/\nUpdate /project/src-other/a.ts", cwd, "coder")).toEqual([
			"/project/src-other/a.ts",
		]);
		expect(uncoveredWriteTargets("Write only /project/a.ts. Fix /project/b.ts.", cwd, "coder")).toEqual([
			"/project/b.ts",
		]);
		expect(uncoveredWriteTargets("Write /project/a.ts\nFix /project/b.ts", cwd, "coder")).toEqual(["/project/b.ts"]);
		expect(
			uncoveredWriteTargets("Write only src/\nFiles to change:\n- config.yaml\n- src/valid.ts", cwd, "coder"),
		).toEqual(["/project/config.yaml"]);
		expect(uncoveredWriteTargets("Worktree: /other\nChange /project/a.ts", cwd, "coder")).toEqual(["/project/a.ts"]);
	});

	test("admits covered targets, missing roots, references, and all read-only roles", () => {
		expect(
			uncoveredWriteTargets(
				"Write roots: src/charts/\nRead doc/reference.md. Update src/charts/a.ts.",
				cwd,
				"coder",
			),
		).toEqual([]);
		expect(uncoveredWriteTargets("Fix /other/a.ts", cwd, "coder")).toEqual([]);
		expect(
			uncoveredWriteTargets(
				"Write only /project/a.ts\nDo not edit /other/a.ts.\nReference: /other/b.ts",
				cwd,
				"coder",
			),
		).toEqual([]);
		for (const role of ["scout", "researcher", "reviewer", "visual-qa", "adversary", "user-shadow"])
			expect(uncoveredWriteTargets(mismatch, cwd, role)).toEqual([]);
	});

	test("write refusal is once per agent and brief, before recording a spawn", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-preflight-"));
		try {
			const state = createRouterState();
			const options = { stateFile: path.join(dir, "spawn.jsonl") };
			const event = { agent: "ui-coder", assignment: mismatch, spawnKey: "scope", isolated: true };
			expect(routeSubagentSpawn(event, context, state, options)?.reason).toContain(
				"/project/src/r14/slides/s05.jsx",
			);
			expect(state.spawns.size).toBe(0);
			expect(routeSubagentSpawn(event, context, state, options)).toBeUndefined();
			expect(
				routeSubagentSpawn({ ...event, assignment: `${mismatch}\nFix src/other.ts` }, context, state, options)
					?.block,
			).toBe(true);
			expect(routeSubagentSpawn({ ...event, agent: "git-pr-owner" }, context, state, options)?.block).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("low RAM refuses heavy rows with measured availability and threshold; lightweight work and the exact threshold pass", () => {
		const low = { memAvailableKiB: 4 * 1024 ** 2, processes: [] };
		expect(heavyTestRefusal("Run e2e", cwd, low)).toContain("4.00 GiB (4194304 KiB)");
		expect(heavyTestRefusal("Run browser checks", cwd, low)).toContain("minimum=8 GiB");
		expect(heavyTestRefusal("Run full-suite", cwd, low)).toContain("targeted specs");
		expect(heavyTestRefusal("Run unit checks", cwd, low)).toBeUndefined();
		expect(heavyTestRefusal("Run e2e", cwd, { ...low, memAvailableKiB: 8 * 1024 ** 2 })).toBeUndefined();
		expect(heavyTestRefusal("Run e2e", cwd, low, 4)).toBeUndefined();
		expect(ramThresholdGiB("2.5")).toBe(2.5);
		expect(ramThresholdGiB("invalid")).toBe(8);
	});

	test("a running project suite refuses even with RAM; other projects and non-test commands pass", () => {
		const resources = {
			memAvailableKiB: 20 * 1024 ** 2,
			processes: [{ pid: 42, cwd: "/other", command: "node playwright test" }],
		};
		expect(heavyTestRefusal("ROOT=/other\nRun playwright test", cwd, resources)).toContain("PIDs 42");
		expect(heavyTestRefusal("Run playwright test", cwd, resources)).toBeUndefined();
		expect(
			heavyTestRefusal("Run e2e", cwd, { ...resources, processes: [{ pid: 43, cwd, command: "node server.js" }] }),
		).toBeUndefined();
		expect(
			heavyTestRefusal("Run e2e", cwd, {
				...resources,
				processes: [{ pid: 44, cwd: "/project-other", command: "chromium --headless" }],
			}),
		).toBeUndefined();
		expect(
			heavyTestRefusal("Run e2e", cwd, {
				...resources,
				processes: [{ pid: 45, cwd: "/project/tests", command: "chromium --headless" }],
			}),
		).toContain("same-project test processes=1");
	});

	test("RAM refusal is once per agent and brief, before spawn, and fresh briefs are rechecked", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-preflight-"));
		try {
			const state = createRouterState();
			const options = {
				stateFile: path.join(dir, "spawn.jsonl"),
				hostResources: { memAvailableKiB: 1024, processes: [] },
			};
			const event = { agent: "gate-runner", assignment: "Run e2e", spawnKey: "ram", isolated: true };
			expect(routeSubagentSpawn(event, context, state, options)?.reason).toContain("one suite at a time");
			expect(state.spawns.size).toBe(0);
			expect(routeSubagentSpawn(event, context, state, options)).toBeUndefined();
			expect(routeSubagentSpawn({ ...event, assignment: "Run full-suite" }, context, state, options)?.block).toBe(
				true,
			);
			expect(routeSubagentSpawn({ ...event, agent: "task" }, context, state, options)?.block).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("injectable proc probes parse MemAvailable, not total or free memory, and tolerate inaccessible probes", async () => {
		const resources = await probeHostTestResources({
			meminfo: async () => "MemTotal: 99999999 kB\nMemFree: 1 kB\nMemAvailable: 4194304 kB\n",
			processes: async () => [{ pid: 12, cwd, command: "playwright test" }],
		});
		expect(heavyTestRefusal("Run e2e", cwd, resources)).toContain("4.00 GiB");
		expect(heavyTestRefusal("Run e2e", cwd, resources)).toContain("PIDs 12");
		const unavailable = await probeHostTestResources({
			meminfo: async () => {
				throw new Error("no proc");
			},
			processes: async () => [],
		});
		expect(heavyTestRefusal("Run e2e", cwd, unavailable)).toBeUndefined();
	});
});
