import * as fs from "node:fs";
import { bootstrapJitDebugInfo } from "../../src/cli/jit-bootstrap";

bootstrapJitDebugInfo(process.env.PI_COMPILED === "true", process.env.PROBE_INTERACTIVE !== "0");
const execEnv = fs.readFileSync("/proc/self/environ", "utf8").split("\0");
const atExec = execEnv.find(entry => entry.startsWith("BUN_JSC_useGdbJITInfo="))?.split("=")[1];
process.stdout.write(
	JSON.stringify({
		args: process.argv.slice(2),
		pid: process.pid,
		jit: atExec,
		inherited: process.env.BUN_JSC_useGdbJITInfo,
	}),
);
