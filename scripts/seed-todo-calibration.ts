#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import {
	TodoPlanCalibrationStore,
	getTodoPlanCalibrationPath,
} from "../packages/coding-agent/src/tools/todo-plan-calibration";
import {
	inventoryTodoJournals,
	replayTodoJournals,
	type ReplayFile,
} from "../packages/coding-agent/src/tools/todo-plan-replay";

const { values } = parseArgs({
	options: {
		root: { type: "string" },
		output: { type: "string" },
		manifest: { type: "string" },
		report: { type: "string" },
	},
});
const files = values.manifest
	? ((await Bun.file(values.manifest).json()) as { files: ReplayFile[] }).files
	: await inventoryTodoJournals(values.root ?? getSessionsDir());
const result = await replayTodoJournals(files);
const output = values.output ?? getTodoPlanCalibrationPath();
const store = new TodoPlanCalibrationStore(output);
for (const record of result.records) await store.append(record);
const cutoff = result.records[Math.floor(result.records.length * 0.8)]?.prediction.originAt ?? Infinity;
const later = result.records.filter(r => r.prediction.originAt >= cutoff && r.prediction.actualFinish !== undefined);
const scored = later.filter(r => r.prediction.upperFinish !== undefined);
const counts = new Map<string, number>();
for (const r of scored) counts.set(r.prediction.sessionId, (counts.get(r.prediction.sessionId) ?? 0) + 1);
const covered = scored.filter(r => r.prediction.actualFinish! <= r.prediction.upperFinish!);
const report = {
	output,
	scan: result.scan,
	origins: result.records.length,
	closed: result.records.filter(r => r.prediction.actualFinish !== undefined).length,
	censored: result.records.filter(r => r.censoredAt !== undefined).length,
	laterSlice: {
		cutoff,
		closed: later.length,
		scored: scored.length,
		sessions: counts.size,
		covered: covered.length,
		originCoverage: scored.length ? covered.length / scored.length : null,
		sessionCoverage: counts.size
			? covered.reduce((sum, r) => sum + 1 / counts.get(r.prediction.sessionId)!, 0) / counts.size
			: null,
	},
	population:
		"first eligible session-hour, frozen recorded TODO closure; chronological last 20 percent; experimental prequential upper, no delivery probability guarantee",
	labelRule: "observedAt strictly before origin, same scheduler version",
};
if (values.report) await Bun.write(values.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
