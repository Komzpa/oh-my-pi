import { afterEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import dc from "../../tui/test/fixtures/dc-forecast-snapshots.json";
import { TODO_PREDICTION_VERSION } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import * as calibration from "../src/tools/todo-plan-calibration";
import type { TodoPlanHistoryRecord } from "../src/tools/todo-plan-history";
import { forecastTodoLivePlan } from "../src/tools/todo";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function scratch() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "todo-calibration-"));
	dirs.push(dir);
	return path.join(dir, "history.jsonl");
}
function record(session: string, hour: number, observedAt = 100_000_000): TodoPlanHistoryRecord {
	return {
		members: ["row"],
		prediction: {
			sessionId: session,
			originAt: hour * 3_600_000,
			rawP50Finish: hour * 3_600_000 + 60_000,
			actualFinish: hour * 3_600_000 + 7_200_000,
			observedAt,
			predictionVersion: TODO_PREDICTION_VERSION,
			membershipFingerprint: "row",
		},
	};
}

test("shared settled sessions calibrate live forecasts; future labels and other versions cannot change earlier predictions", async () => {
	const store = new calibration.TodoPlanCalibrationStore(await scratch());
	for (let session = 0; session < 5; session++)
		for (let hour = 1; hour <= 4; hour++) await store.append(record(`s${session}`, hour));
	await store.refresh();
	const replacement = spyOn(calibration, "getTodoPlanCalibrationStore").mockReturnValue(store);
	try {
		const phases = [
			{
				name: "work",
				tasks: [
					{
						content: "task",
						status: "pending" as const,
						schedule: {
							dependencies: [],
							owner: "worker",
							resources: [],
							estimate: {
								optimisticSeconds: 60,
								likelySeconds: 120,
								pessimisticSeconds: 180,
								confidence: "medium" as const,
								basis: "fixture",
								updatedAt: 200_000_000,
							},
						},
					},
				],
			},
		];
		const now = 200_000_000;
		const before = forecastTodoLivePlan(phases, [], { now });
		expect(before.calibratedUpperFinish).toBeGreaterThan(before.rawP50Finish!);
		expect(store.snapshot(100_000_000)).toEqual([]);
		await store.append(record("future", 1, now));
		await store.append({ ...record("censored", 2), censoredAt: now - 1 });
		const mismatch = record("old-version", 1);
		mismatch.prediction.predictionVersion = "old";
		await fs.appendFile(store.filePath, `${JSON.stringify({ v: 1, record: mismatch })}\n`);
		await store.refresh();
		expect(forecastTodoLivePlan(phases, [], { now })).toEqual(before);
		expect(store.snapshot(now)).toHaveLength(20);
	} finally {
		replacement.mockRestore();
	}
});

test("two actual processes append without losing or interleaving observations", async () => {
	const file = await scratch();
	const modulePath = path.resolve(import.meta.dir, "../src/tools/todo-plan-calibration.ts");
	const children = ["session-a", "session-b"].map(session =>
		Bun.spawn(
			[
				process.execPath,
				"--eval",
				`import { TodoPlanCalibrationStore } from ${JSON.stringify(modulePath)}; const store = new TodoPlanCalibrationStore(${JSON.stringify(file)}); for(let i=0;i<100;i++) await store.append(${JSON.stringify(record(session, 1))});`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		),
	);
	for (const child of children) {
		const error = await new Response(child.stderr).text();
		expect(await child.exited, error).toBe(0);
	}
	const lines = (await Bun.file(file).text()).trim().split("\n");
	expect(lines).toHaveLength(200);
	const sessions = lines.map(line => JSON.parse(line).record.prediction.sessionId);
	expect(sessions.filter(s => s === "session-a")).toHaveLength(100);
	expect(sessions.filter(s => s === "session-b")).toHaveLength(100);
});

test("both exact DC states keep their raw point and gain the shared empirical correction", async () => {
	const store = new calibration.TodoPlanCalibrationStore(await scratch());
	for (let session = 0; session < 5; session++)
		for (let hour = 1; hour <= 4; hour++) await store.append(record(`dc-seed-${session}`, hour));
	await store.refresh();
	for (const state of Object.values(dc)) {
		const now = Date.parse(state.timestamp);
		const phases = state.phases as TodoPhase[];
		const empty = new calibration.TodoPlanCalibrationStore(await scratch());
		const raw = forecastTodoLivePlan(phases, [], { now, capacity: 32, calibrationStore: empty });
		const seeded = forecastTodoLivePlan(phases, [], { now, capacity: 32, calibrationStore: store });
		expect(seeded.rawP50Finish).toBe(raw.rawP50Finish);
		expect(seeded.calibrationOrigins).toBe(20);
		expect(seeded.calibrationSessions).toBe(5);
		expect(seeded.calibratedUpperFinish).toBe(seeded.rawP50Finish! + 7_140_000);
	}
});
