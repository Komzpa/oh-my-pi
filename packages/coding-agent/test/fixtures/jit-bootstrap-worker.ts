import { bootstrapJitDebugInfo } from "../../src/cli/jit-bootstrap";

declare const self: Worker;
delete process.env.BUN_JSC_useGdbJITInfo;
delete process.env.OMP_JIT_DEBUG_REEXEC;
bootstrapJitDebugInfo(false, true);
self.postMessage("ok");
