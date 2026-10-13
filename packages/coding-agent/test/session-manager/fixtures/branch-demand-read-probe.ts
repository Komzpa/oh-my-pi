import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_ENTRY, rehydrateDeadlineState, readGoalDeadline } from "@oh-my-pi/pi-coding-agent/goals/deadlines";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { restartNoticeText } from "@oh-my-pi/pi-coding-agent/task/restart-queue";
import {
	isTodoStateEntryMetadata,
	shouldPersistTodoFullSnapshotCheckpoint,
} from "@oh-my-pi/pi-coding-agent/tools/todo";
import {
	countDemandReads,
	DEAD_SNAPSHOT_CUSTOM_TYPE,
	inventoryDemandPositions,
	type DemandReadSample,
} from "./branch-demand-read-fixture";

// Usage (copy-only; never pass a live session path):
//   bun run branch-demand-read-probe.ts /absolute/copy.jsonl baseline
//   bun run branch-demand-read-probe.ts /absolute/copy.jsonl selective
//   bun run branch-demand-read-probe.ts /absolute/copy.jsonl latest
// Each mode runs in its own fresh bun process so RSS peaks are comparable.
const file = process.argv[2];
const mode = process.argv[3];
if (!file || !path.isAbsolute(file) || !fs.existsSync(file))
	throw new Error(
		"Usage: bun run branch-demand-read-probe.ts /absolute/path/to/copied-session.jsonl baseline|selective|latest",
	);
if (mode !== "baseline" && mode !== "selective" && mode !== "latest")
	throw new Error("mode must be baseline|selective|latest");
const source = fs.statSync(file);
if (!source.isFile()) throw new Error("Probe input must be a regular copied session file");
const positions = await inventoryDemandPositions(file);
const expectedDeadSnapshots = positions.filter(
	p => p.type === "custom" && p.customType === DEAD_SNAPSHOT_CUSTOM_TYPE,
).length;
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 5);
const manager = await SessionManager.open(file, path.dirname(file), undefined, {
	suppressBreadcrumb: true,
	throwIfMissing: true,
});
const counter = countDemandReads(file, positions);
try {
	if (mode === "baseline") {
		const branch = manager.getBranch();
		const dead = branch.filter(e => e.type === "custom" && e.customType === DEAD_SNAPSHOT_CUSTOM_TYPE).length;
		assert.equal(
			dead,
			expectedDeadSnapshots,
			"branch must contain all indexed dead snapshots for comparable measurement",
		);
		const s = counter.snapshot();
		assert.equal(
			s.deadSnapshotReadEvents,
			expectedDeadSnapshots,
			"negative control must demand-read every snapshot exactly once",
		);
		assert.equal(
			s.uniqueDeadSnapshotsRead,
			expectedDeadSnapshots,
			"negative control must observe all snapshot byte ranges",
		);
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		console.log(
			JSON.stringify({
				mode,
				inputBytes: source.size,
				deadSnapshotsOnBranch: expectedDeadSnapshots,
				deadSnapshotReads: s.deadSnapshotReadEvents,
				uniqueDeadSnapshotsRead: s.uniqueDeadSnapshotsRead,
				positionedPayloadBytes: s.positionedPayloadBytes,
				rssPeakBytes: peakRss,
			}),
		);
	} else if (mode === "latest") {
		const latest = manager.getLatestBranchMatching(
			metadata => metadata.type === "custom" && metadata.customType === DEAD_SNAPSHOT_CUSTOM_TYPE,
		);
		const s = counter.snapshot();
		const expectedReads = expectedDeadSnapshots > 0 ? 1 : 0;
		assert.equal(s.entryReadEvents, expectedReads, "latest selector must read only its hit");
		assert.equal(s.deadSnapshotReadEvents, expectedReads);
		assert.equal(s.uniqueDeadSnapshotsRead, expectedReads);
		if (expectedReads) assert.ok(latest, "latest snapshot must be returned");
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		console.log(
			JSON.stringify({
				mode,
				inputBytes: source.size,
				deadSnapshotsOnBranch: expectedDeadSnapshots,
				latestId: latest?.id,
				sample: s,
				rssPeakBytes: peakRss,
			}),
		);
	} else {
		// 1. Simulated todo write gate: actual production checkpoint check.
		shouldPersistTodoFullSnapshotCheckpoint(manager.iterateBranchMatchingNewestFirst(isTodoStateEntryMetadata));
		const todoSample: DemandReadSample = counter.snapshot();
		counter.reset();
		// 2. Tool-call deadline gate (SIMULATED, not actual): isUserDeadlineMissed lives in
		// reemxy extensions/deadlines.ts and is not importable from this package. Uses only the
		// latest deadline state entry; rehydrateDeadlineState + readGoalDeadline are the importable
		// production deadline reads from coding-agent goals/deadlines.ts.
		const latestDeadline = manager.getLatestBranchMatching(
			m =>
				(m.type === "custom" && m.customType === STATE_ENTRY) ||
				(m.type === "message" && m.messageRole === "toolResult" && m.toolName === "goal_deadline"),
		);
		const deadlineEntries = latestDeadline ? [latestDeadline] : [];
		rehydrateDeadlineState(deadlineEntries);
		readGoalDeadline(deadlineEntries, manager.getCwd(), { includePaused: true });
		const gateSample: DemandReadSample = counter.snapshot();
		counter.reset();
		// 3. Render read: actual restartNoticeText over production selector
		// (ui-helpers.ts filters customType exactly 'restart_request_transition').
		const noticeEntries = manager.getBranchMatching(m => m.customType === "restart_request_transition");
		restartNoticeText(noticeEntries, "probe-request-id");
		const renderSample: DemandReadSample = counter.snapshot();
		const measured =
			todoSample.deadSnapshotReadEvents + gateSample.deadSnapshotReadEvents + renderSample.deadSnapshotReadEvents;
		assert.equal(measured, 0, "selective operations must not demand-read historical snapshots");
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		console.log(
			JSON.stringify({
				mode,
				inputBytes: source.size,
				deadSnapshotsOnBranch: expectedDeadSnapshots,
				perOperation: { todoWrite: todoSample, toolGate: gateSample, render: renderSample },
				deadSnapshotReads: measured,
				// Ratio defined as total dead-snapshot payload reads across the 3 ops divided by (deadOnBranch * 3 ops).
				// Selective target: <0.05. Baseline control reads every snapshot once: ratio ~= 1/3.
				deadSnapshotReadRatio: expectedDeadSnapshots ? measured / (expectedDeadSnapshots * 3) : 0,
				rssPeakBytes: peakRss,
			}),
		);
	}
} finally {
	counter.restore();
	clearInterval(sampler);
	await manager.close();
}
