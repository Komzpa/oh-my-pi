import "../../src/restart-children-startup";
import * as fs from "node:fs/promises";

const pid = process.argv[2]!;
const fresh = Bun.spawn(["sh", "-c", "exit 7"], { stdout: "ignore", stderr: "ignore" });
const freshExit = await fresh.exited;
await Bun.sleep(300);
let exists = true;
try {
	await fs.stat(`/proc/${pid}`);
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	exists = false;
}
process.stdout.write(JSON.stringify({ exists, freshExit }));
