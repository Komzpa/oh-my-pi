import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "../src/config/model-registry";
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
