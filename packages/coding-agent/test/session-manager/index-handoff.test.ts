import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readCheckpointRewindState } from "@oh-my-pi/pi-coding-agent/session/checkpoint-entries";
import * as loader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const temporary: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function journal(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-index-handoff-"));
	temporary.push(directory);
	const file = path.join(directory, "session.jsonl");
	const timestamp = "2026-11-06T00:00:00.000Z";
	await Bun.write(
		file,
		[
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "session", cwd: directory, timestamp },
			{
				type: "custom",
				id: "history",
				parentId: null,
				timestamp,
				customType: "history",
				data: "x".repeat(1024 * 1024),
			},
			{ type: "label", id: "label", parentId: "history", timestamp, targetId: "history", label: "bookmark" },
			{ type: "reset_boundary", id: "reset", parentId: "label", timestamp },
			{
				type: "message",
				id: "tail",
				parentId: "reset",
				timestamp,
				message: { role: "user", content: "current", timestamp: 1 },
			},
		]
			.map(row => JSON.stringify(row))
			.join("\n") + "\n",
	);
	return file;
}

async function rolloverJournal(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rollover-index-handoff-"));
	temporary.push(directory);
	const file = path.join(directory, "session.jsonl");
	const timestamp = "2026-11-10T00:00:00.000Z";
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const assistant = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: 1,
	});
	const rows = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: "session", cwd: directory, timestamp },
		{
			type: "message",
			id: "human-request",
			parentId: null,
			timestamp,
			message: { role: "user", content: "HUMAN_REQUEST_BEFORE_INTERNAL_STEER", timestamp: 1 },
		},
		{
			type: "message",
			id: "earlier-work",
			parentId: "human-request",
			timestamp,
			message: assistant("Earlier work."),
		},
		{
			type: "message",
			id: "internal-steer",
			parentId: "earlier-work",
			timestamp,
			message: {
				role: "user",
				content: "INTERNAL_AGENT_WRITE_SCOPE_STEER",
				attribution: "agent",
				steering: true,
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "retained-tail",
			parentId: "internal-steer",
			timestamp,
			message: assistant("Retained rollover tail."),
		},
		{
			type: "compaction",
			id: "rollover",
			parentId: "retained-tail",
			timestamp,
			summary: "Context rollover",
			firstKeptEntryId: "retained-tail",
			tokensBefore: 100,
			details: { kind: "experimental-context-rollover", version: 1 },
		},
		{
			type: "message",
			id: "after-rollover",
			parentId: "rollover",
			timestamp,
			message: { role: "user", content: "REQUEST_AFTER_ROLLOVER", timestamp: 3 },
		},
	];
	await Bun.write(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
	return file;
}

async function open(file: string): Promise<SessionManager> {
	const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
	managers.push(manager);
	return manager;
}

test("replacement restores context, bookmarks and lazy history without parsing the journal", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const parse = spyOn(loader, "visitSessionFileForResume").mockImplementation(async () => {
		throw new Error("replacement reparsed the journal");
	});
	try {
		const restored = await open(file);
		expect(restored.getEntryCount()).toBe(4);
		expect(restored.getLeafId()).toBe("tail");
		expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
		expect(restored.getEntry("history")).toEqual(original.getEntry("history"));
		expect(restored.getLabel("history")).toBe("bookmark");
		expect(restored.getChildren("history").map(entry => entry.id)).toEqual(["label"]);
		const base = await Bun.file(`${file}.index-handoff`).text();
		const appended = restored.appendCustomEntry("checkpoint", { revision: 2 });
		expect(restored.getChildren("tail").map(entry => entry.id)).toEqual([appended]);
		expect(await restored.writeIndexHandoff()).toBe(true);
		expect(await Bun.file(`${file}.index-handoff`).text()).toBe(base);
		const next = await open(file);
		expect(next.getEntry(appended)).toMatchObject({ customType: "checkpoint", data: { revision: 2 } });
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
});

