import { describe, expect, it } from "bun:test";
import { resolveXiaomiRequestBaseUrl } from "../src/registry/oauth/xiaomi";

describe("resolveXiaomiRequestBaseUrl", () => {
	const standard = "https://api.xiaomimimo.com/v1";
	it("sends tp- keys to the regional Token Plan host", () => {
		for (const region of ["sgp", "ams", "cn"]) {
			expect(
				resolveXiaomiRequestBaseUrl({ provider: `xiaomi-token-plan-${region}`, baseUrl: standard }, "tp-key"),
			).toBe(`https://token-plan-${region}.xiaomimimo.com/v1`);
		}
		expect(resolveXiaomiRequestBaseUrl({ provider: "xiaomi", baseUrl: standard }, "tp-key")).toBe(
			"https://token-plan-sgp.xiaomimimo.com/v1",
		);
	});
	it("keeps the model host for non-tp keys and deliberate overrides", () => {
		expect(resolveXiaomiRequestBaseUrl({ provider: "xiaomi", baseUrl: standard }, "sk-key")).toBe(standard);
		expect(resolveXiaomiRequestBaseUrl({ provider: "xiaomi", baseUrl: "https://proxy.example/v1" }, "tp-key")).toBe(
			"https://proxy.example/v1",
		);
	});
});
