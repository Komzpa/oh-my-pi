import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import type { SessionContextEntryMetadata } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { visitSessionFileForResume } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import * as sessionLoader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TODO_HUD_STATE_CUSTOM_TYPE, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

// This is the historical customType in the user-named journal, not a production selector.
export const DEAD_SNAPSHOT_CUSTOM_TYPE = "todo-dispatch-sprint-state";
export const SNAPSHOT_COUNT = 2000;
export const SNAPSHOT_BYTES = 200 * 1024;
const timestamp = "2026-01-01T00:00:00.000Z";

export interface DemandPosition extends SessionContextEntryMetadata {
	offset: number;
	length: number;
}

export async function writeDemandFixture(
	file: string,
	count = SNAPSHOT_COUNT,
	payloadBytes = SNAPSHOT_BYTES,
): Promise<DemandPosition[]> {
	const writer = Bun.file(file).writer();
	const positions: DemandPosition[] = [];
	let offset = 0;
	let parentId: string | null = null;
	const write = async (entry: Record<string, unknown>, metadata?: SessionContextEntryMetadata) => {
		const line = `${JSON.stringify(entry)}\n`;
		const length = Buffer.byteLength(line);
		writer.write(line);
		if (metadata) positions.push({ ...metadata, offset, length });
		offset += length;
		await writer.flush();
	};
	const append = async (
		id: string,
		type: SessionContextEntryMetadata["type"],
		fields: Record<string, unknown>,
		extra: Partial<SessionContextEntryMetadata> = {},
	) => {
		await write({ type, id, parentId, timestamp, ...fields }, { id, parentId, type, ...extra });
		parentId = id;
	};
	try {
		await write({ type: "session", version: 3, id: "branch-demand", timestamp, cwd: path.dirname(file) });
		await append(
			"root",
			"message",
			{ message: { role: "user", content: "keep original request 🐈", timestamp: 1 } },
			{ messageRole: "user" },
		);
		await append(
			"todo-first",
			"custom",
			{
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: [{ name: "Work", tasks: [{ content: "first", status: "pending" }] }] },
			},
			{ customType: USER_TODO_EDIT_CUSTOM_TYPE },
		);
		for (let index = 0; index < count; index++) {
			await append(
				`snapshot-${index}`,
				"custom",
				{
					customType: DEAD_SNAPSHOT_CUSTOM_TYPE,
					data: { index, payload: `snapshot ${index} 🐈 ${"x".repeat(payloadBytes)}` },
				},
				{ customType: DEAD_SNAPSHOT_CUSTOM_TYPE },
			);
		}
		await append(
			"todo-last",
			"custom",
			{
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: [{ name: "Work", tasks: [{ content: "latest", status: "pending" }] }] },
			},
			{ customType: USER_TODO_EDIT_CUSTOM_TYPE },
		);
		await append(
			"hud",
			"custom",
			{ customType: TODO_HUD_STATE_CUSTOM_TYPE, data: { visibility: "revealed" } },
			{ customType: TODO_HUD_STATE_CUSTOM_TYPE },
		);
		await append(
			"last-user",
			"message",
			{ message: { role: "user", content: "new request", timestamp: 2 } },
			{ messageRole: "user" },
		);
		await append(
			"read-result",
			"message",
			{
				message: {
					role: "toolResult",
					toolName: "read",
					toolCallId: "read-call",
					content: [{ type: "text", text: "normal tool output" }],
					isError: false,
					timestamp: 3,
				},
			},
			{ messageRole: "toolResult", toolName: "read" },
		);
		// Keep measured entries outside the active context loaded by open(). Without
		// this boundary, even getBranch legitimately performs zero demand reads.
		await append(
			"context-tail",
			"message",
			{ message: { role: "user", content: "kept tail request", timestamp: 4 } },
			{ messageRole: "user" },
		);
		await append("compaction", "compaction", {
			summary: "Historical fixture compacted",
			firstKeptEntryId: "context-tail",
			tokensBefore: 1,
		});
		await append(
			"current-user",
			"message",
			{ message: { role: "user", content: "current request", timestamp: 5 } },
			{ messageRole: "user" },
		);
	} finally {
		await writer.end();
	}
	return positions;
}

/** Stream inventory before the measured child starts; keep byte ranges, never payloads. */
export async function inventoryDemandPositions(file: string): Promise<DemandPosition[]> {
	const positions: DemandPosition[] = [];
	const result = await visitSessionFileForResume(file, (_entry, position) => positions.push(position), {
		throwIfMissing: true,
	});
	if (result.sourceFd !== undefined) fs.closeSync(result.sourceFd);
	assert.equal(result.migrated, false, "Probe input must already use current JSONL format");
	assert.equal(result.malformedRecords, 0, "Probe input must be intact");
	return positions;
}

export interface DemandReadSample {
	entryReadEvents: number;
	uniqueEntriesRead: number;
	deadSnapshotReadEvents: number;
	uniqueDeadSnapshotsRead: number;
	positionedPayloadBytes: number;
	ids: string[];
}

export interface DemandReadCounter {
	snapshot(): DemandReadSample;
	reset(): void;
	restore(): void;
}

/** Count completed positioned-reader calls in an isolated probe process, never the suite. */
export function countDemandReads(file: string, positions: readonly DemandPosition[]): DemandReadCounter {
	const identity = fs.statSync(file);
	const byOffset = new Map(positions.map(position => [position.offset, position]));
	const original = sessionLoader.readPositionedSessionEntry;
	const reads = new Map<string, number>();
	let bytes = 0;
	let installed = true;
	// Bun's node:fs namespace keeps its original readSync after default-export mutation,
	// even with syncBuiltinESMExports. Wrap the actual positioned reader instead.
	const wrapped: typeof original = (fd, position) => {
		const entry = original(fd, position);
		const metadata = byOffset.get(position.offset);
		if (metadata) {
			const source = fs.fstatSync(fd);
			if (source.ino === identity.ino && source.dev === identity.dev) {
				reads.set(metadata.id, (reads.get(metadata.id) ?? 0) + 1);
				bytes += position.length;
			}
		}
		return entry;
	};
	const reader = spyOn(sessionLoader, "readPositionedSessionEntry").mockImplementation(wrapped);
	return {
		snapshot() {
			const deadIds = new Set(
				positions
					.filter(position => position.type === "custom" && position.customType === DEAD_SNAPSHOT_CUSTOM_TYPE)
					.map(position => position.id),
			);
			return {
				entryReadEvents: [...reads.values()].reduce((total, count) => total + count, 0),
				uniqueEntriesRead: reads.size,
				deadSnapshotReadEvents: [...reads].reduce((total, [id, count]) => total + (deadIds.has(id) ? count : 0), 0),
				uniqueDeadSnapshotsRead: [...reads.keys()].filter(id => deadIds.has(id)).length,
				positionedPayloadBytes: bytes,
				ids: [...reads.keys()],
			};
		},
		reset() {
			reads.clear();
			bytes = 0;
		},
		restore() {
			if (!installed) return;
			reader.mockRestore();
			installed = false;
		},
	};
}
