/** Run on a disposable copy of the DC journal, never on a live session. */
import { spyOn } from "bun:test";
import * as path from "node:path";
import * as loader from "../src/session/session-loader";
import { SessionManager } from "../src/session/session-manager";
import * as todo from "../src/tools/todo";

const file = process.argv[2];
if (!file || !file.startsWith("/tmp/omp-branchview-proof/")) throw new Error("Pass a disposable proof journal copy");
if (!process.env.PI_TEST_SESSION_OWNERS_DIR?.startsWith("/tmp/omp-branchview-proof/"))
	throw new Error("Set PI_TEST_SESSION_OWNERS_DIR to an isolated proof directory");
let decoded = 0;
const original = loader.readPositionedSessionEntry;
const reads = spyOn(loader, "readPositionedSessionEntry").mockImplementation((fd, position) => {
	decoded++;
	// Do not let instrumentation retain decoded history or millions of call records.
	reads.mockClear();
	return original(fd, position);
});
const start = performance.now();
const manager = await SessionManager.open(file, path.dirname(file), undefined, { suppressBreadcrumb: true });
manager.buildSessionContext();
await manager.flush();
const resumeMs = performance.now() - start;
const resumeDecoded = decoded;
let maxGapMs = 0;
let maxRss = process.memoryUsage().rss;
let previous = performance.now();
const heartbeat = setInterval(() => {
	const now = performance.now();
	maxGapMs = Math.max(maxGapMs, now - previous);
	previous = now;
	maxRss = Math.max(maxRss, process.memoryUsage().rss);
}, 5);
const cycles = [];
for (let cycle = 0; cycle < 50; cycle++) {
	await Bun.sleep(0);
	const begin = performance.now();
	for (let append = 0; append < 4; append++) manager.appendCustomEntry("branch_view_bench", { cycle, append });
	// The historical view consumer uses only its tail; render/context and todo use their real selectors.
	manager.getBranchView().at(-1);
	manager.buildSessionContext();
	const state = manager.getLatestBranchMatching(todo.isTodoStateEntryMetadata);
	todo.getLatestTodoPhasesFromEntries(state ? [state] : []);
	const duration = performance.now() - begin;
	cycles.push(duration);
	maxGapMs = Math.max(maxGapMs, duration);
	maxRss = Math.max(maxRss, process.memoryUsage().rss);
	console.log(JSON.stringify({ cycle, duration, decoded, rss: process.memoryUsage().rss }));
}
await Bun.sleep(10);
await manager.flush();
await Bun.sleep(10);
clearInterval(heartbeat);
const steadyRss = process.memoryUsage().rss;
await manager.close();
console.log(
	JSON.stringify({
		resumeMs,
		resumeDecoded,
		postResumeDecoded: decoded - resumeDecoded,
		decoded,
		maxGapMs,
		maxRss,
		steadyRss,
		appends: 200,
		cycles: 50,
		totalMs: performance.now() - start,
		cycleMaxMs: Math.max(...cycles),
	}),
);
