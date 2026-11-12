import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionEntry } from "../src/session/session-entries";
import { loadEntriesFromFileStream } from "../src/session/session-loader";
import { SessionManager } from "../src/session/session-manager";

it("bounds executor replay while preserving row edits, attempt history and old branch targets", async () => {
	const dir = TempDir.createSync("executor-replay-");
	try {
		const file = path.join(dir.path(), "journal.jsonl");
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id: "session", timestamp: "2026-11-07T00:00:00Z", cwd: dir.path() },
		];
		const base: SessionEntry = {
			type: "custom",
			customType: "user_todo_edit",
			id: "base",
			parentId: null,
			timestamp: "2026-11-07T00:00:00Z",
			data: {
				phases: [
					{
						name: "Work",
						tasks: [
							{
								content: "Row",
								status: "in_progress",
								schedule: { owner: "prior", executor: { workerId: "prior", startedAt: 750 } },
							},
						],
					},
				],
			},
		};
		entries.push(base);
		for (let i = 0; i < 1000; i++)
			entries.push({
				type: "custom",
				customType: "user_todo_edit",
				id: `e${i}`,
				parentId: i ? `e${i - 1}` : "base",
				timestamp: base.timestamp,
				data: {
					edit: {
						v: 1,
						kind: "executor",
						at: i,
						observation: {
							workerId: "worker",
							row: "Row",
							taskText: "IRC follow-up",
							startedAt: i,
							...(i % 2 ? { finishedAt: i + 1, outcome: "aborted" } : {}),
						},
					},
				},
			});
		// Even when early starts are stale, a later start must take ownership before its completion.
		await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n"));
		const beforeFork = await loadEntriesFromFileStream(file, { compactExecutorObservations: true });
		const projected = beforeFork.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
		expect(beforeFork.entries.length).toBeLessThan(6);
		expect(projected.at(-1)).toMatchObject({
			data: {
				edit: {
					observation: {
						workerId: "worker",
						startedAt: 999,
						finishedAt: 1000,
						outcome: "aborted",
					},
				},
			},
		});
		const original = await Bun.file(file).text();
		const manager = await SessionManager.open(file, dir.path());
		expect(manager.getEntries()).toEqual(projected);
		expect(await Bun.file(file).text()).toBe(original);

		entries.push({
			type: "custom",
			customType: "user_todo_edit",
			id: "attempt",
			parentId: "e999",
			timestamp: base.timestamp,
			data: {
				edit: {
					v: 1,
					kind: "attempt",
					at: 1001,
					phase: "Work",
					content: "Row",
					attempt: {
						attemptId: "attempt-1",
						workerName: "worker",
						resolvedModel: "mock",
						effort: "low",
						startedAt: 0,
						finishedAt: 1001,
						durationMs: 1001,
						terminalStatus: "failed",
						deliverablePaths: [],
						rejectionReason: "Needs proof",
					},
				},
			},
		});
		// Fork from a record inside the hot run: its exact historical state must remain addressable.
		entries.push({
			type: "custom",
			customType: "branch-marker",
			id: "fork",
			parentId: "e500",
			timestamp: base.timestamp,
		});
		await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n"));
		const raw = await loadEntriesFromFileStream(file);
		const compact = await loadEntriesFromFileStream(file, { compactExecutorObservations: true });
		expect(raw.entries).toHaveLength(1004);
		expect(compact.entries.length).toBeLessThanOrEqual(10);
		const sessionEntries = (items: FileEntry[]) =>
			items.filter((entry): entry is SessionEntry => entry.type !== "session");
		expect(compact.entries.find(entry => entry.type !== "session" && entry.id === "e500")).toEqual(entries[502]);
		expect(compact.entries.find(entry => entry.type !== "session" && entry.id === "attempt")).toEqual(entries.at(-2));
		const beforeResume = await Bun.file(file).text();
		const resumed = await SessionManager.open(file, dir.path());
		expect(resumed.getEntries()).toEqual(sessionEntries(compact.entries));
		expect(await Bun.file(file).text()).toBe(beforeResume);
		const ids = new Set(sessionEntries(compact.entries).map(entry => entry.id));
		for (const entry of sessionEntries(compact.entries))
			if (entry.parentId) expect(ids.has(entry.parentId)).toBe(true);
	} finally {
		dir.removeSync();
	}
});
