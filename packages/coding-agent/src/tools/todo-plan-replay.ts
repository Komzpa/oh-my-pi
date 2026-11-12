import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { calibrateTodoPlan, forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { readLines } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import { getLatestTodoPhasesFromEntries, stampTaskTransitionTimes } from "./todo";
import { todoPlanMembers, type TodoPlanHistoryRecord } from "./todo-plan-history";

export interface ReplayFile {
	path: string;
	upper_byte: number;
	excluded_fixture?: boolean;
	recommended_fixture_exclusion?: string;
}
export interface ReplayScan {
	files: number;
	excluded: number;
	bytes: number;
	lines: number;
	malformed: number;
	nonmonotone: number;
	sessions: number;
}
export interface ReplayResult {
	records: TodoPlanHistoryRecord[];
	scan: ReplayScan;
}
interface JournalRow {
	type: string;
	id?: string;
	timestamp?: string;
	cwd?: string;
	customType?: string;
	data?: { phases?: TodoPhase[]; edit?: { op?: string } };
	message?: {
		role?: string;
		toolName?: string;
		isError?: boolean;
		details?: { op?: string; phases?: TodoPhase[]; forecast?: { capacity?: number }; edit?: { op?: string } };
	};
}

export async function inventoryTodoJournals(root: string): Promise<ReplayFile[]> {
	const files: ReplayFile[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		const name = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await inventoryTodoJournals(name)));
		else if (entry.isFile() && name.endsWith(".jsonl"))
			files.push({ path: name, upper_byte: (await fs.stat(name)).size });
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Append-order reconstruction. Only the current state and hourly frozen targets survive each line. */
export async function replayTodoJournals(files: readonly ReplayFile[]): Promise<ReplayResult> {
	const records: TodoPlanHistoryRecord[] = [];
	const scan: ReplayScan = { files: 0, excluded: 0, bytes: 0, lines: 0, malformed: 0, nonmonotone: 0, sessions: 0 };
	const sessions = new Set<string>();
	for (const file of files) {
		scan.files++;
		if (file.excluded_fixture || file.recommended_fixture_exclusion) {
			scan.excluded++;
			continue;
		}
		const prefix = await Bun.file(file.path).slice(0, Math.min(32768, file.upper_byte)).text();
		let meta: JournalRow | undefined;
		for (const line of prefix.split("\n")) {
			try {
				const row = JSON.parse(line) as JournalRow;
				if (row.type === "session") {
					meta = row;
					break;
				}
			} catch {}
		}
		const harness = /FREE_TOOL_OK|explicit fixture|native[-_ ](?:admission|merge|kill.switch).*fixture/i.test(prefix);
		if (harness && /^(\/tmp\/|\/private\/tmp\/)|\/\.claude\/jobs\//.test(meta?.cwd ?? "")) {
			scan.excluded++;
			continue;
		}
		const sessionId = meta?.id ?? file.path;
		let phases: TodoPhase[] = [],
			lastAt = -Infinity,
			lineNumber = 0;
		const hours = new Set<number>();
		const pending: { record: TodoPlanHistoryRecord; remaining: Set<string>; finishes: number[] }[] = [];
		for await (const raw of readLines(Bun.file(file.path).slice(0, file.upper_byte).stream())) {
			lineNumber++;
			scan.lines++;
			scan.bytes += raw.length + 1;
			const text = new TextDecoder().decode(raw);
			if (!text.includes('"todo"') && !text.includes("user_todo_edit")) continue;
			let row: JournalRow;
			try {
				row = JSON.parse(text) as JournalRow;
			} catch {
				scan.malformed++;
				continue;
			}
			const details = row.message?.details;
			const relevant =
				(row.type === "custom" && row.customType === "user_todo_edit") ||
				(row.type === "message" &&
					row.message?.toolName === "todo" &&
					!row.message.isError &&
					details?.op !== "view");
			if (!relevant) continue;
			const now = Date.parse(row.timestamp ?? "");
			if (!Number.isFinite(now)) continue;
			if (now < lastAt) {
				scan.nonmonotone++;
				continue;
			}
			lastAt = now;
			const checkpoint = {
				type: "custom",
				customType: "user_todo_edit",
				data: { phases },
				timestamp: row.timestamp,
				id: "replay-checkpoint",
				parentId: null,
			} as SessionEntry;
			const next = getLatestTodoPhasesFromEntries([checkpoint, row as SessionEntry]);
			stampTaskTransitionTimes(phases, next, now);
			const reset = (details?.edit?.op ?? row.data?.edit?.op ?? details?.op) === "init";
			const members = todoPlanMembers(next);
			for (let index = pending.length - 1; index >= 0; index--) {
				const target = pending[index]!;
				let censored = reset;
				for (const key of target.remaining) {
					const member = members.get(key);
					if (!member || member.status === "abandoned") {
						censored = true;
						break;
					}
					if (member.status === "completed") {
						const finish = member.finishedAt ?? now;
						if (finish < target.record.prediction.originAt || finish > now) {
							censored = true;
							break;
						}
						target.finishes.push(finish);
						target.remaining.delete(key);
					}
				}
				if (censored) target.record.censoredAt = now;
				else if (target.remaining.size === 0) {
					target.record.prediction.actualFinish = Math.max(...target.finishes);
					target.record.prediction.observedAt = now;
				}
				if (censored || !target.remaining.size) pending.splice(index, 1);
			}
			phases = next;
			const hour = Math.floor(now / 3_600_000);
			if (
				hours.has(hour) ||
				!phases.some(p =>
					p.tasks.some(t => t.status !== "completed" && t.status !== "abandoned" && !t.schedule?.postDeadline),
				)
			)
				continue;
			hours.add(hour);
			const capacity = details?.forecast?.capacity ?? 32;
			const forecast = forecastTodoPlan(phases, { now, capacity });
			if (forecast.rawP50Finish === undefined || !forecast.membershipFingerprint || !forecast.predictionVersion)
				continue;
			sessions.add(sessionId);
			const tasks = phases.flatMap(p => p.tasks);
			const keys = [...members.keys()].filter((_, index) => {
				const task = tasks[index]!;
				return task.status !== "completed" && task.status !== "abandoned" && !task.schedule?.postDeadline;
			});
			const record: TodoPlanHistoryRecord = {
				members: keys,
				prediction: {
					sessionId,
					originAt: now,
					rawP50Finish: forecast.rawP50Finish,
					membershipFingerprint: forecast.membershipFingerprint,
					predictionVersion: forecast.predictionVersion,
					capacity,
					provenance: `${file.path}:${lineNumber};capacity=${details?.forecast?.capacity === undefined ? "default-32-assumed" : "recorded"}`,
				},
			};
			records.push(record);
			pending.push({ record, remaining: new Set(keys), finishes: [] });
		}
		for (const target of pending)
			target.record.censoredAt = Number.isFinite(lastAt) ? lastAt : target.record.prediction.originAt;
	}
	// Global chronology is applied only after raw predictions are frozen; labels must be observed strictly earlier.
	records.sort((a, b) => a.prediction.originAt - b.prediction.originAt);
	const predictions = records.filter(r => !r.censoredAt).map(r => r.prediction);
	for (const record of records)
		record.prediction.upperFinish = calibrateTodoPlan(
			predictions,
			record.prediction.originAt,
			record.prediction.rawP50Finish,
		).calibratedUpperFinish;
	scan.sessions = sessions.size;
	return { records, scan };
}
