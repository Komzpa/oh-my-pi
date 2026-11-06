import { expect, test } from "bun:test";
import { renderCurrentSetForecast, renderPlanFactNote, planSlipMinutes, planChurnRows } from "./lead_time_notes";
import { forecastTodoPlan } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import type { DeadlineState } from "./deadlines";

const now = Date.parse("2026-11-07T23:50:00Z");
const anchor: DeadlineState = { version: 1, goalId: "a", goalStartedAt: now / 1000 - 7200, timezone: "UTC", active: true, auto: true, autoPlanKey: "a", stages: [], baselineDeadlineAt: now / 1000 - 600, autoScopeGrowthRows: ["split"] };

test("cross-midnight note distinguishes the current forecast from the missed initial forecast", () => {
 const plan = { ...forecastTodoPlan([], { now }), rawP50Finish: now + 1200_000, calibratedUpperFinish: now + 7200_000, calibrationStatus: "sufficient" as const, calibrationOrigins: 25, calibrationSessions: 5, calibrationCoverage: { covered: 19, total: 25, sessions: 5 } };
 const note = renderCurrentSetForecast(plan, anchor, now);
 expect(note).toContain("point 2026-11-08 00:10:00 UTC");
 expect(note).toContain("empirical upper 2026-11-08 01:50:00 UTC");
 expect(note).toContain("experimental; observed coverage 19/25, 5 sessions");
 expect(note).toContain("Original initial forecast 2026-11-07 23:40:00 UTC, now 10m late");
 expect(note).toContain("1 labels with unknown split/addition lineage");
 expect(note).not.toContain("P(on time)");
});

test("missing calibration or unresolved release gates cannot invent an empirical finish", () => {
 const plan = { ...forecastTodoPlan([], { now }), rawP50Finish: now + 1200_000, calibrationStatus: "insufficient" as const, calibrationOrigins: 2, calibrationSessions: 1 };
 expect(renderCurrentSetForecast(plan, anchor, now)).toContain("unavailable (insufficient calibration; 2 origins, 1 sessions)");
 const note = renderCurrentSetForecast({ ...plan, unresolvedCount: 1 }, anchor, now);
 expect(note).toContain("point unknown");
 expect(note).toContain("forecast conditional on unresolved work");
});


test("driver names only the final critical row with a bounded title and owner", () => {
 const title = "Final delivery " + "acceptance ".repeat(30);
 const plan = forecastTodoPlan([{ name: "delivery", tasks: [
  { content: "Prior dependency", status: "pending", schedule: { dependencies: [], resources: [], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, updatedAt: now, confidence: "medium", basis: "declared residual" } } },
  { content: title, status: "pending", schedule: { resources: [], owner: "Closer", dependencies: ["Prior dependency"], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, updatedAt: now, confidence: "medium", basis: "declared residual" } } },
 ] }], { now });
 const note = renderCurrentSetForecast(plan, anchor, now);
 const driver = note.split("Driver: ")[1].split("; empirical allowance")[0];
 expect(driver).toContain("Final delivery");
 expect(driver).toEndWith(" (owner Closer)");
 expect(driver.replace(" (owner Closer)", "").length).toBeLessThanOrEqual(80);
 expect(driver).not.toContain("Prior dependency");
 expect(driver).not.toContain(" → ");
});


test("driver keeps a collateral subject without its explanatory paragraph", () => {
 const plan = forecastTodoPlan([{ name: "work", tasks: [{ content: 'Collateral for "Building overview": After applying two levels, pipes obscure the racks.', status: "pending", schedule: { owner: "FitCamera", dependencies: [], resources: [], estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "declared residual", updatedAt: now } } }] }], { now });
 const driver = renderCurrentSetForecast(plan, anchor, now).split("Driver: ")[1].split("; empirical allowance")[0];
 expect(driver).toBe('Collateral for "Building overview" (owner FitCamera)');
});


test("planfact and current-set notes use elapsed anchor slip rather than projected finish", () => {
 const deadline = now - 439 * 60_000;
 const phases = [{ name: "work", tasks: [{ content: "Cooling", status: "pending" as const }] }];
 const plan = forecastTodoPlan(phases, { now });
 const lateAnchor = { ...anchor, baselineDeadlineAt: deadline / 1000 };
 const planfact = renderPlanFactNote(phases, now, deadline, [], now + 25 * 60_000);
 expect(planfact).toContain("439m");
 expect(planfact).not.toContain("464m");
 expect(renderCurrentSetForecast(plan, lateAnchor, now)).toContain("439m late");
 expect(planSlipMinutes(deadline, now)).toBe(439);
 expect(renderPlanFactNote([], now, deadline)).not.toContain("PLAN SLIPPED");
});


test("standalone churn rows share the reminder predicate and clear with their source state", () => {
 const phases = [{ name: "work", tasks: [
  { content: "Cooling", status: "pending" as const, schedule: { cumulativeReestimateCount: 3 } },
  { content: "Clean", status: "pending" as const, schedule: { cumulativeReestimateCount: 2 } },
  { content: "Closed", status: "completed" as const, schedule: { cumulativeReestimateCount: 9 } },
 ] }];
 expect(planChurnRows(phases)).toEqual([{ row: "Cooling", failures: 0, reestimates: 3 }]);
 expect(renderPlanFactNote(phases, now, undefined)).toContain("CHURN: Cooling");
 expect(renderPlanFactNote(phases, now, undefined)).not.toContain("CHURN: Clean");
 phases[0]!.tasks[0]!.schedule.cumulativeReestimateCount = 0;
 expect(planChurnRows(phases)).toEqual([]);
 expect(renderPlanFactNote(phases, now, undefined)).not.toContain("CHURN:");
});