test("an appended journal invalidates the handoff and resumes the new tail", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	await fs.appendFile(
		file,
		JSON.stringify({
			type: "custom",
			id: "new",
			parentId: "tail",
			timestamp: "2026-11-06T01:00:00Z",
			customType: "checkpoint",
			data: 2,
		}) + "\n",
	);
	const parse = spyOn(loader, "visitSessionFileForResume");
	try {
		const restored = await open(file);
		expect(restored.getLeafId()).toBe("new");
		expect(restored.getEntryCount()).toBe(5);
		expect(parse).toHaveBeenCalledTimes(1);
	} finally {
		parse.mockRestore();
	}
});

test("same-length journal edits invalidate the handoff even when mtime is preserved", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const before = await fs.stat(file);
	await Bun.write(file, (await Bun.file(file).text()).replace('"id":"tail"', '"id":"edit"'));
	await fs.utimes(file, before.atime, before.mtime);
	const restored = await open(file);
	expect(restored.getLeafId()).toBe("edit");
	expect(restored.getEntry("tail")).toBeUndefined();
});

test("an invalid handoff range falls back without duplicating partially restored entries", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const cache = Bun.file(`${file}.index-handoff`);
	const snapshot = await cache.json();
	snapshot.ordered[1].length = -1;
	await Bun.write(cache, JSON.stringify(snapshot));
	const restored = await open(file);
	expect(restored.getEntryCount()).toBe(4);
	expect(restored.getLeafId()).toBe("tail");
	expect(restored.getLabel("history")).toBe("bookmark");
});

test.skipIf(!process.env.OMP_HANDOFF_BENCH)(
	"500 MB / 200k entries resume from the handoff without journal parsing",
	async () => {
		const file = await journal();
		const directory = path.dirname(file);
		const timestamp = "2026-11-06T00:00:00.000Z";
		const writer = Bun.file(file).writer();
		writer.write(
			JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "large", cwd: directory, timestamp }) +
				"\n",
		);
		for (let i = 0; i < 199998; i++) {
			writer.write(
				JSON.stringify({
					type: "custom",
					id: `row-${i}`,
					parentId: i ? `row-${i - 1}` : null,
					timestamp,
					customType: "history",
					data: "x".repeat(2500),
				}) + "\n",
			);
			if (i % 1024 === 0) await writer.flush();
		}
		writer.write(JSON.stringify({ type: "reset_boundary", id: "reset", parentId: "row-199997", timestamp }) + "\n");
		writer.write(
			JSON.stringify({
				type: "message",
				id: "tail",
				parentId: "reset",
				timestamp,
				message: { role: "user", content: "current", timestamp: 1 },
			}) + "\n",
		);
		await writer.end();
		const original = await open(file);
		const writeStart = performance.now();
		expect(await original.writeIndexHandoff()).toBe(true);
		const writeMs = performance.now() - writeStart;
		const parse = spyOn(loader, "visitSessionFileForResume").mockImplementation(async () => {
			throw new Error("replacement reparsed large journal");
		});
		try {
			const times: number[] = [];
			for (let i = 0; i < 3; i++) {
				const start = performance.now();
				const restored = await open(file);
				times.push(performance.now() - start);
				expect(restored.getEntryCount()).toBe(200000);
				expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
			}
			expect(parse).not.toHaveBeenCalled();
			console.info(
				JSON.stringify({
					journalBytes: (await fs.stat(file)).size,
					handoffBytes: (await fs.stat(`${file}.index-handoff`)).size,
					entries: 200000,
					writeMs,
					openMs: times,
				}),
			);
		} finally {
			parse.mockRestore();
		}
	},
	60000,
);

test("prepared index stays current across appends without replacing its base", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const base = await Bun.file(`${file}.index-handoff`).text();
	const id = original.appendCustomEntry("restart-checkpoint", { value: 42 });
	await original.flush();
	expect(await Bun.file(`${file}.index-handoff`).text()).toBe(base);
	const parse = spyOn(loader, "visitSessionFileForResume").mockImplementation(async () => {
		throw new Error("incremental handoff reparsed journal");
	});
	try {
		const restored = await open(file);
		expect(restored.getLeafId()).toBe(id);
		expect(restored.getEntry(id)).toMatchObject({ customType: "restart-checkpoint", data: { value: 42 } });
		expect(restored.getEntryCount()).toBe(5);
		expect(restored.getLabel("history")).toBe("bookmark");
	} finally {
		parse.mockRestore();
	}
});

