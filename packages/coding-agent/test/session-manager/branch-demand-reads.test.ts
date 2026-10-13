import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getLatestTodoPhasesFromEntries,
	isTodoStateEntryMetadata,
	shouldPersistTodoFullSnapshotCheckpoint,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	countDemandReads,
	DEAD_SNAPSHOT_CUSTOM_TYPE,
	type DemandPosition,
	type DemandReadCounter,
	inventoryDemandPositions,
	writeDemandFixture,
} from "./fixtures/branch-demand-read-fixture";

// Run after the integration freeze:
// bun test packages/coding-agent/test/session-manager/branch-demand-reads.test.ts
// Unit: completed positioned JSONL payload reads after SessionManager.open.
// The spy runs only in a child process; no patched module binding reaches other tests.
// Stay just above the streaming loader threshold; the standalone probe scales to 400 MiB.
const SNAPSHOT_COUNT = 40;
const SNAPSHOT_BYTES = 256 * 1024;
if (process.env.OMP_BRANCH_DEMAND_READ_CHILD !== "1") {
	describe("isolated branch demand-read instrumentation", () => {
		it("proves selective reads and the legacy full-branch negative control", async () => {
			const child = Bun.spawn([process.execPath, "test", import.meta.path], {
				cwd: path.resolve(import.meta.dir, "../../../.."),
				env: { ...process.env, OMP_BRANCH_DEMAND_READ_CHILD: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		}, 60_000);
	});
} else {
	describe("branch accessors demand-read only selected payloads", () => {
		let directory: string;
		let file: string;
		let positions: DemandPosition[];
		let originalHash: string;

		async function hashFile(): Promise<string> {
			const hash = createHash("sha256");
			for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
			return hash.digest("hex");
		}

		beforeAll(async () => {
			directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-branch-demand-"));
			file = path.join(directory, "session.jsonl");
			positions = await writeDemandFixture(file, SNAPSHOT_COUNT, SNAPSHOT_BYTES);
			originalHash = await hashFile();
			expect(Bun.file(file).size).toBeGreaterThan(SNAPSHOT_COUNT * SNAPSHOT_BYTES);
		}, 60_000);

		afterAll(async () => {
			if (directory) await fs.rm(directory, { recursive: true, force: true });
		});

		async function withReader(check: (manager: SessionManager, counter: DemandReadCounter) => void) {
			const manager = await SessionManager.open(file, directory, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			const counter = countDemandReads(file, positions);
			try {
				check(manager, counter);
			} finally {
				counter.restore();
				await manager.close();
			}
			expect(await hashFile()).toBe(originalHash);
		}

		it("chronological matching skips irrelevant snapshots and never caches hits", async () => {
			await withReader((manager, counter) => {
				const entries = manager.getBranchMatching(isTodoStateEntryMetadata);
				expect(entries.map(entry => entry.id)).toEqual(["todo-first", "todo-last", "hud"]);
				expect(getLatestTodoPhasesFromEntries(entries)).toEqual([
					{ name: "Work", tasks: [{ content: "latest", status: "pending" }] },
				]);
				expect(counter.snapshot()).toMatchObject({
					entryReadEvents: 3,
					deadSnapshotReadEvents: 0,
					uniqueDeadSnapshotsRead: 0,
					positionedPayloadBytes: positions
						.filter(position => ["todo-first", "todo-last", "hud"].includes(position.id))
						.reduce((total, position) => total + position.length, 0),
				});
				counter.reset();
				expect(manager.getBranchMatching(isTodoStateEntryMetadata).map(entry => entry.id)).toEqual(
					entries.map(entry => entry.id),
				);
				// Retaining the first result must not install a cache in the manager.
				expect(counter.snapshot()).toMatchObject({ entryReadEvents: 3, uniqueDeadSnapshotsRead: 0 });
				counter.reset();
				expect(
					manager
						.getBranchMatching(
							metadata =>
								metadata.type === "message" &&
								metadata.messageRole === "toolResult" &&
								metadata.toolName === "read",
						)
						.map(entry => entry.id),
				).toEqual(["read-result"]);
				expect(counter.snapshot().ids).toEqual(["read-result"]);
			});
		}, 60_000);

		it("stops the todo checkpoint scan at the newest snapshot", async () => {
			await withReader((manager, counter) => {
				expect(
					shouldPersistTodoFullSnapshotCheckpoint(
						manager.iterateBranchMatchingNewestFirst(isTodoStateEntryMetadata),
					),
				).toBe(false);
				expect(counter.snapshot()).toMatchObject({
					ids: ["hud", "todo-last"],
					deadSnapshotReadEvents: 0,
				});
			});
		}, 60_000);

		it("latest matching reads one hit, reads nothing on misses, and follows branch selection", async () => {
			await withReader((manager, counter) => {
				const latest = manager.getLatestBranchMatching(
					metadata => metadata.type === "custom" && metadata.customType === DEAD_SNAPSHOT_CUSTOM_TYPE,
				);
				expect(latest?.id).toBe(`snapshot-${SNAPSHOT_COUNT - 1}`);
				if (latest?.type !== "custom") throw new Error("Expected historical custom snapshot");
				const data = latest.data;
				assert(data !== null && typeof data === "object" && "index" in data && "payload" in data);
				expect(data.index).toBe(SNAPSHOT_COUNT - 1);
				assert(typeof data.payload === "string");
				expect(data.payload).toContain("🐈");
				expect(counter.snapshot()).toMatchObject({
					entryReadEvents: 1,
					deadSnapshotReadEvents: 1,
					uniqueDeadSnapshotsRead: 1,
					positionedPayloadBytes: positions.find(position => position.id === latest.id)!.length,
				});
				counter.reset();
				expect(
					manager.getLatestBranchMatching(
						metadata => metadata.type === "custom" && metadata.customType === DEAD_SNAPSHOT_CUSTOM_TYPE,
					)?.id,
				).toBe(latest.id);
				expect(counter.snapshot().entryReadEvents).toBe(1);
				counter.reset();
				expect(
					manager.getLatestBranchMatching(
						metadata => metadata.type === "custom" && metadata.customType === "absent-probe-type",
					),
				).toBeUndefined();
				expect(
					manager.getBranchMatching(
						metadata => metadata.type === "custom" && metadata.customType === "absent-probe-type",
					),
				).toEqual([]);
				expect(counter.snapshot().entryReadEvents).toBe(0);
				manager.branch("todo-first");
				counter.reset();
				expect(
					manager.getLatestBranchMatching(
						metadata => metadata.type === "custom" && metadata.customType === DEAD_SNAPSHOT_CUSTOM_TYPE,
					),
				).toBeUndefined();
				expect(
					manager.getLatestBranchMatching(
						metadata => metadata.type === "custom" && metadata.customType === USER_TODO_EDIT_CUSTOM_TYPE,
					)?.id,
				).toBe("todo-first");
				// branch() has already loaded this request into its active context.
				expect(counter.snapshot()).toMatchObject({ entryReadEvents: 0, uniqueDeadSnapshotsRead: 0 });
			});
		}, 60_000);

		it("projects prune notices for selective display/copy without reading sprint snapshots", async () => {
			const pruneFile = path.join(directory, "pruned-session.jsonl");
			await writeDemandFixture(pruneFile, SNAPSHOT_COUNT, SNAPSHOT_BYTES);
			const timestamp = "2026-01-01T00:00:00.000Z";
			const additions = [
				{
					type: "tool_result_prune",
					id: "first-prune",
					parentId: "current-user",
					prunedAt: 100,
					targets: [
						{ entryId: "read-result", notice: "[First prune notice]" },
						{ entryId: "read-result", notice: "[Duplicate target must not win]" },
						{ entryId: "future-result", notice: "[Premature prune must not apply]" },
					],
				},
				{
					type: "tool_result_prune",
					id: "second-prune",
					parentId: "first-prune",
					prunedAt: 200,
					targets: [{ entryId: "read-result", notice: "[Second prune must not win]" }],
				},
				...["unrelated-result", "future-result"].map((id, index) => ({
					type: "message",
					id,
					parentId: index === 0 ? "second-prune" : "unrelated-result",
					message: {
						role: "toolResult",
						toolName: "read",
						toolCallId: id,
						content: [{ type: "text", text: `${id} original output` }],
						isError: false,
						timestamp: 6 + index,
					},
				})),
				{
					type: "message",
					id: "prune-context-tail",
					parentId: "future-result",
					message: { role: "user", content: "kept prune tail", timestamp: 8 },
				},
				{
					type: "compaction",
					id: "prune-compaction",
					parentId: "prune-context-tail",
					summary: "Keep measured prune overlays outside the active context",
					firstKeptEntryId: "prune-context-tail",
					tokensBefore: 1,
				},
			];
			await fs.appendFile(
				pruneFile,
				additions.map(entry => `${JSON.stringify({ ...entry, timestamp })}\n`).join(""),
			);
			const prunePositions = await inventoryDemandPositions(pruneFile);
			const manager = await SessionManager.open(pruneFile, directory, undefined, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			const counter = countDemandReads(pruneFile, prunePositions);
			const isReadResult = (metadata: SessionContextEntryMetadata) =>
				metadata.messageRole === "toolResult" && metadata.toolName === "read";
			const visibleText = (entry: SessionEntry | undefined) => {
				assert(entry?.type === "message" && entry.message.role === "toolResult");
				return entry.message.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			};
			try {
				expect(manager.getBranchMatching(() => false)).toEqual([]);
				expect(manager.getLatestBranchMatching(() => false)).toBeUndefined();
				expect([...manager.iterateBranchMatchingNewestFirst(() => false)]).toEqual([]);
				expect(counter.snapshot().entryReadEvents).toBe(0);

				const results = manager.getBranchMatching(isReadResult);
				expect(results.map(entry => entry.id)).toEqual(["read-result", "unrelated-result", "future-result"]);
				expect(results.map(visibleText)).toEqual([
					"[First prune notice]",
					"unrelated-result original output",
					"future-result original output",
				]);
				assert(results[0]?.type === "message" && results[0].message.role === "toolResult");
				expect(results[0].message.prunedAt).toBe(100);
				expect(counter.snapshot()).toMatchObject({ entryReadEvents: 5, deadSnapshotReadEvents: 0 });

				counter.reset();
				expect(visibleText(manager.getLatestBranchMatching(metadata => metadata.id === "read-result"))).toBe(
					"[First prune notice]",
				);
				expect(counter.snapshot()).toMatchObject({ entryReadEvents: 3, deadSnapshotReadEvents: 0 });

				counter.reset();
				const newest = manager.iterateBranchMatchingNewestFirst(isReadResult);
				expect(counter.snapshot().entryReadEvents).toBe(0);
				expect(visibleText(newest.next().value)).toBe("future-result original output");
				expect(counter.snapshot().ids).toEqual(["future-result"]);
				expect(visibleText(newest.next().value)).toBe("unrelated-result original output");
				expect(counter.snapshot().ids).toEqual(["future-result", "unrelated-result"]);
				expect(visibleText(newest.next().value)).toBe("[First prune notice]");
				expect(newest.next().done).toBe(true);
				expect(counter.snapshot()).toMatchObject({ entryReadEvents: 5, deadSnapshotReadEvents: 0 });
				counter.reset();
				const withOverlays = manager.getBranchMatching(
					metadata => isReadResult(metadata) || metadata.type === "tool_result_prune",
				);
				expect(withOverlays.map(entry => entry.id)).toEqual([
					"read-result",
					"first-prune",
					"second-prune",
					"unrelated-result",
					"future-result",
				]);
				expect(visibleText(withOverlays[0])).toBe("[First prune notice]");
				expect(counter.snapshot()).toMatchObject({ entryReadEvents: 5, deadSnapshotReadEvents: 0 });
				expect(visibleText(manager.getEntry("read-result"))).toBe("normal tool output");

				manager.branch("read-result");
				counter.reset();
				expect(manager.getBranchMatching(isReadResult).map(visibleText)).toEqual(["normal tool output"]);
				expect(visibleText(manager.getLatestBranchMatching(isReadResult))).toBe("normal tool output");
				expect([...manager.iterateBranchMatchingNewestFirst(isReadResult)].map(visibleText)).toEqual([
					"normal tool output",
				]);
				expect(counter.snapshot().deadSnapshotReadEvents).toBe(0);
			} finally {
				counter.restore();
				await manager.close();
			}

			const memory = SessionManager.inMemory(directory);
			try {
				const id = memory.appendMessage({
					role: "toolResult",
					toolName: "read",
					toolCallId: "cached-result",
					content: [{ type: "text", text: "cached original" }],
					isError: false,
					timestamp: 1,
				});
				memory.appendToolResultPrune([{ entryId: id, notice: "[Cached first notice]" }], 100);
				memory.appendToolResultPrune([{ entryId: id, notice: "[Cached second notice]" }], 200);
				const canonical = memory.getBranch().find(entry => entry.id === id);
				expect(visibleText(canonical)).toBe("[Cached first notice]");
				const first = memory.getBranchMatching(isReadResult)[0];
				expect(Object.is(first, canonical)).toBe(true);
				expect(Object.is(memory.getBranchMatching(isReadResult)[0], first)).toBe(true);
				expect(memory.getLatestBranchMatching(isReadResult)).toBe(canonical);
				expect(memory.iterateBranchMatchingNewestFirst(isReadResult).next().value).toBe(canonical);
				memory.branch(id);
				expect(visibleText(memory.getLatestBranchMatching(isReadResult))).toBe("cached original");
			} finally {
				await memory.close();
			}
		}, 60_000);

		it("legacy getBranch negative control reads every snapshot and fails the selective budget", async () => {
			await withReader((manager, counter) => {
				const legacy = manager.getBranch();
				expect(
					legacy.filter(entry => entry.type === "custom" && entry.customType === DEAD_SNAPSHOT_CUSTOM_TYPE),
				).toHaveLength(SNAPSHOT_COUNT);
				expect(counter.snapshot()).toMatchObject({
					deadSnapshotReadEvents: SNAPSHOT_COUNT,
					uniqueDeadSnapshotsRead: SNAPSHOT_COUNT,
				});
				expect(() =>
					assert(
						counter.snapshot().uniqueDeadSnapshotsRead < SNAPSHOT_COUNT * 0.05,
						"selective demand-read budget exceeded",
					),
				).toThrow("selective demand-read budget exceeded");
			});
		}, 60_000);
	});
}
