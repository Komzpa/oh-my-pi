import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { RequirementsLedgerRuntime } from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getLatestRequirements, type RequirementLedgerItem } from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { isTaskToolDetails, type TaskImage } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

// A real, unmodified 4x4 RGBA PNG, not placeholder pixels.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVQI12P8z8DwnwEJMDGgAcICAIPRAgYt167zAAAAAElFTkSuQmCC";
const ROW = "Give qa-auditor the requirement pixels";
const MOCK_SOURCE = "test/requirement-image-task-integration";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "OMP_NO_WEBP"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;
let session: AgentSession | undefined;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-requirement-pixels-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	process.env.HOME = home;
	process.env.OMP_NO_WEBP = "1";
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_SOURCE);
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	__resetDirsFromEnvForTests();
	await fs.rm(root, { recursive: true, force: true });
});

// SDK session construction follows agent-session-live-settings.test.ts; real
// child/mock registration follows parked-subagent-session-release.test.ts.
async function dispatch(
	image: ImageContent | undefined,
	batch: boolean,
	sourceBacked = false,
): Promise<{
	firstUser: UserMessage;
	manager: SessionManager;
	cwd: string;
	requirement: RequirementLedgerItem;
}> {
	const cwd = path.join(root, "work");
	await fs.mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
	await Bun.write(
		path.join(cwd, ".omp", "agents", "qa-auditor.md"),
		Bun.file(new URL("../../src/prompts/agents/qa-auditor.md", import.meta.url)),
	);
	await Bun.write(path.join(cwd, "artifact.txt"), "audited\n");
	if (sourceBacked && image) {
		const sourcePath = path.join(cwd, "input.png");
		await Bun.write(sourcePath, Buffer.from(image.data, "base64"));
		image = tagImageAttachmentSource(image, sourcePath, "image");
	}
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.email", "tester@example.invalid");
	git(cwd, "config", "user.name", "Requirement Image Test");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "audited artifact");
	const head = git(cwd, "rev-parse", "HEAD");
	const raw = image ? "[Image #1, 4x4] do not do this" : "Do not do this";
	const table = `| id | raw words | verdict | evidence | artifact identity |\n|---|---|---|---|---|\n| R1 | ${raw} | pass | mock audit | ${ROW} @ ${head} |`;
	const child = createMockModel({
		id: "pixel-auditor",
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: { report: table } } }] }
				: { content: ["Audit pixels"] },
	});
	child.input.push("image");
	const item = { agent: "qa-auditor", name: "PixelAuditor", task: `Audit R1 for ${ROW}`, solutionSpace: "closed" };
	const parent = createMockModel({
		id: "pixel-parent",
		responses: [
			{
				content: [
					{
						type: "toolCall",
						name: "todo",
						arguments: { op: "classify", id: "R1", classification: "linked", rows: [ROW] },
					},
				],
			},
			{
				content: [
					{
						type: "toolCall",
						name: "task",
						arguments: batch ? { context: "Audit the linked image requirement", tasks: [item] } : item,
					},
				],
			},
			{ content: [{ type: "toolCall", name: "todo", arguments: { op: "done", task: ROW } }] },
			{ content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "finished" } }] },
		],
	});
	parent.input.push("image");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	const catalogAvailable = registry.getAvailable.bind(registry);
	vi.spyOn(registry, "getAvailable").mockImplementation(kind => [parent, child, ...catalogAvailable(kind)]);
	const manager = SessionManager.create(cwd, path.join(root, "sessions"));
	manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
		phases: [
			{ name: "Work", tasks: [{ content: ROW, status: "pending", schedule: { owner: "main", resources: [cwd] } }] },
		],
	});
	try {
		const created = await createAgentSession({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			authStorage: auth,
			modelRegistry: registry,
			model: parent,
			sessionManager: manager,
			settings: Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"todo.enabled": true,
				"todo.reminders": false,
				"task.batch": batch,
				"task.isolation.enabled": false,
				"task.agentIdleTtlMs": 0,
				"task.agentModelOverrides": { "qa-auditor": "mock/pixel-auditor" },
				modelRoles: { default: "mock/pixel-parent" },
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			toolNames: ["todo", "task", "yield"],
			restrictToolNames: true,
			workspaceTree: { rootPath: cwd, rendered: "artifact.txt", truncated: false, totalLines: 1, agentsMdFiles: [] },
		});
		session = created.session;
		await session.prompt(raw, image ? { images: [image] } : {});
		await session.waitForIdle();
		const result = session.agent.state.messages.find(
			message => message.role === "toolResult" && message.toolName === "task",
		);
		if (!result || result.role !== "toolResult" || !isTaskToolDetails(result.details))
			throw new Error("No real task result");
		const childId = result.details.results?.[0]?.id;
		const childSession = childId ? AgentRegistry.global().get(childId)?.session : undefined;
		if (!childSession) throw new Error(`No accepted child session: ${JSON.stringify(result)}`);
		// A batch may launch and discard a speculative child before the ledger
		// enriches its arguments. Inspect the child actually returned by task,
		// not the cancelled speculative model request.
		const call = child.calls.find(call => call.options?.sessionId === childSession.sessionId);
		expect(call).toBeDefined();
		const firstUser = childSession.agent.state.messages.find(message => message.role === "user");
		expect(firstUser).toBeDefined();
		if (!firstUser || firstUser.role !== "user") throw new Error("No child user prompt");
		const requirement = getLatestRequirements(manager.getBranch())[0]!;
		expect(requirement.classification).toBe("linked");
		return { firstUser, manager, cwd, requirement };
	} finally {
		await session?.dispose();
		session = undefined;
		await AgentLifecycleManager.global().dispose();
		auth.close();
	}
}