test("overlapping index preparation calls publish one usable handoff", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await Promise.all([original.writeIndexHandoff(), original.writeIndexHandoff()])).toEqual([true, true]);
	const restored = await open(file);
	expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
});

test("an external same-size edit cannot be recertified by repeated handoff requests", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	await Bun.write(file, (await Bun.file(file).text()).replace('"id":"history"', '"id":"changed"'));
	// The handoff cache is keyed by stat metadata. Make the mutation distinct even
	// on filesystems whose ctime/mtime clock can repeat within one tick.
	const changed = new Date(Date.now() + 1000);
	await fs.utimes(file, changed, changed);
	expect(await original.writeIndexHandoff()).toBe(false);
	expect(await original.writeIndexHandoff()).toBe(false);
	const restored = await open(file);
	expect(restored.getEntry("changed")).toMatchObject({ customType: "history" });
	expect(restored.getEntry("history")).toBeUndefined();
});

test("switching journals starts a fresh incremental handoff after appending", async () => {
	const original = await open(await journal());
	await original.writeIndexHandoff();
	const next = await journal();
	await original.setSessionFile(next);
	const id = original.appendCustomEntry("after-switch", { value: 1 });
	expect(await original.writeIndexHandoff()).toBe(true);
	const restored = await open(next);
	expect(restored.getLeafId()).toBe(id);
	expect(restored.getEntry(id)).toMatchObject({ customType: "after-switch", data: { value: 1 } });
});

test("a pre-selection-metadata handoff falls back to the journal and restores its checkpoint", async () => {
	const file = await journal();
	const original = await open(file);
	const startedAt = "2026-11-07T00:00:00.000Z";
	const checkpoint = original.appendMessage({
		role: "toolResult",
		toolName: "checkpoint",
		toolCallId: "checkpoint",
		isError: false,
		content: [{ type: "text", text: "saved" }],
		details: { startedAt },
		timestamp: 2,
	});
	expect(await original.writeIndexHandoff()).toBe(true);
	const handoff = Bun.file(`${file}.index-handoff`);
	const legacy = (await handoff.json()) as { version: number; ordered: Array<{ checkpointKind?: string }> };
	legacy.version = 2;
	for (const row of legacy.ordered) delete row.checkpointKind;
	await Bun.write(handoff, JSON.stringify(legacy));
	const restored = await open(file);
	expect(readCheckpointRewindState(restored).checkpoint).toEqual({
		checkpointEntryId: checkpoint,
		checkpointMessageCount: 2,
		startedAt,
	});
});

test("a v3 handoff with a stale agent-steer request boundary reloads canonical journal metadata", async () => {
	const file = await rolloverJournal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const handoff = Bun.file(`${file}.index-handoff`);
	const snapshot = await handoff.json();
	const agentSteer = snapshot.ordered.find((entry: { id: string }) => entry.id === "internal-steer");
	expect(snapshot.version).toBe(4);
	expect(agentSteer).toMatchObject({ userRequest: false });
	snapshot.version = 3;
	agentSteer.userRequest = true;
	await Bun.write(handoff, JSON.stringify(snapshot));

	const parse = spyOn(loader, "visitSessionFileForResume");
	const restored = await open(file);
	const rebuilt = JSON.stringify(restored.buildSessionContext().messages);
	expect(rebuilt).toContain("HUMAN_REQUEST_BEFORE_INTERNAL_STEER");
	expect(rebuilt).not.toContain("INTERNAL_AGENT_WRITE_SCOPE_STEER");
	expect(rebuilt).toContain("REQUEST_AFTER_ROLLOVER");
	expect(parse).toHaveBeenCalledTimes(1);
});
