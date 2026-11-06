import { afterEach, jest, expect, spyOn, test } from "bun:test";
import { formatLocalClock, formatLocalTimestamp, resolveTimeZone } from "./deadlines";

afterEach(() => {
	jest.restoreAllMocks();
});

test("repeated busy-plan timestamps preserve wire text and format only changed values", () => {
	const zone = "Asia/Tbilisi";
	const values = Array.from({ length: 173 }, (_, i) => Date.UTC(2026, 10, 6, 1, i, 18));
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const expected = values.map(value => {
		const f = Object.fromEntries(formatter.formatToParts(value).map(p => [p.type, p.value]));
		return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}:${f.second} ${zone}`;
	});
	const parts = spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
	for (let tick = 0; tick < 20; tick++) expect(values.map(v => formatLocalTimestamp(v, zone))).toEqual(expected);
	expect(parts.mock.calls.length).toBeLessThanOrEqual(173);
	expect(formatLocalTimestamp(values[0]! + 1000, zone)).toBe("2026-11-06 05:00:19 Asia/Tbilisi");
	expect(parts.mock.calls.length).toBeLessThanOrEqual(174);
	expect(formatLocalClock(values[0]!, zone)).toBe("05:00");
	expect(formatLocalTimestamp(NaN, zone)).toBe("unknown");
	expect(resolveTimeZone("invalid-zone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("cached clocks preserve DST transitions and zone identity", () => {
	const before = Date.parse("2026-10-25T00:59:00Z");
	const after = before + 60_000;
	expect(formatLocalClock(before, "Europe/Berlin")).toBe("02:59");
	expect(formatLocalClock(after, "Europe/Berlin")).toBe("02:00");
	expect(formatLocalClock(after, "UTC")).toBe("01:00");
});
