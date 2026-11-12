import * as fs from "node:fs";
import { SessionManager } from "/home/kom/proj/ai_pr/omp-turnfreeze-20261107/composite/packages/coding-agent/src/session/session-manager";
const manager = await SessionManager.open("/home/kom/proj/ai_pr/omp-compactloop-20261107/offline/session.jsonl", undefined, undefined, { suppressBreadcrumb: true });
function bytes() { return Number(fs.readFileSync("/proc/self/io", "utf8").match(/^rchar: (\d+)/m)![1]); }
const id = manager.appendCustomEntry("compactloop-index-probe", { probe: true });
let start = performance.now(), before = bytes();
const entry = manager.getEntry(id);
console.log(JSON.stringify({ path: "getEntry(id)", bytes: bytes() - before, ms: performance.now() - start, found: entry?.id === id }));
start = performance.now(); before = bytes();
const entries = manager.getEntries();
console.log(JSON.stringify({ path: "getEntries().find", bytes: bytes() - before, ms: performance.now() - start, found: entries.find(e => e.id === id)?.id === id, entries: entries.length }));
process.exit(0);
