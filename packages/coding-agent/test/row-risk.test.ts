import { expect, test, spyOn } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "../src/config/model-registry";
import * as riskParser from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as discovery from "../src/task/discovery";
import * as modelResolver from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { workerRiskPools, loadRowRisk } from "../src/task/row-risk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("profile pool weights refresh and suppressed models leave the forecast mixture", () => {
	const a = getBundledModel("anthropic", "claude-sonnet-4-6")!;
	const b = getBundledModel("openai", "gpt-5.2")!;
	const first = `${a.provider}/${a.id}`,
		second = `${b.provider}/${b.id}`;
	const settings = Settings.isolated({ modelRoles: { code: `${first},${second}` } });
	let availableFirst = true;
	let flipped = false;
	const registry = {
		getAvailable: () => [a, b],
		isSelectorSuppressed: (key: string) => key === first && !availableFirst,
	};
	const agents = [{ name: "coder", model: ["@outer:high"] }];
	// Resolver output fixture: three of every four spawn seeds select the second model.
	const resolver = (_value: string | string[] | undefined, _settings?: Settings, seed = "") => {
		const chooseFirst = Number(seed.slice("row-risk-".length)) % 4 === 0;
		return chooseFirst !== flipped ? [first, second] : [second, first];
	};
	expect(workerRiskPools(settings, registry, agents, resolver).coder).toEqual([
		{ model: first, weight: 500 },
		{ model: second, weight: 1500 },
	]);
	flipped = true;
	expect(workerRiskPools(settings, registry, agents, resolver).coder.find(c => c.model === first)?.weight).toBe(1500);
	availableFirst = false;
	expect(workerRiskPools(settings, registry, agents, resolver).coder).toEqual([{ model: second, weight: 2000 }]);
});

test("missing and invalid component files return the single-attempt fallback", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-risk-"));
	try {
		const file = path.join(dir, "row-risk.json");
		const settings = Settings.isolated({});
		const registry = {} as ModelRegistry;
		expect(await loadRowRisk(settings, registry, dir, undefined, Date.now(), file)).toBeUndefined();
		await Bun.write(file, '{"version":2}');
		expect(await loadRowRisk(settings, registry, dir, undefined, Date.now(), file)).toBeUndefined();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("unchanged risk frames do not resample, while settings and suppression change the forecast", () => {
	const a = getBundledModel("anthropic", "claude-sonnet-4-6")!;
	const b = getBundledModel("openai", "gpt-5.2")!;
	const first = `${a.provider}/${a.id}`,
		second = `${b.provider}/${b.id}`;
	const settings = Settings.isolated({ modelRoles: { code: `${first},${second}` } });
	let suppressed = false;
	const registry = { getAvailable: () => [a, b], isSelectorSuppressed: (key: string) => suppressed && key === first };
	const agents = [{ name: "coder", model: ["@code"] }];
	const resolver = spyOn(modelResolver, "resolveConfiguredModelPatterns");
	try {
		expect(workerRiskPools(settings, registry, agents).coder).toEqual([{ model: first, weight: 2000 }]);
		const calls = resolver.mock.calls.length;
		for (let i = 0; i < 50; i++) workerRiskPools(settings, registry, agents);
		expect(resolver.mock.calls.length).toBe(calls);
		settings.overrideModelRoles({ code: second });
		expect(workerRiskPools(settings, registry, agents).coder).toEqual([{ model: second, weight: 2000 }]);
		expect(resolver.mock.calls.length).toBeGreaterThan(calls);
		settings.overrideModelRoles({ code: `${first},${second}` });
		suppressed = true;
		expect(workerRiskPools(settings, registry, agents).coder).toEqual([{ model: second, weight: 2000 }]);
		suppressed = false;
		expect(workerRiskPools(settings, registry, agents).coder).toEqual([{ model: first, weight: 2000 }]);
	} finally {
		resolver.mockRestore();
	}
});

test("risk loads parse unchanged components once and observe replacement and expiry", async () => {
	await fs.mkdir(path.resolve(".tmp"), { recursive: true });
	const dir = await fs.mkdtemp(path.resolve(".tmp/risk-"));
	const file = path.join(dir, "row-risk.json");
	const now = Date.now();
	const q = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];
	const component = { n: 1, n_eff: 1, p_redo: [0, 0, 0], attempt_ratio: { q, v: q }, gap_ratio: { q, v: q } };
	const raw = {
		version: 1,
		generatedAt: new Date(now).toISOString(),
		window: { start: new Date(now).toISOString(), end: new Date(now).toISOString() },
		source: { runs: "runs", labels: "labels" },
		unit: "ratio",
		components: { "*": { "*": component } },
	};
	const parse = spyOn(riskParser, "parseRowRiskFile");
	const discover = spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [],
		projectAgentsDir: null,
		searchedDirs: [],
	});
	const settings = Settings.isolated({});
	const registry = { getAvailable: () => [], isSelectorSuppressed: () => false } as unknown as ModelRegistry;
	try {
		await Bun.write(file, JSON.stringify(raw));
		expect(
			(await loadRowRisk(settings, registry, dir, undefined, now, file))?.components.components["*"]["*"].n,
		).toBe(1);
		for (let i = 0; i < 50; i++) await loadRowRisk(settings, registry, dir, undefined, now + i, file);
		expect(parse.mock.calls.length).toBe(1);
		raw.components["*"]["*"].n = 20;
		await Bun.write(file, JSON.stringify(raw));
		expect(
			(await loadRowRisk(settings, registry, dir, undefined, now, file))?.components.components["*"]["*"].n,
		).toBe(20);
		expect(parse.mock.calls.length).toBe(2);
		expect(await loadRowRisk(settings, registry, dir, undefined, now + 15 * 86400_000, file)).toBeUndefined();
		expect(parse.mock.calls.length).toBe(2);
	} finally {
		parse.mockRestore();
		discover.mockRestore();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
