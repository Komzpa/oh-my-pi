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
	let weights = { [first]: 1, [second]: 3 };
	Object.assign(settings, { getModelRolePool: () => weights });
	const suppressed = new Set<string>();
	const registry = { getAvailable: () => [a, b], isSelectorSuppressed: (key: string) => suppressed.has(key) };
	const agents = [{ name: "coder", model: ["@code"] }];
	expect(workerRiskPools(settings, registry, agents).coder).toEqual([
		{ model: first, weight: 1 },
		{ model: second, weight: 3 },
	]);
	weights = { [first]: 4, [second]: 1 };
	expect(workerRiskPools(settings, registry, agents).coder[0].weight).toBe(4);
	suppressed.add(first);
	expect(workerRiskPools(settings, registry, agents).coder).toEqual([{ model: second, weight: 1 }]);
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
