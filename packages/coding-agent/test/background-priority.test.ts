import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import { runBoundedProbe } from "../src/eval/probe";

// The child records its own priority: field 19 of /proc/<pid>/stat is nice,
// and `ionice -p` prints the I/O scheduling class and level.
const REPORT = 'echo "$(cut -d" " -f19 /proc/$$/stat) $(ionice -p $$)"';

const readOwnStat = () => fs.readFileSync("/proc/self/stat", "utf8");
const OWN_NICE_FIELD = 18;
describe.skipIf(process.platform !== "linux" || !Bun.which("nice") || !Bun.which("ionice"))(
	"tool child background priority",
	() => {
		it("lowers ptree children (language servers, DAP, ssh, fetch)", async () => {
			const before = readOwnStat().split(" ")[OWN_NICE_FIELD];
			const result = await ptree.exec(["sh", "-c", REPORT]);
			expect(result.stdout.trim()).toBe("19 best-effort: prio 7");
			expect(readOwnStat().split(" ")[OWN_NICE_FIELD]).toBe(before);
		});

		it("lowers direct Bun.spawn tool paths (runtime probe)", async () => {
			const before = readOwnStat().split(" ")[OWN_NICE_FIELD];
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-priority-"));
			const out = path.join(dir, "priority");
			try {
				const result = await runBoundedProbe(["sh", "-c", `${REPORT} > ${out}`], { cwd: dir, env: Bun.env });
				expect(result.exitCode).toBe(0);
				expect(fs.readFileSync(out, "utf8").trim()).toBe("19 best-effort: prio 7");
				expect(readOwnStat().split(" ")[OWN_NICE_FIELD]).toBe(before);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
