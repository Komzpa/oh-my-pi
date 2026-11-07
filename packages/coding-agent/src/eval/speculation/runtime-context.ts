import { AsyncLocalStorage } from "node:async_hooks";

import type { EvalShadowCellSession } from "./cell-session";

const activeCell = new AsyncLocalStorage<EvalShadowCellSession>();
// The host job identity must survive worker/HTTP bridge boundaries without
// excluding other eval cells owned by the same agent from terminal checks.
const activeJob = new AsyncLocalStorage<string | undefined>();

export function runWithEvalJob<T>(jobId: string | undefined, action: () => T): T {
	return activeJob.run(jobId, action);
}

export function getActiveEvalJobId(): string | undefined {
	return activeJob.getStore();
}

export function runWithEvalShadowCell<T>(cell: EvalShadowCellSession | undefined, action: () => T): T {
	return cell ? activeCell.run(cell, action) : action();
}

export function getActiveEvalShadowCell(): EvalShadowCellSession | undefined {
	return activeCell.getStore();
}
