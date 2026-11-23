/** Run under nice/ionice: bun .../executor-observation-load.ts JOURNAL [compact] */
import { loadSessionFile } from "../src/session/session-loader";
import { SessionEntryIndex } from "../src/session/session-manager";
import type { SessionEntry } from "../src/session/session-entries";
import { getLatestTodoPhasesFromEntries } from "../src/tools/todo";

const start = performance.now();
const loaded = await loadSessionFile(Bun.argv[2], undefined, {
	compactExecutorObservations: Bun.argv[3] === "compact",
});
const entries = loaded.entries.filter((entry): entry is SessionEntry => entry.type !== "session");
const index = new SessionEntryIndex();
index.rebuild(entries);
const phases = getLatestTodoPhasesFromEntries(entries);
console.log(
	JSON.stringify({
		mode: Bun.argv[3] ?? "raw",
		sourceBytes: loaded.sourceSize,
		retained: entries.length,
		elapsedMs: performance.now() - start,
		rssBytes: process.memoryUsage.rss(),
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		phases,
	}),
);
