import { TodoPlanCalibrationStore } from "../packages/coding-agent/src/tools/todo-plan-calibration";
import { TODO_PREDICTION_VERSION } from "../packages/tui/src/tools/todo-schedule";
if (!process.argv[2]) throw new Error("Pass a scratch output JSONL path");
const store = new TodoPlanCalibrationStore(process.argv[2]);
const start = Date.parse("2026-10-01T00:00:00Z");
for (let session = 0; session < 5; session++) for (let hour = 0; hour < 5; hour++) {
 const originAt = start + hour * 3_600_000;
 await store.append({ members: ["synthetic frozen row"], prediction: {
  sessionId: `fixture-${session}`, originAt, rawP50Finish: originAt + 3_600_000,
  actualFinish: originAt + 10_800_000, observedAt: originAt + 10_800_000,
  upperFinish: originAt + 10_800_000, predictionVersion: TODO_PREDICTION_VERSION,
  membershipFingerprint: "synthetic", provenance: "synthetic integration fixture, not measured coverage",
 } });
}
