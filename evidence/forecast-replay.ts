import { renderCurrentSetForecast } from "../packages/reemxy-extensions/extensions/lead_time_notes";
import { formatPlanForecast } from "../packages/tui/src/tools/todo-schedule";
import { forecastTodoLivePlan } from "../packages/coding-agent/src/tools/todo";
import { TodoPlanCalibrationStore } from "../packages/coding-agent/src/tools/todo-plan-calibration";
import type { TodoPhase } from "../packages/tui/src/tools/todo";
import snapshots from "../packages/tui/test/fixtures/dc-forecast-snapshots.json";
const calibrationStore = process.argv[2] ? new TodoPlanCalibrationStore(process.argv[2]) : undefined;
if (calibrationStore) await calibrationStore.refresh();
for (const key of ["11:12", "18:11"] as const) {
 const s = snapshots[key]; const now = Date.parse(s.timestamp);
 const plan = forecastTodoLivePlan(s.phases as TodoPhase[], [], { now, capacity: 32, calibrationStore });
 console.log(JSON.stringify({ key, timestamp: s.timestamp, rawP50Finish: plan.rawP50Finish, rawP80Finish: plan.rawP80Finish, auto: plan.autoDeadlineForecast, calibrationStatus: plan.calibrationStatus, note: formatPlanForecast(plan, now), timeNote: renderCurrentSetForecast(plan, {version:1,goalId:"auto-todo-plan",goalStartedAt:Date.parse("2026-11-07T11:12:07+04:00")/1000,timezone:"Asia/Tbilisi",active:true,auto:true,stages:[],baselineDeadlineAt:Date.parse("2026-11-07T13:57:08+04:00")/1000}, now) }));
}
