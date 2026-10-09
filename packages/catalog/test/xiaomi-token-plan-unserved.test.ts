import { describe, expect, it, vi } from "bun:test";
import {
	isXiaomiTokenPlanUnservedModel,
	xiaomiModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const TP_KEY = "tp-test-key";
const SGP_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";

function discoveryFetch(ids: readonly string[]): FetchImpl {
	return (async (_input: string | URL | Request) => {
		return new Response(JSON.stringify({ data: ids.map(id => ({ id, object: "model", owned_by: "xiaomi" })) }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as FetchImpl;
}

describe("Xiaomi Token Plan unserved models", () => {
	it("marks ultraspeed and mimo-v2-* models unserved", () => {
		expect(isXiaomiTokenPlanUnservedModel("mimo-v2.6-pro-ultraspeed")).toBe(true);
		expect(isXiaomiTokenPlanUnservedModel("mimo-v2-foo")).toBe(true);
		expect(isXiaomiTokenPlanUnservedModel("mimo-v2.6-pro")).toBe(false);
		expect(isXiaomiTokenPlanUnservedModel("mimo-v2.6-flash")).toBe(false);
		expect(isXiaomiTokenPlanUnservedModel("mimo-v2.5-pro")).toBe(false);
		expect(isXiaomiTokenPlanUnservedModel("mimo-v2.5")).toBe(false);
	});

	it("filters unserved models from Token Plan discovery under a tp- key", async () => {
		const seen: string[] = [];
		const inner = discoveryFetch(["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2-foo", "mimo-v2.5"]);
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			seen.push(String(input));
			return inner(input, init);
		});
		const opts = xiaomiModelManagerOptions({ apiKey: TP_KEY, fetch: fetchMock });
		const models = await opts.fetchDynamicModels?.();
		expect(models?.map(model => model.id).sort()).toEqual(["mimo-v2.5", "mimo-v2.6-pro"]);
		expect(seen).toEqual([`${SGP_BASE_URL}/models`]);
	});

	it("hides unserved bundled models under a tp- key before discovery runs", () => {
		const opts = xiaomiModelManagerOptions({ apiKey: TP_KEY });
		const ids = (opts.staticModels ?? []).map(model => model.id);
		expect(ids).toContain("mimo-v2.6-pro");
		expect(ids).toContain("mimo-v2.5");
		expect(ids).not.toContain("mimo-v2.6-pro-ultraspeed");
		expect(ids).not.toContain("mimo-v2-flash");
		expect(opts.dynamicModelsAuthoritative).toBe(true);
		// Pay-as-you-go keys keep the full bundled roster and non-authoritative discovery.
		const payg = xiaomiModelManagerOptions({ apiKey: "sk-payg-key" });
		expect(payg.staticModels).toBeUndefined();
		expect(payg.dynamicModelsAuthoritative).toBeUndefined();
	});
});
