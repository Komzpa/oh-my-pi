import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SoftToolRequirement } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ProviderDefinition {
	name: string;
	provider: (ctx: ExtensionContext) => SoftToolRequirement | undefined;
}

async function createRunner(providers: ProviderDefinition[]) {
	const tempDir = TempDir.createSync("@soft-tool-provider-");
	const cwd = tempDir.join("project");
	fs.mkdirSync(cwd, { recursive: true });
	const runtime = new ExtensionRuntime();
	let authStorage: AuthStorage | undefined;
	try {
		const extensions = [];
		for (const { name, provider } of providers) {
			const factory: ExtensionFactory = (pi: ExtensionAPI) => {
				pi.registerSoftToolRequirementProvider(provider);
			};
			extensions.push(await loadExtensionFromFactory(factory, cwd, new EventBus(), runtime, name));
		}
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const runner = new ExtensionRunner(
			extensions,
			runtime,
			cwd,
			SessionManager.inMemory(cwd),
			new ModelRegistry(authStorage),
		);
		return {
			runner,
			close: () => {
				authStorage?.close();
				tempDir[Symbol.dispose]?.();
			},
		};
	} catch (error) {
		authStorage?.close();
		tempDir[Symbol.dispose]?.();
		throw error;
	}
}

function taskRequirement(id: string): SoftToolRequirement {
	return {
		soft: true,
		id,
		toolName: "task",
		reminder: [{ role: "developer", content: "Call task with the complete worker contracts.", timestamp: 1 }],
	};
}

describe("extension soft tool requirement providers", () => {
	let closeRunner: (() => void) | undefined;
	afterEach(() => {
		closeRunner?.();
		closeRunner = undefined;
	});

	it("re-evaluates one lazy provider with a fresh context at each model-choice boundary", async () => {
		let current: SoftToolRequirement | undefined;
		const contexts: ExtensionContext[] = [];
		const { runner, close } = await createRunner([
			{
				name: "todo-supervisor",
				provider: ctx => {
					contexts.push(ctx);
					return current;
				},
			},
		]);
		closeRunner = close;

		expect(contexts).toHaveLength(0);
		expect(runner.getSoftToolRequirement()).toBeUndefined();
		current = taskRequirement("plan-a-live-roster-a");
		expect(runner.getSoftToolRequirement()).toBe(current);
		current = undefined;
		expect(runner.getSoftToolRequirement()).toBeUndefined();
		expect(contexts).toHaveLength(3);
		expect(contexts[0]).not.toBe(contexts[1]);
		expect(contexts[1]).not.toBe(contexts[2]);
	});

	it("fails closed when more than one extension publishes an active requirement", async () => {
		const { runner, close } = await createRunner([
			{ name: "first", provider: () => taskRequirement("first") },
			{ name: "second", provider: () => taskRequirement("second") },
		]);
		closeRunner = close;

		expect(() => runner.getSoftToolRequirement()).toThrow(
			"Multiple active soft tool requirement providers: first, second",
		);
	});

	it("rejects duplicate provider registration by one extension", async () => {
		const tempDir = TempDir.createSync("@soft-tool-provider-duplicate-");
		const cwd = tempDir.join("project");
		fs.mkdirSync(cwd, { recursive: true });
		const runtime = new ExtensionRuntime();
		const factory: ExtensionFactory = pi => {
			const provider = () => undefined;
			pi.registerSoftToolRequirementProvider(provider);
			pi.registerSoftToolRequirementProvider(provider);
		};
		try {
			await expect(loadExtensionFromFactory(factory, cwd, new EventBus(), runtime, "duplicate")).rejects.toThrow(
				'Extension "duplicate" already registered a soft tool requirement provider',
			);
		} finally {
			tempDir[Symbol.dispose]?.();
		}
	});
});
