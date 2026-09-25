import { afterAll, afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { registerArtifactsDir, resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";
import { CURRENT_SESSION_VERSION } from "../../src/session/session-entries";

const tempDir = TempDir.createSync("omp-nested-agent-repro-");
afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

function fakeSession(artifactsDir: string, messages: unknown[] = []): AgentSession {
	return {
		messages,
		sessionManager: { getArtifactsDir: () => artifactsDir },
	} as unknown as AgentSession;
}

function transcriptJsonl(text: string): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "fixture-session",
		timestamp,
		cwd: "/tmp",
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "worker request", timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await fs.writeFile(path.join(midOwnArtifactsDir, `${grandchildId}.md`), "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});

it("agent:// falls back to a live worker transcript when no output artifact exists", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "live-root.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });

	const workerSession = fakeSession(rootArtifactsDir, [
		{ role: "user", content: "inspect current state", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "live transcript finding" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	]);
	AgentRegistry.global().register({
		id: "GuideTextRepair",
		displayName: "GuideTextRepair",
		kind: "sub",
		session: workerSession,
		sessionFile: path.join(rootArtifactsDir, "GuideTextRepair.jsonl"),
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://GuideTextRepair") as never);

	expect(resource.content).toContain("# GuideTextRepair (running)");
	expect(resource.content).toContain("live transcript finding");
	expect(resource.notes).toContain("Source: live session");
	expect(resource.notes).toContain("Fallback: no agent output artifact found; serving worker transcript.");
});

it("agent:// transcript fallback preserves agent ids that look like URL authority syntax", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "url-authority-root.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });

	const confusedTarget = fakeSession(rootArtifactsDir, [
		{ role: "assistant", content: [{ type: "text", text: "wrong ops transcript" }], timestamp: 1 },
	]);
	const requestedTarget = fakeSession(rootArtifactsDir, [
		{ role: "assistant", content: [{ type: "text", text: "right review-at-ops transcript" }], timestamp: 1 },
	]);
	const namespacedTarget = fakeSession(rootArtifactsDir, [
		{ role: "assistant", content: [{ type: "text", text: "right review-colon-ops transcript" }], timestamp: 1 },
	]);
	const fragmentTarget = fakeSession(rootArtifactsDir, [
		{ role: "assistant", content: [{ type: "text", text: "right review-fragment transcript" }], timestamp: 1 },
	]);
	const fragmentConfusedTarget = fakeSession(rootArtifactsDir, [
		{ role: "assistant", content: [{ type: "text", text: "wrong review transcript" }], timestamp: 1 },
	]);
	AgentRegistry.global().register({
		id: "ops",
		displayName: "ops",
		kind: "sub",
		session: confusedTarget,
		sessionFile: path.join(rootArtifactsDir, "ops.jsonl"),
	});
	AgentRegistry.global().register({
		id: "review@ops",
		displayName: "review@ops",
		kind: "sub",
		session: requestedTarget,
		sessionFile: path.join(rootArtifactsDir, "review@ops.jsonl"),
	});
	AgentRegistry.global().register({
		id: "review:ops",
		displayName: "review:ops",
		kind: "sub",
		session: namespacedTarget,
		sessionFile: path.join(rootArtifactsDir, "review:ops.jsonl"),
	});
	AgentRegistry.global().register({
		id: "Review",
		displayName: "Review",
		kind: "sub",
		session: fragmentConfusedTarget,
		sessionFile: path.join(rootArtifactsDir, "Review.jsonl"),
	});
	AgentRegistry.global().register({
		id: "Review#1",
		displayName: "Review#1",
		kind: "sub",
		session: fragmentTarget,
		sessionFile: path.join(rootArtifactsDir, "Review#1.jsonl"),
	});

	const handler = new AgentProtocolHandler();
	const resource = await handler.resolve(parseInternalUrl("agent://review@ops"));
	const namespacedResource = await handler.resolve(parseInternalUrl("agent://review:ops"));
	const fragmentResource = await handler.resolve(parseInternalUrl("agent://Review%231"));

	expect(resource.content).toContain("# review@ops (running)");
	expect(resource.content).toContain("right review-at-ops transcript");
	expect(resource.content).not.toContain("wrong ops transcript");
	expect(namespacedResource.content).toContain("# review:ops (running)");
	expect(namespacedResource.content).toContain("right review-colon-ops transcript");
	expect(fragmentResource.content).toContain("# Review#1 (running)");
	expect(fragmentResource.content).toContain("right review-fragment transcript");
	expect(fragmentResource.content).not.toContain("wrong review transcript");
});

it("agent:// falls back to a settled worker transcript when no output artifact exists", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "settled-root.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const mainSession = fakeSession(rootArtifactsDir);
	AgentRegistry.global().register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		session: mainSession,
		sessionFile: rootSessionFile,
	});

	const workerSessionFile = path.join(rootArtifactsDir, "OmpInstalledIntegration.jsonl");
	await fs.writeFile(workerSessionFile, transcriptJsonl("settled transcript finding"));
	AgentRegistry.global().register({
		id: "OmpInstalledIntegration",
		displayName: "OmpInstalledIntegration",
		kind: "sub",
		parentId: "Main",
		session: null,
		sessionFile: workerSessionFile,
		status: "idle",
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://OmpInstalledIntegration") as never);

	expect(resource.content).toContain("# OmpInstalledIntegration (idle)");
	expect(resource.content).toContain("settled transcript finding");
	expect(resource.sourcePath).toBe(workerSessionFile);
	expect(resource.notes).toContain("Source: session file (read-only, idle)");
});

it("agent:// transcript fallback preserves retained transcript read errors", async () => {
	const root = tempDir.path();
	const badSessionFile = path.join(root, "unreadable-worker.jsonl");
	await fs.mkdir(badSessionFile, { recursive: true });
	AgentRegistry.global().register({
		id: "UnreadableWorker",
		displayName: "UnreadableWorker",
		kind: "sub",
		session: null,
		sessionFile: badSessionFile,
		status: "idle",
	});

	let caught: unknown;
	try {
		await new AgentProtocolHandler().resolve(new URL("agent://UnreadableWorker") as never);
	} catch (error) {
		caught = error;
	}
	const message = caught instanceof Error ? caught.message : String(caught);

	expect(message).toMatch(/EISDIR|director/i);
	expect(message).not.toContain("No artifacts directory found");
	expect(message).not.toContain("Not found");
});

it("agent:// uses the registry output path when artifact directory scans cannot see it", async () => {
	const root = tempDir.path();
	const outputDir = path.join(root, "detached-output");
	await fs.mkdir(outputDir, { recursive: true });
	const outputPath = path.join(outputDir, "UpdaterLiveMap.md");
	await fs.writeFile(outputPath, "durable output from registry path");
	AgentRegistry.global().register({
		id: "UpdaterLiveMap",
		displayName: "UpdaterLiveMap",
		kind: "sub",
		session: null,
		sessionFile: null,
		status: "idle",
		history: { outputPath },
	});

	const handler = new AgentProtocolHandler();
	const resource = await handler.resolve(new URL("agent://UpdaterLiveMap") as never);

	expect(resource.content).toBe("durable output from registry path");
	expect(resource.sourcePath).toBe(outputPath);
	expect(await handler.locate(new URL("agent://UpdaterLiveMap") as never)).toBe(outputPath);
});

it("agent:// does not use another caller root's registered output path", async () => {
	const root = tempDir.path();
	const callerSessionFile = path.join(root, "caller-a.jsonl");
	const foreignOutputDir = path.join(root, "caller-b-output");
	await fs.mkdir(callerSessionFile.slice(0, -6), { recursive: true });
	await fs.mkdir(foreignOutputDir, { recursive: true });
	const foreignOutputPath = path.join(foreignOutputDir, "Worker.md");
	await fs.writeFile(foreignOutputPath, "foreign output");
	AgentRegistry.global().register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		session: null,
		sessionFile: null,
		status: "idle",
		history: { outputPath: foreignOutputPath },
	});

	const handler = new AgentProtocolHandler();
	const context = { sessionFile: callerSessionFile };

	expect(await handler.locate(new URL("agent://Worker") as never, context)).toBeNull();
	await expect(handler.resolve(new URL("agent://Worker") as never, context)).rejects.toThrow("Not found: Worker");
});

it("agent:// does not use another caller root's disk transcript", async () => {
	const root = tempDir.path();
	const callerSessionFile = path.join(root, "caller-disk-a.jsonl");
	const foreignArtifactsDir = path.join(root, "caller-disk-b");
	await fs.mkdir(callerSessionFile.slice(0, -6), { recursive: true });
	await fs.mkdir(foreignArtifactsDir, { recursive: true });
	await fs.writeFile(path.join(foreignArtifactsDir, "Worker.jsonl"), transcriptJsonl("foreign disk transcript"));
	registerArtifactsDir(foreignArtifactsDir);

	const handler = new AgentProtocolHandler();

	await expect(
		handler.resolve(new URL("agent://Worker") as never, { sessionFile: callerSessionFile }),
	).rejects.toThrow("Not found: Worker");
});

it("agent:// transcript fallback prefers the caller root over a foreign live worker", async () => {
	const root = tempDir.path();
	const callerSessionFile = path.join(root, "caller-live-a.jsonl");
	const callerArtifactsDir = callerSessionFile.slice(0, -6);
	const foreignSessionFile = path.join(root, "caller-live-b", "Worker.jsonl");
	const foreignArtifactsDir = path.dirname(foreignSessionFile);
	await fs.mkdir(callerArtifactsDir, { recursive: true });
	await fs.mkdir(foreignArtifactsDir, { recursive: true });
	const callerWorkerSessionFile = path.join(callerArtifactsDir, "Worker.jsonl");
	await fs.writeFile(callerWorkerSessionFile, transcriptJsonl("caller root transcript"));
	const foreignSession = fakeSession(foreignArtifactsDir, [
		{ role: "user", content: "foreign request", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "foreign live transcript" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	]);
	AgentRegistry.global().register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		session: foreignSession,
		sessionFile: foreignSessionFile,
		status: "running",
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://Worker") as never, {
		sessionFile: callerSessionFile,
	});

	expect(resource.content).toContain("caller root transcript");
	expect(resource.content).not.toContain("foreign live transcript");
	expect(resource.sourcePath).toBe(path.resolve(callerWorkerSessionFile));
});

