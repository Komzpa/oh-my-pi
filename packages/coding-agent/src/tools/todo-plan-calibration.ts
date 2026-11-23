import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { TODO_PREDICTION_VERSION, type TodoPlanPrediction } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { isTodoPlanHistoryRecord, todoPlanCalibrationHistory, type TodoPlanHistoryRecord } from "./todo-plan-history";

// Fail closed rather than silently changing the all-prior calibration population.
const MAX_STORE_BYTES = 16 * 1024 * 1024;
export function getTodoPlanCalibrationPath(): string {
	return path.join(getAgentDir(), "forecast-calibration", `${encodeURIComponent(TODO_PREDICTION_VERSION)}.jsonl`);
}

/** Terminal observations only. Each append is a single O_APPEND write across processes. */
export class TodoPlanCalibrationStore {
	#records: TodoPlanHistoryRecord[] = [];
	#refreshing?: Promise<void>;
	constructor(readonly filePath = getTodoPlanCalibrationPath()) {}

	async append(record: TodoPlanHistoryRecord): Promise<void> {
		if (
			!isTodoPlanHistoryRecord(record) ||
			record.prediction.predictionVersion !== TODO_PREDICTION_VERSION ||
			(record.censoredAt === undefined && record.prediction.observedAt === undefined)
		)
			return;
		const bytes = Buffer.from(`${JSON.stringify({ v: 1, record })}\n`);
		if (bytes.length > 64 * 1024) throw new Error("Forecast calibration record exceeds 64 KiB");
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		const handle = await fs.open(this.filePath, "a", 0o600);
		try {
			const result = await handle.write(bytes);
			if (result.bytesWritten !== bytes.length) throw new Error("Incomplete forecast calibration append");
		} finally {
			await handle.close();
		}
	}

	refresh(): Promise<void> {
		return (this.#refreshing ??= this.#load().finally(() => {
			this.#refreshing = undefined;
		}));
	}

	async #load(): Promise<void> {
		try {
			const file = Bun.file(this.filePath);
			const bytes = await file.slice(0, MAX_STORE_BYTES + 1).arrayBuffer();
			if (bytes.byteLength > MAX_STORE_BYTES) {
				this.#records = [];
				logger.warn("Forecast calibration store exceeds bounded read limit", { path: this.filePath });
				return;
			}
			const text = new TextDecoder().decode(bytes);
			const records: TodoPlanHistoryRecord[] = [];
			// A concurrent writer may leave an incomplete last line; retry on the next refresh.
			for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
				if (!line) continue;
				try {
					const entry = JSON.parse(line) as { v?: number; record?: unknown };
					if (
						entry.v === 1 &&
						isTodoPlanHistoryRecord(entry.record) &&
						entry.record.prediction.predictionVersion === TODO_PREDICTION_VERSION
					)
						records.push(entry.record);
				} catch {
					/* Ignore damaged records without losing other sessions. */
				}
			}
			this.#records = records;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			this.#records = [];
		}
	}

	snapshot(now: number): TodoPlanPrediction[] {
		return todoPlanCalibrationHistory(this.#records, now);
	}
}

let defaultStore: TodoPlanCalibrationStore | undefined;
export function getTodoPlanCalibrationStore(): TodoPlanCalibrationStore {
	const filePath = getTodoPlanCalibrationPath();
	if (defaultStore?.filePath !== filePath) defaultStore = new TodoPlanCalibrationStore(filePath);
	return defaultStore;
}
