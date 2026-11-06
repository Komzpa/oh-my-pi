import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const payload = "x".repeat(32 * 1024);

class CountingStorage extends FileSessionStorage {
	atomicWrites = 0;
	pauseAtomicMs = 0;
	onAtomicWrite?: (count: number) => void;
	atomicBytes = 0;
	syncWrites = 0;
	syncBytes = 0;

	override writeLinesSync(file: string, lines: readonly string[], options?: SessionStorageWriteOptions): void {
		this.syncWrites++;
		this.syncBytes += lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
		super.writeLinesSync(file, lines, options);
	}

	override async writeLinesAtomic(
		file: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.atomicWrites++;
		this.onAtomicWrite?.(this.atomicWrites);
		if (this.pauseAtomicMs) await Bun.sleep(this.pauseAtomicMs);
		this.atomicBytes += lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
		await super.writeLinesAtomic(file, lines, options);
	}
}

async function makeJournal(file: string, entries: number, sanitize = true): Promise<string> {
	const header =
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: crypto.randomUUID(),
			timestamp: new Date(0).toISOString(),
			cwd: "/tmp",
		}) + "\n";
	const handle = await fs.open(file, "w");
	try {
		await handle.write(header);
		let parentId: string | null = null;
		for (let i = 0; i < entries; i++) {
			const id = `entry-${i}`;
			await handle.write(
				`${JSON.stringify({ type: "custom", customType: "fixture", id, parentId, timestamp: i, data: payload })}\n`,
			);
			parentId = id;
		}
		await handle.write(
			`${JSON.stringify({
				type: "message",
				id: "stale-assistant",
				parentId,
				timestamp: entries,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale" },
						{ type: "text", text: "done" },
					],
					api: "openai-responses",
					provider: sanitize ? "github-copilot" : "openai",
					model: "gpt-5-mini",
					providerPayload: {
						type: "openaiResponsesHistory",
						provider: sanitize ? "github-copilot" : "openai",
						items: [{ type: "reasoning", encrypted_content: "stale" }],
					},
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				},
			})}\n`,
		);
	} finally {
		await handle.close();
	}
	return header;
}

describe("indexed rewrite persistence", () => {
	it("loads a large legacy journal without rewriting it and preserves its bytes on append", async () => {
		using temp = TempDir.createSync("@pi-rewrite-load-");
		const file = path.join(temp.path(), "large.jsonl");
		const header = await makeJournal(file, Number(process.env.OMP_REWRITE_FIXTURE_ENTRIES ?? 6400));
		const originalSize = (await fs.stat(file)).size;
		const storage = new CountingStorage();
		const manager = await SessionManager.open(file, "/tmp", storage, { suppressBreadcrumb: true });
		expect(storage.atomicWrites).toBe(0);
		expect(storage.syncWrites).toBe(0);
		expect(storage.atomicBytes + storage.syncBytes).toBe(0);
		const repaired = manager.getEntry("stale-assistant");
		if (repaired?.type !== "message" || repaired.message.role !== "assistant")
			throw new Error("Missing assistant fixture");
		expect(repaired.message.providerPayload).toBeUndefined();
		manager.appendMessage({ role: "user", content: "tail", timestamp: Date.now() });
		await manager.flush();
		console.log(
			JSON.stringify({
				resumeFixtureBytes: originalSize,
				atomicWrites: storage.atomicWrites,
				syncWrites: storage.syncWrites,
				rewrittenBytes: storage.atomicBytes + storage.syncBytes,
			}),
		);
		expect(storage.atomicWrites).toBe(0);
		expect(storage.syncWrites).toBe(0);
		expect(storage.atomicBytes + storage.syncBytes).toBe(0);

		const persisted = await fs.readFile(file, "utf8");
		expect(persisted.startsWith(header)).toBe(true);
		expect((await fs.stat(file)).size).toBeGreaterThan(originalSize);
		await manager.close();
	}, 120_000);

	it("keeps full indexed history and concurrent appends ordered within two rewrites", async () => {
		using temp = TempDir.createSync("@pi-rewrite-race-");
		const file = path.join(temp.path(), "large.jsonl");
		await makeJournal(file, Number(process.env.OMP_REWRITE_FIXTURE_ENTRIES ?? 6400), false);
		const storage = new CountingStorage();
		storage.pauseAtomicMs = 120;
		const manager = await SessionManager.open(file, "/tmp", storage, { suppressBreadcrumb: true });
		const intervals: number[] = [];
		let previous = performance.now();
		const heartbeat = setInterval(() => {
			const now = performance.now();
			intervals.push(now - previous);
			previous = now;
		}, 20);
		const tails: string[] = [];
		const appendTimer = setInterval(() => {
			const marker = `rewrite-tail-${tails.length}`;
			tails.push(marker);
			manager.appendMessage({ role: "user", content: marker, timestamp: Date.now() });
		}, 100);
		storage.onAtomicWrite = count => {
			if (count >= 3) clearInterval(appendTimer);
		};
		try {
			await manager.appendEntriesAtomically(() => manager.appendCustomEntry("batch-boundary"));
			await manager.flush();
		} finally {
			intervals.push(performance.now() - previous);
			clearInterval(appendTimer);
			clearInterval(heartbeat);
		}
		console.log(
			JSON.stringify({
				fixtureBytes: (await fs.stat(file)).size,
				atomicWrites: storage.atomicWrites,
				atomicBytes: storage.atomicBytes,
				syncWrites: storage.syncWrites,
				syncBytes: storage.syncBytes,
				appends: tails.length,
				maxHeartbeatGapMs: Math.max(...intervals),
			}),
		);
		expect(storage.syncWrites).toBe(0);
		expect(tails.length).toBeGreaterThan(0);
		expect(storage.atomicWrites).toBeLessThanOrEqual(2);
		await manager.close();
		const reopened = await SessionManager.open(file, "/tmp", new FileSessionStorage(), { suppressBreadcrumb: true });
		expect(
			reopened.getEntries().filter(entry => entry.type === "custom" && entry.customType === "fixture").length,
		).toBe(Number(process.env.OMP_REWRITE_FIXTURE_ENTRIES ?? 6400));
		const content = reopened
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));
		const actual = tails.map(marker => content.indexOf(marker));
		expect(actual.every(index => index >= 0)).toBe(true);
		expect(actual).toEqual([...actual].sort((a, b) => a - b));
		await reopened.close();
	}, 120_000);
});
