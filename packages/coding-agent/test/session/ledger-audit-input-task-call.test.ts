import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	classifyRequirement,
	createRequirementCandidates,
	getLatestRequirements,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

const AT = "2026-09-28T12:00:00.000Z";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clean git repo that is also the session cwd, with the bundled qa-auditor profile. */
function makeRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "omp-audit-input-"));
	const auditorDir = join(cwd, ".omp", "agents");
	mkdirSync(auditorDir, { recursive: true });
	writeFileSync(
		join(auditorDir, "qa-auditor.md"),
		readFileSync(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url), "utf8"),
	);
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "tester@example.invalid");
	git(cwd, "config", "user.name", "Audit Input Test");
	writeFileSync(join(cwd, "artifact.txt"), "audited\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "audited artifact");
	return cwd;
}

function seedLinkedRequirement(manager: SessionManager, cwd: string): void {
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], ["audit the artifact"], AT),
	});
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{
				name: "Work",
				tasks: [{ content: "Build artifact", status: "pending", schedule: { owner: "main", resources: [cwd] } }],
			},
		],
	});
	const linked = classifyRequirement(getLatestRequirements(manager.getBranch()), "R1", "linked", {
		rows: ["Build artifact"],
	});
	if ("error" in linked) throw new Error(linked.error);
	appendRequirementsSnapshot(
		{ appendEntry: (customType: string, data?: unknown) => manager.appendCustomEntry(customType, data) },
		linked.requirements,
	);
}

function taskStub(captured: unknown[]): AgentTool {
	return {
		name: "task",
		label: "Task",
		description: "Dispatch a subagent task",
		parameters: Type.Object(
			{
				agent: Type.Optional(Type.String()),
				task: Type.Optional(Type.String()),
				context: Type.Optional(Type.String()),
			},
			{ additionalProperties: true },
		),
		execute: async (_id: string, params: Record<string, unknown>) => {
			captured.push(params);
			return { content: [{ type: "text", text: "worker ok" }] };
		},
	} as unknown as AgentTool;
}

function passthroughRunner(): ExtensionRunner {
	return {
		markLoopToolCall: () => {},
		clearLoopToolCall: () => {},
		hasHandlers: (eventType: string) => eventType === "tool_call",
		markToolCallEmitted: () => {},
		emitToolCall: async () => ({}),
		emitBeforeAgentStart: async () => undefined,
	} as unknown as ExtensionRunner;
}

describe("ledger audit input reaches the auditor task call", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@audit-input-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function dispatchTask(args: {
		toolArgs: Record<string, unknown>;
		extensionRunner?: ExtensionRunner;
	}): Promise<{ captured: unknown[]; repo: string }> {
		const repo = makeRepo();
		const captured: unknown[] = [];
		const stub = taskStub(captured);
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const manager = SessionManager.inMemory(repo);
		seedLinkedRequirement(manager, repo);
		let calls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [stub], messages: [] },
			convertToLlm,
			streamFn: () => {
				const first = calls === 0;
				calls++;
				const message: AssistantMessage = first
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "call-1", name: "task", arguments: args.toolArgs }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[stub.name, stub]]),
			...(args.extensionRunner ? { extensionRunner: args.extensionRunner } : {}),
		});
		try {
			await session.prompt("go");
			await session.waitForIdle();
		} finally {
			await session.dispose();
		}
		return { captured, repo };
	}

	it("no extension handlers: qa-auditor task citing R1 carries QA AUDIT INPUT", async () => {
		const { captured, repo } = await dispatchTask({
			toolArgs: { agent: "qa-auditor", task: "Audit R1 at the current clean row HEAD" },
		});
		try {
			expect(captured).toHaveLength(1);
			const params = captured[0] as Record<string, unknown>;
			expect(typeof params.task).toBe("string");
			expect(params.task as string).toContain("QA AUDIT INPUT");
			expect(params.task as string).toContain("Current linked-row HEAD identities");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("extension handler without revision: qa-auditor task citing R1 still carries QA AUDIT INPUT", async () => {
		const { captured, repo } = await dispatchTask({
			toolArgs: { agent: "qa-auditor", task: "Audit R1 at the current clean row HEAD" },
			extensionRunner: passthroughRunner(),
		});
		try {
			expect(captured).toHaveLength(1);
			const params = captured[0] as Record<string, unknown>;
			expect(params.task as string).toContain("QA AUDIT INPUT");
			expect(params.task as string).toContain("Current linked-row HEAD identities");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("negative control: non-auditor task args are unchanged", async () => {
		const { captured, repo } = await dispatchTask({
			toolArgs: { agent: "code-writer", task: "Refactor the login handler" },
		});
		try {
			expect(captured).toHaveLength(1);
			const params = captured[0] as Record<string, unknown>;
			expect(params.task as string).not.toContain("QA AUDIT INPUT");
			expect(params.task as string).toBe("Refactor the login handler");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
