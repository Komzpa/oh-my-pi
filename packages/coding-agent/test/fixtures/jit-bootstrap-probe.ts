import { bootstrapJitDebugInfo } from "../../src/cli/jit-bootstrap";
bootstrapJitDebugInfo(process.env.PI_COMPILED === "true");
process.stdout.write(
	JSON.stringify({ args: process.argv.slice(2), pid: process.pid, jit: process.env.BUN_JSC_useGdbJITInfo }),
);
