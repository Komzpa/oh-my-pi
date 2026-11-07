import { expect, test } from "bun:test";
import { renderCurrentSetForecast } from "./lead_time_notes";
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