function imageParts(message: UserMessage): ImageContent[] {
	return typeof message.content === "string" ? [] : message.content.filter(part => part.type === "image");
}
function text(message: UserMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("requirement pixels through the real task session path", () => {
	for (const batch of [false, true]) {
		it(`delivers a real 4x4 PNG to the child's first user prompt (${batch ? "batch" : "flat"})`, async () => {
			const { firstUser, manager, cwd, requirement } = await dispatch(
				{ type: "image", data: PNG, mimeType: "image/png" },
				batch,
			);
			const original = sha256(Buffer.from(PNG, "base64"));
			expect(requirement.images?.[0]?.sha256).toBe(original);
			expect(text(firstUser)).toContain(original);
			expect(imageParts(firstUser)).toHaveLength(1);
			const childImage = imageParts(firstUser)[0]!;
			expect((childImage as TaskImage).sha256).toBe(original);
			expect(["image/png", "image/jpeg"]).toContain(childImage.mimeType);
			const dimensions = await new Bun.Image(Buffer.from(childImage.data, "base64")).metadata();
			expect(dimensions.width).toBeGreaterThan(0);
			expect(dimensions.height).toBeGreaterThan(0);
			expect(text(firstUser)).toContain("R1");
			const image = requirement.images![0]!;
			expect(image.artifactPath).toBeDefined();
			const artifactPath = image.artifactPath!;
			expect(sha256(await Bun.file(artifactPath).bytes())).toBe(original);
			expect(text(firstUser)).toContain(artifactPath);
			const before = await fs.stat(artifactPath);
			const runtime = new RequirementsLedgerRuntime({
				agent: {} as never,
				agentKind: () => "main",
				cwd: () => cwd,
				sessionManager: manager,
				onSettledAssistantMessage: () => {},
				setPublicationGate: () => {},
			});
			await runtime.prepareAuditorTaskCall("task", "repeat", { agent: "qa-auditor", task: `Audit R1 for ${ROW}` });
			expect((await fs.stat(artifactPath)).mtimeMs).toBe(before.mtimeMs);
		}, 30_000);
	}

	it("negative control: text-only task gives a child prompt with no images", async () => {
		const { firstUser } = await dispatch(undefined, false);
		expect(imageParts(firstUser)).toEqual([]);
		expect(text(firstUser)).toContain("R1");
		expect(text(firstUser)).not.toContain("Referenced images");
	}, 30_000);

	it("uses an existing source file without making an artifact copy", async () => {
		const { firstUser, requirement, cwd } = await dispatch(
			{ type: "image", data: PNG, mimeType: "image/png" },
			false,
			true,
		);
		const image = requirement.images![0]!;
		expect(image.artifactPath).toBeUndefined();
		expect(text(firstUser)).toContain(path.join(cwd, "input.png"));
		expect((imageParts(firstUser)[0]! as TaskImage).sha256).toBe(sha256(Buffer.from(PNG, "base64")));
	}, 30_000);
});