it("agent:// transcript fallback prefers caller-owned live session over stale disk", async () => {
	const root = tempDir.path();
	const callerSessionFile = path.join(root, "caller-stale-live.jsonl");
	const callerArtifactsDir = callerSessionFile.slice(0, -6);
	await fs.mkdir(callerArtifactsDir, { recursive: true });
	const workerSessionFile = path.join(callerArtifactsDir, "Worker.jsonl");
	await fs.writeFile(workerSessionFile, transcriptJsonl("stale disk transcript"));
	const liveSession = fakeSession(callerArtifactsDir, [
		{ role: "user", content: "live request", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "fresh live transcript" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	]);
	AgentRegistry.global().register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		session: liveSession,
		sessionFile: workerSessionFile,
		status: "running",
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://Worker") as never, {
		sessionFile: callerSessionFile,
	});

	expect(resource.content).toContain("fresh live transcript");
	expect(resource.content).not.toContain("stale disk transcript");
	expect(resource.notes).toContain("Source: live session");
});

it("agent:// nested child is the dotted host; a slash on the parent is a JSON path, never a hierarchy hop", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "slash-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// Parent subagent adopts the root ArtifactManager; its own children are
	// written one level deeper under its sessionFile-derived dir, dot-qualified.
	const parentSessionFile = path.join(rootArtifactsDir, "Parent.jsonl");
	const parentOwnDir = parentSessionFile.slice(0, -6);
	await fs.mkdir(parentOwnDir, { recursive: true });
	await fs.writeFile(path.join(parentOwnDir, "Parent.Child.md"), "child capsule");
	// Parent output may be in the root dir; the nested child must still win.
	await fs.writeFile(path.join(rootArtifactsDir, "Parent.md"), JSON.stringify({ Child: "parent json field" }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: parentSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const dotted = await handler.resolve(new URL("agent://Parent.Child") as never);
	expect(dotted.content).toBe("child capsule");
	expect(dotted.contentType).toBe("text/markdown");
	// The slash never hops the hierarchy: it extracts `Child` from Parent.md.
	const slash = await handler.resolve(new URL("agent://Parent/Child") as never);
	expect(slash.content).toBe("parent json field");
});

it("agent:// path form extracts JSON by key and array index", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "json-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(
		path.join(rootArtifactsDir, "Worker.md"),
		JSON.stringify({ result: { ok: true }, reports: [{ data: "first report" }] }),
	);

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const extracted = await handler.resolve(new URL("agent://Worker/result") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toEqual({ ok: true });
	// Numeric segments index arrays; a string leaf reads as prose.
	const indexed = await handler.resolve(new URL("agent://Worker/reports/0/data") as never);
	expect(indexed.contentType).toBe("text/markdown");
	expect(indexed.content).toBe("first report");
	// A missing key yields `undefined`, not a crash or the whole document.
	const missing = await handler.resolve(new URL("agent://Worker/reports/5/data") as never);
	expect(missing.content).toBe("null");
});

it("agent:// path extraction prefers the <id>.json sidecar over the markdown body", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "sidecar-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	// Non-JSON body proves the fallback path could not have produced the answer.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.md"), "schema_violation summary text");
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), JSON.stringify({ summary: "ok", count: 7 }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const resource = await handler.resolve(new URL("agent://Worker/count") as never);
	expect(resource.contentType).toBe("application/json");
	expect(JSON.parse(resource.content)).toBe(7);
	expect(resource.sourcePath?.endsWith("Worker.json")).toBe(true);

	// A bare id keeps serving the markdown body, never the sidecar.
	const bare = await handler.resolve(new URL("agent://Worker") as never);
	expect(bare.contentType).toBe("text/markdown");
	expect(bare.content).toBe("schema_violation summary text");

	// A corrupt sidecar falls back to <id>.md instead of surfacing its own parse error.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), "{not json");
	await expect(handler.resolve(new URL("agent://Worker/count") as never)).rejects.toThrow(/Worker is not valid JSON/);
});
