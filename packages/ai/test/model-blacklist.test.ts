import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { __providerInFlightForTesting, stream, streamSimple } from "../src/stream";
import type { Api, AssistantMessage, Context, Model } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const api = "blacklist-test" as Api;
const source = "model-blacklist-test";
const context: Context = { systemPrompt: [], messages: [] };
const banned: Model<Api> = { provider: "canary-provider", id: "convicted", name: "Canary", api } as Model<Api>;
const allowed: Model<Api> = { ...banned, id: "convicted-small" };

function message(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		content: [{ type: "text", text: "provider reached" }],
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("owner model blacklist at dispatch", () => {
	let dir: string;
	let calls: string[];
	let rootSpy: { mockRestore(): void };
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-blacklist-"));
		rootSpy = spyOn(dirs, "getBaseConfigRoot").mockReturnValue(dir);
		__providerInFlightForTesting.setRoot(path.join(dir, "permits"));
		calls = [];
		registerCustomApi(
			api,
			model => {
				calls.push(model.id);
				const events = new AssistantMessageEventStream();
				queueMicrotask(() => events.push({ type: "done", reason: "stop", message: message(model) }));
				return events;
			},
			source,
		);
	});
	afterEach(() => {
		unregisterCustomApis(source);
		__providerInFlightForTesting.setRoot(undefined);
		__providerInFlightForTesting.setLockCreatedObserver(undefined);
		rootSpy.mockRestore();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	function ban(): void {
		fs.writeFileSync(
			path.join(dir, "model-blacklist.json"),
			JSON.stringify({ "canary-provider/convicted": "fabricated verification" }),
		);
	}

	test("banned models never reach either dispatch entry point, while the neighboring model works", async () => {
		ban();
		expect(() => stream(banned, context)).toThrow("fabricated verification");
		expect(() => streamSimple(banned, context)).toThrow("blacklisted");
		const result = await streamSimple(allowed, context).result();
		expect(result.content).toEqual([{ type: "text", text: "provider reached" }]);
		expect(calls).toEqual(["convicted-small"]);
	});

	test("a newly written ban also stops a previously selected model without restarting", async () => {
		await streamSimple(banned, context).result();
		ban();
		expect(() => streamSimple(banned, context)).toThrow("blacklisted");
		expect(calls).toEqual(["convicted"]);
	});

	for (const dispatch of [stream, streamSimple]) {
		test(`${dispatch.name} rechecks a ban written while resolving headers`, async () => {
			const model = {
				...banned,
				resolveHeaders: async () => {
					ban();
					return {};
				},
			};
			await expect(dispatch(model, context).result()).rejects.toThrow("blacklisted");
			expect(calls).toEqual([]);
		});
	}

	for (const dispatch of [stream, streamSimple]) {
		test(`${dispatch.name} rechecks a ban written while acquiring a permit`, async () => {
			__providerInFlightForTesting.setLockCreatedObserver(async () => {
				ban();
			});
			const result = dispatch(banned, context, { maxInFlightRequests: { "canary-provider": 1 } });
			await expect(result.result()).rejects.toThrow("blacklisted");
			expect(calls).toEqual([]);
		});
	}

	test("rechecks a ban written while resolving credentials", async () => {
		const result = streamSimple(banned, context, {
			apiKey: async () => {
				ban();
				return "fixture-only";
			},
		});
		await expect(result.result()).rejects.toThrow("blacklisted");
		expect(calls).toEqual([]);
	});

	test("a malformed policy fails closed instead of silently restoring access", () => {
		fs.writeFileSync(path.join(dir, "model-blacklist.json"), "{");
		expect(() => streamSimple(banned, context)).toThrow("Cannot read model blacklist");
		expect(calls).toEqual([]);
	});

	test("blank reasons cannot silently disable a policy entry", () => {
		fs.writeFileSync(path.join(dir, "model-blacklist.json"), '{"canary-provider/convicted":""}');
		expect(() => streamSimple(banned, context)).toThrow("nonblank reason");
		expect(calls).toEqual([]);
	});
});
