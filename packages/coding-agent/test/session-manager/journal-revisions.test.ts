import type { CustomEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ENTRY_REVISION, revisionRecord } from "@oh-my-pi/pi-coding-agent/session/journal-records";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadEntriesFromFileStream, parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

class CountingStorage extends FileSessionStorage {
	fullWrites = 0;
	onPublication?: () => Promise<void>;
	override writeLinesSync(file: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.fullWrites++;
		super.writeLinesSync(file, lines, options);
	}
	override async writeLinesAtomic(
		file: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.fullWrites++;
		await this.onPublication?.();
		await super.writeLinesAtomic(file, lines, options);
	}
}

describe("append-only journal revisions", () => {
	it("appends an edit arriving during a small explicit rewrite without publishing history again", async () => {
		using temp = TempDir.createSync("@omp-small-revision-race-");
		const storage = new CountingStorage();
		const manager = SessionManager.create(temp.path(), temp.path(), storage);
		const id = manager.appendCustomEntry("edited", { value: 1 });
		await manager.ensureOnDisk();
		storage.fullWrites = 0;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		storage.onPublication = async () => {
			started.resolve();
			await release.promise;
		};
		const rewrite = manager.rewriteEntries({ forceFullRewrite: true });
		await started.promise;
		const entry = manager.getEntry(id)!;
		if (entry.type !== "custom") throw new Error("Missing edit target");
		entry.data = { value: 2 };
		manager.updateEntry(entry);
		release.resolve();
		await rewrite;
		await manager.close();
		expect(storage.fullWrites).toBe(1);
		const reopened = await SessionManager.open(manager.getSessionFile()!, temp.path(), storage, {
			suppressBreadcrumb: true,
		});
		expect(reopened.getEntry(id)).toMatchObject({ data: { value: 2 } });
		await reopened.close();
	});

	it("replays ancestor and producer edits in their original order without moving the leaf", async () => {
		using temp = TempDir.createSync("@omp-journal-revision-");
		const storage = new CountingStorage();
		const manager = SessionManager.create(temp.path(), temp.path(), storage);
		const root = manager.appendCustomEntry("root", { value: 1 });
		const leaf = manager.appendCustomEntry("leaf", { value: 2 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		const prefix = await Bun.file(file).text();
		storage.fullWrites = 0;
		const ancestor = manager.getEntry(root)!;
		if (ancestor.type !== "custom") throw new Error("Missing ancestor");
		ancestor.data = { value: 3 };
		manager.updateEntry(ancestor);
		const tail = manager.getEntry(leaf)!;
		if (tail.type !== "custom") throw new Error("Missing leaf");
		tail.data = { value: 4 };
		await manager.rewriteEntries();
		expect(storage.fullWrites).toBe(0);
		expect(manager.getLeafId()).toBe(leaf);
		expect((await Bun.file(file).text()).startsWith(prefix)).toBe(true);
		const expected = manager.getEntries();
		expect(parseSessionContent(await Bun.file(file).text()).entries.slice(1)).toEqual(expected);
		expect((await loadEntriesFromFileStream(file)).entries.slice(1)).toEqual(expected);
		await manager.close();
		const reopened = await SessionManager.open(file, temp.path(), storage, { suppressBreadcrumb: true });
		expect(reopened.getEntries()).toEqual(expected);
		expect(reopened.getEntries().map(entry => entry.id)).toEqual([root, leaf]);
		expect(reopened.getLeafId()).toBe(leaf);
		await reopened.close();
	});

	it("persists workspace removals, cache identity and legacy titles by appending", async () => {
		using temp = TempDir.createSync("@omp-journal-metadata-");
		const file = path.join(temp.path(), "legacy.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: temp.path(),
			providerPromptCacheKey: "old",
		};
		const entry = { type: "custom", customType: "root", id: "root", parentId: null, timestamp: header.timestamp };
		const prefix = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
		await Bun.write(file, prefix);
		const storage = new CountingStorage();
		const manager = await SessionManager.open(file, temp.path(), storage, { suppressBreadcrumb: true });
		await manager.addWorkspaceDirectory("first");
		await manager.addWorkspaceDirectory("second");
		await manager.removeWorkspaceDirectory("first");
		await manager.setTaskPromptCacheKey("new-key");
		await manager.setSessionName("Legacy renamed", "user");
		await manager.close();
		expect(storage.fullWrites).toBe(0);
		expect((await Bun.file(file).text()).startsWith(prefix)).toBe(true);
		const reopened = await SessionManager.open(file, temp.path(), storage, { suppressBreadcrumb: true });
		expect(reopened.getAdditionalDirectories()).toEqual([path.join(temp.path(), "second")]);
		expect(reopened.getHeader()?.taskPromptCacheKey).toBe("new-key");
		expect(reopened.getHeader()?.providerPromptCacheKey).toBeUndefined();
		expect(reopened.getSessionName()).toBe("Legacy renamed");
		expect(parseSessionContent(await Bun.file(file).text()).entries[0]).toMatchObject({
			title: "Legacy renamed",
			taskPromptCacheKey: "new-key",
		});
		await reopened.close();
	});
	it("keeps usage exact through revisions and repeated traffic after an explicit repair", async () => {
		using temp = TempDir.createSync("@omp-journal-mix-");
		const storage = new CountingStorage();
		const manager = SessionManager.create(temp.path(), temp.path(), storage);
		const root = manager.appendCustomEntry("root");
		const usageId = manager.appendModelUsage(
			{
				purpose: "test",
				api: "test",
				provider: "test",
				model: "test",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
				},
			},
			{ sessionId: manager.getSessionId(), parentId: root },
		)!;
		await manager.ensureOnDisk();
		await manager.rewriteEntries({ forceFullRewrite: true });
		storage.fullWrites = 0;
		const file = manager.getSessionFile()!;
		const prefix = await Bun.file(file).text();
		for (let i = 0; i < 3; i++) {
			const usage = manager.getEntry(usageId)!;
			if (usage.type !== "model_usage") throw new Error("Missing usage");
			usage.usage.input = 10 + i;
			usage.usage.totalTokens = 12 + i;
			manager.updateEntry(usage);
			await manager.appendEntriesAtomically(() => {
				manager.appendCustomMessageEntry("deferred-note", `note-${i}`, false);
				manager.appendCustomEntry("omp:restart-pending-queues", { steering: [] });
			});
			await manager.rewriteEntries();
		}
		expect(manager.getUsageStatistics().input).toBe(12);
		expect(manager.getUsageStatistics().cost).toBe(1);
		expect(storage.fullWrites).toBe(0);
		expect((await Bun.file(file).text()).startsWith(prefix)).toBe(true);
		const leaf = manager.getLeafId();
		await manager.close();
		const reopened = await SessionManager.open(file, temp.path(), storage, { suppressBreadcrumb: true });
		expect(reopened.getUsageStatistics().input).toBe(12);
		expect(reopened.getUsageStatistics().cost).toBe(1);
		expect(reopened.getLeafId()).toBe(leaf);
		expect(reopened.getEntries().filter(entry => entry.id === usageId)).toHaveLength(1);
		await reopened.close();
	});
	it("folds a revised executor observation before resume compaction", async () => {
		using temp = TempDir.createSync("@omp-revised-observation-");
		const file = path.join(temp.path(), "session.jsonl");
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: temp.path(),
		};
		const observations: CustomEntry[] = Array.from({ length: 8 }, (_, i) => ({
			type: "custom",
			customType: "user_todo_edit",
			id: `e${i}`,
			parentId: i ? `e${i - 1}` : null,
			timestamp: header.timestamp,
			data: {
				edit: {
					v: 1,
					kind: "executor",
					at: i,
					observation: {
						workerId: "worker",
						row: "row",
						taskText: "task",
						startedAt: i,
						finishedAt: i + 1,
						outcome: "aborted",
					},
				},
			},
		}));
		const revised: CustomEntry = {
			...observations[3],
			data: {
				edit: {
					v: 1,
					kind: "executor",
					at: 100,
					observation: {
						workerId: "worker",
						row: "row",
						taskText: "task",
						startedAt: 3,
						finishedAt: 4,
						outcome: "aborted",
					},
				},
			},
		};
		await Bun.write(
			file,
			[header, ...observations, revisionRecord(ENTRY_REVISION, revised)]
				.map(entry => JSON.stringify(entry))
				.join("\n") + "\n",
		);
		const logical = await loadEntriesFromFileStream(file, { compactExecutorObservations: true });
		const manager = await SessionManager.open(file, temp.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		expect(manager.getEntry("e3")).toEqual(revised);
		expect(manager.getEntries()).toEqual(
			logical.entries.filter((entry): entry is CustomEntry => entry.type === "custom"),
		);
		await manager.close();
	});

	it("applies normal tool persistence projection inside revision records", async () => {
		using temp = TempDir.createSync("@omp-revision-projection-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const id = manager.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "mcp_test",
			content: [{ type: "text", text: "spilled result" }],
			isError: false,
			timestamp: 1,
			details: {
				serverName: "server",
				mcpToolName: "test",
				structuredContent: { secretDuplicate: "duplicate payload" },
				meta: { truncation: { artifactId: "result-1" } },
			},
		});
		await manager.ensureOnDisk();
		const entry = manager.getEntry(id)!;
		if (entry.type !== "message" || entry.message.role !== "toolResult") throw new Error("Missing tool result");
		entry.message.content = [{ type: "text", text: "updated artifact pointer" }];
		manager.updateEntry(entry);
		const persisted = parseSessionContent(await Bun.file(manager.getSessionFile()!).text()).entries.find(
			entry => entry.id === id,
		);
		if (persisted?.type !== "message" || persisted.message.role !== "toolResult")
			throw new Error("Missing persisted tool result");
		expect(persisted.message.content).toEqual([{ type: "text", text: "updated artifact pointer" }]);
		expect(persisted.message.details).toEqual({
			serverName: "server",
			mcpToolName: "test",
			meta: { truncation: { artifactId: "result-1" } },
		});
		expect(entry.message.details).toHaveProperty("structuredContent");
		await manager.close();
	});

	it("rejects old accounting-free handoff caches before applying a usage revision", async () => {
		using temp = TempDir.createSync("@omp-revision-old-cache-");
		const manager = SessionManager.create(temp.path(), temp.path());
		const id = manager.appendModelUsage(
			{
				purpose: "test",
				api: "test",
				provider: "test",
				model: "test",
				stopReason: "stop",
				usage: {
					input: 10,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
				},
			},
			{ sessionId: manager.getSessionId(), parentId: null },
		)!;
		await manager.ensureOnDisk();
		expect(await manager.writeIndexHandoff()).toBe(true);
		const file = manager.getSessionFile()!;
		await manager.close();
		const cache = (await Bun.file(`${file}.index-handoff`).json()) as {
			version: number;
			ordered: Array<{ accountedUsage?: unknown }>;
		};
		cache.version = 1;
		for (const entry of cache.ordered) delete entry.accountedUsage;
		await Bun.write(`${file}.index-handoff`, JSON.stringify(cache));
		const reopened = await SessionManager.open(file, temp.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		const usage = reopened.getEntry(id)!;
		if (usage.type !== "model_usage") throw new Error("Missing usage");
		usage.usage.input = 20;
		usage.usage.totalTokens = 20;
		usage.usage.cost.total = 2;
		reopened.updateEntry(usage);
		expect(reopened.getUsageStatistics().input).toBe(20);
		expect(reopened.getUsageStatistics().cost).toBe(2);
		await reopened.close();
	});
	it("appends established non-file batches and revisions without publishing the full body", async () => {
		class CountingMemoryStorage extends MemorySessionStorage {
			fullWrites = 0;
			override writeTextSync(file: string, text: string, options?: SessionStorageWriteOptions): void {
				this.fullWrites++;
				super.writeTextSync(file, text, options);
			}
		}
		const storage = new CountingMemoryStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		const root = manager.appendCustomEntry("root", { value: 1 });
		await manager.ensureOnDisk();
		storage.fullWrites = 0;
		await manager.appendEntriesAtomically(() => {
			manager.appendCustomMessageEntry("deferred-note", "notice", false);
			manager.appendCustomEntry("omp:restart-pending-queues", { steering: [] });
		});
		const entry = manager.getEntry(root)!;
		if (entry.type !== "custom") throw new Error("Missing root");
		entry.data = { value: 2 };
		await manager.rewriteEntries();
		await manager.setTaskPromptCacheKey("key");
		expect(storage.fullWrites).toBe(0);
		const file = manager.getSessionFile()!;
		const expected = manager.getEntries();
		await manager.close();
		const reopened = await SessionManager.open(file, "/sessions", storage, { suppressBreadcrumb: true });
		expect(reopened.getEntries()).toEqual(expected);
		expect(reopened.getHeader()?.taskPromptCacheKey).toBe("key");
		await reopened.close();
	});
});
