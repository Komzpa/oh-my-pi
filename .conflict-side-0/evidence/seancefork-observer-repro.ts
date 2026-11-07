// Offline observer probe. First arg: before | after; second: disposable child copy.
import * as fs from "node:fs";
import { JournalCursor } from "../packages/coding-agent/src/session/journal-cursor";
const [mode, file] = process.argv.slice(2);
const io = () => Number(fs.readFileSync("/proc/self/io", "utf8").match(/rchar: (\d+)/)![1]);
let last = performance.now(), maximum = 0;
const timer = setInterval(() => { const now = performance.now(); maximum = Math.max(maximum, now - last); last = now; }, 10);
const cursor = new JournalCursor();
let offset = 0, pending = "", at: number | undefined;
const buffer = Buffer.allocUnsafe(64 * 1024);
const observations = [];
for (let turn = 0; turn < 3; turn++) {
  if (turn) fs.appendFileSync(file, JSON.stringify({ type: "custom", customType: "task_worker_activity", id: `probe-${turn}`, parentId: null, timestamp: new Date().toISOString(), data: { workerId: "other" } }) + "\n");
  await Bun.sleep(20);
  maximum = 0;
  const bytes = io(), start = performance.now();
  if (mode === "before") {
    // Exact pre-patch todo_dispatch workerCompactionAt fallback loop.
    const size = fs.statSync(file).size, fd = fs.openSync(file, "r");
    try {
      while (offset < size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size-offset), offset);
        if (count <= 0) break;
        offset += count;
        let start = 0;
        for (let index=0; index<count; index++) {
          if (buffer[index] !== 10) continue;
          const line = pending + buffer.toString("utf8", start, index);
          pending = ""; start = index+1;
          if (!line.includes("compaction")) continue;
          try { const entry = JSON.parse(line); if (entry.type === "compaction") at = Date.parse(entry.timestamp); } catch {}
        }
        if (start<count) pending += buffer.toString("utf8",start,count);
      }
    } finally { fs.closeSync(fd); }
  } else {
    await cursor.read(file, entry => { if (entry.type === "compaction") at = Date.parse(entry.timestamp); }, () => { at = undefined; });
  }
  const wallMs = performance.now()-start, rcharBytes = io()-bytes;
  await Bun.sleep(20);
  observations.push({ turn, wallMs, maxIntervalMs: maximum, rcharBytes, at });
}
clearInterval(timer);
console.log(JSON.stringify({ mode, file, observations }, null, 2));
