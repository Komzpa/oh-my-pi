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
import { loadEntriesFromFile, loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	getLatestRequirements,
	type RequirementLedgerItem,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
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

// Keep the original pixels valid; a CRC-checked ancillary tEXt chunk makes
// the raw PNG exactly 400 KiB (409,600 bytes), not 400 KB of base64 text.
function largePng(): Buffer {
	const original = Buffer.from(PNG, "base64");
	const payload = Buffer.from(`Fixture\0${"x".repeat(400 * 1024 - original.length - 12 - 8)}`);
	const chunk = Buffer.alloc(payload.length + 12);
	chunk.writeUInt32BE(payload.length, 0);
	chunk.write("tEXt", 4, "ascii");
	payload.copy(chunk, 8);
	let crc = 0xffffffff;
	for (const byte of chunk.subarray(4, -4)) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
	return Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]);
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
	sourceBacked: boolean | "missing" = false,
	auditorCount = 1,
	worker?: { images?: (cwd: string) => Promise<TaskImage[]> },
): Promise<{
	firstUser: UserMessage;
	firstUsers: UserMessage[];
	taskArgs: Record<string, unknown>;
	storedTaskArgs: Record<string, unknown>;
	originalTaskArgs: string;
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
	if (worker) {
		await Bun.write(
			path.join(cwd, ".omp", "agents", "pixel-worker.md"),
			"---\nname: pixel-worker\ndescription: Exercise task image delivery\ntools: []\n---\nReturn the assigned task result.\n",
		);
	}
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
	const assignedRows = Array.from({ length: auditorCount }, (_, index) => (index === 0 ? ROW : `${ROW} ${index + 1}`));
	const table = `| id | raw words | verdict | evidence | artifact identity |\n|---|---|---|---|---|\n| R1 | ${raw} | pass | mock audit | ${ROW} @ ${head} |`;
	const child = createMockModel({
		id: "pixel-auditor",
		handler: context => {
			const assignedRow =
				assignedRows.find(row =>
					context.messages.some(
						message => message.role === "user" && text(message).includes(`row ${JSON.stringify(row)} @`),
					),
				) ?? ROW;
			const report = table.replace(`${ROW} @`, `${assignedRow} @`);
			return (context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: { report } } }] }
				: { content: ["Audit pixels"] };
		},
	});
	child.input.push("image");
	const item = {
		agent: worker ? "pixel-worker" : "qa-auditor",
		name: "PixelAuditor",
		task: `Audit R1 for ${ROW}`,
		solutionSpace: "closed",
		...(worker?.images ? { images: await worker.images(cwd) } : {}),
	};
	const items = Array.from({ length: auditorCount }, (_, index) => ({ ...item, name: `PixelAuditor${index + 1}` }));
	const submittedArgs = batch ? { context: "Audit the linked image requirement", tasks: items } : item;
	const originalTaskArgs = JSON.stringify(submittedArgs);
	const parent = createMockModel({
		id: "pixel-parent",
		responses: [
			{
				content: [
					{
						type: "toolCall",
						name: "todo",
						arguments: { op: "classify", id: "R1", classification: "linked", rows: assignedRows },
					},
				],
			},
			async () => {
				if (sourceBacked === "missing") {
					const requirements = getLatestRequirements(manager.getBranch());
					const referenced = requirements[0]?.images?.[0];
					if (!referenced?.sourcePath) throw new Error("No ledger source image");
					await fs.rm(referenced.sourcePath);
					delete referenced.data;
					appendRequirementsSnapshot(
						{ appendEntry: (kind, data) => manager.appendCustomEntry(kind, data) },
						requirements,
					);
				}
				return { content: [{ type: "toolCall", name: "task", arguments: submittedArgs }] };
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
			{
				name: "Work",
				tasks: assignedRows.map((content, index) => ({
					content,
					status: "pending",
					schedule: { owner: batch ? items[index]!.name : item.name, resources: [cwd] },
				})),
			},
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
				"task.agentModelOverrides": { "qa-auditor": "mock/pixel-auditor", "pixel-worker": "mock/pixel-auditor" },
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
		const firstUsers = (result.details.results ?? []).map(childResult => {
			expect(childResult.exitCode).toBe(0);
			const childSession = childResult.id ? AgentRegistry.global().get(childResult.id)?.session : undefined;
			if (!childSession) throw new Error(`No accepted child session: ${JSON.stringify(childResult)}`);
			// Ignore cancelled speculative model requests; inspect returned children.
			const call = child.calls.find(call => call.options?.sessionId === childSession.sessionId);
			expect(call).toBeDefined();
			const firstUser = childSession.agent.state.messages.find(message => message.role === "user");
			if (!firstUser || firstUser.role !== "user") throw new Error("No child user prompt");
			return firstUser;
		});
		const firstUser = firstUsers[0];
		if (!firstUser) throw new Error("No returned children");
		await manager.flush();
		// Measure the persisted consumer-visible call, not storage's blob: codec.
		const persisted = await loadSessionMessagesReadOnly(manager.getSessionFile()!);
		const taskCall = persisted
			.flatMap(message => (message.role === "assistant" ? message.content : []))
			.find(part => part.type === "toolCall" && part.name === "task");
		if (!taskCall || taskCall.type !== "toolCall") throw new Error("No persisted assistant task call");
		const taskArgs = taskCall.arguments as Record<string, unknown>;
		const stored = await loadEntriesFromFile(manager.getSessionFile()!);
		const storedTaskCall = stored
			.flatMap(entry =>
				entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [],
			)
			.find(part => part.type === "toolCall" && part.name === "task");
		if (!storedTaskCall || storedTaskCall.type !== "toolCall") throw new Error("No stored assistant task call");
		const storedTaskArgs = storedTaskCall.arguments as Record<string, unknown>;
		const requirement = getLatestRequirements(manager.getBranch())[0]!;
		expect(requirement.classification).toBe("linked");
		return { firstUser, firstUsers, taskArgs, storedTaskArgs, originalTaskArgs, manager, cwd, requirement };
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
	it("keeps five auditors' persisted task image references below 20,000 JSON characters", async () => {
		const bytes = largePng();
		expect(bytes.length).toBe(409_600);
		const dimensions = await new Bun.Image(bytes).metadata();
		expect(dimensions.width).toBe(4);
		expect(dimensions.height).toBe(4);
		const expectedSha = sha256(bytes);
		const { firstUsers, taskArgs, storedTaskArgs } = await dispatch(
			{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
			true,
			false,
			5,
		);
		expect(firstUsers).toHaveLength(5);
		for (const firstUser of firstUsers) {
			expect(imageParts(firstUser)).toHaveLength(1);
			expect((imageParts(firstUser)[0]! as TaskImage).sha256).toBe(expectedSha);
		}
		const serialized = JSON.stringify(taskArgs);
		console.log(
			`five-auditor oracle: raw PNG=${bytes.length} bytes; persisted args=${serialized.length} JSON characters; children=${firstUsers.length}; sha256=${expectedSha}`,
		);
		expect(serialized.length).toBeLessThan(20_000);
		for (const args of [taskArgs, storedTaskArgs]) {
			expect(JSON.stringify(args).length).toBeLessThan(20_000);
			expect(JSON.stringify(args)).not.toContain(bytes.toString("base64"));
			for (const item of args.tasks as { images: TaskImage[] }[]) {
				expect(item.images).toHaveLength(1);
				expect(item.images[0]).not.toHaveProperty("data");
				expect(item.images[0]?.sha256).toBe(expectedSha);
			}
		}
	}, 30_000);

	// This non-auditor call bypasses intentional ledger protocol enrichment.
	// Compare the exact JSON text of submitted and persisted assistant args.
	it("negative control: image-less non-auditor task args stay byte-identical", async () => {
		const { firstUser, taskArgs, originalTaskArgs } = await dispatch(undefined, false, false, 1, {});
		expect(JSON.stringify(taskArgs)).toBe(originalTaskArgs);
		expect(imageParts(firstUser)).toEqual([]);
		expect(text(firstUser)).not.toContain("unavailable");
	}, 30_000);

	for (const pathField of ["artifactPath", "sourcePath"] as const) {
		it(`loads ${pathField}-only pixels into the real child's first prompt`, async () => {
			const expectedSha = sha256(Buffer.from(PNG, "base64"));
			const { firstUser, taskArgs } = await dispatch(undefined, false, false, 1, {
				images: async cwd => {
					const imagePath = path.join(cwd, "referenced.png");
					await Bun.write(imagePath, Buffer.from(PNG, "base64"));
					const reference = {
						type: "image" as const,
						mimeType: "image/png",
						sha256: expectedSha,
						rn: "R1",
						index: 1,
					};
					return [
						pathField === "artifactPath"
							? { ...reference, artifactPath: imagePath }
							: { ...reference, sourcePath: imagePath },
					];
				},
			});
			expect((taskArgs.images as TaskImage[])[0]).not.toHaveProperty("data");
			expect(imageParts(firstUser)).toHaveLength(1);
			const childImage = imageParts(firstUser)[0]! as ImageContent & TaskImage;
			expect(childImage.sha256).toBe(expectedSha);
			expect(childImage.rn).toBe("R1");
			expect(childImage.index).toBe(1);
		}, 30_000);
	}

	for (const failure of ["missing artifact", "mismatched SHA"] as const) {
		it(`continues the real child task with unavailable and SHA text for ${failure}`, async () => {
			const expectedSha = "f".repeat(64);
			const { firstUser } = await dispatch(undefined, false, false, 1, {
				images: async cwd => {
					const artifactPath = path.join(cwd, "unavailable.png");
					if (failure === "mismatched SHA") await Bun.write(artifactPath, Buffer.from(PNG, "base64"));
					return [{ type: "image", mimeType: "image/png", sha256: expectedSha, rn: "R1", index: 1, artifactPath }];
				},
			});
			expect(imageParts(firstUser)).toEqual([]);
			expect(text(firstUser)).toContain("unavailable");
			expect(text(firstUser)).toContain(expectedSha);
		}, 30_000);
	}

	it("keeps a known missing source reference when ledger bytes are absent", async () => {
		const expectedSha = sha256(Buffer.from(PNG, "base64"));
		const { firstUser, taskArgs, requirement } = await dispatch(
			{ type: "image", data: PNG, mimeType: "image/png" },
			false,
			"missing",
		);
		expect(requirement.images?.[0]?.data).toBeUndefined();
		expect((taskArgs.images as TaskImage[])[0]).toMatchObject({ sha256: expectedSha, rn: "R1", index: 1 });
		expect((taskArgs.images as TaskImage[])[0]).not.toHaveProperty("data");
		expect(imageParts(firstUser)).toEqual([]);
		expect(text(firstUser)).toContain("unavailable");
		expect(text(firstUser)).toContain(expectedSha);
	}, 30_000);

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
			await runtime.prepareAuditorTaskCall("task", "repeat", {
				name: "main",
				agent: "qa-auditor",
				task: `Audit R1 for ${ROW}`,
			});
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
