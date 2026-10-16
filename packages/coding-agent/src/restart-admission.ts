/** Admission barrier for a preloaded successor, before session writers or runtime hooks exist. */
import * as path from "node:path";

export const RESTART_PREPARE_ENV = "OMP_RESTART_PREPARE";

export interface RestartPreparation {
	requestId: string;
	sessionId: string;
	sessionFile: string;
	requestedAt: number;
}

/**
 * Loading the CLI/module graph is allowed before commit. Opening the journal,
 * initializing extensions, consuming drafts/questions and running tools is not.
 * `restart-prepared` acknowledges this barrier only, never user readiness.
 */
export async function waitForRestartAdmission(resume: string | true | undefined): Promise<void> {
	const encoded = process.env[RESTART_PREPARE_ENV];
	if (!encoded) return;
	const value: unknown = JSON.parse(encoded);
	if (typeof value !== "object" || value === null) throw new Error("Invalid restart preparation");
	const prepared = value as Partial<RestartPreparation>;
	if (
		typeof prepared.requestId !== "string" ||
		!prepared.requestId ||
		typeof prepared.sessionId !== "string" ||
		!prepared.sessionId ||
		typeof prepared.sessionFile !== "string" ||
		!path.isAbsolute(prepared.sessionFile) ||
		typeof prepared.requestedAt !== "number" ||
		!Number.isFinite(prepared.requestedAt) ||
		typeof resume !== "string" ||
		path.resolve(resume) !== prepared.sessionFile
	)
		throw new Error("Prepared restart must resume its exact session file");
	if (!process.send || !process.connected) throw new Error("Prepared restart requires its parent IPC connection");

	const admission = Promise.withResolvers<void>();
	const onMessage = (message: unknown): void => {
		if (typeof message !== "object" || message === null) return;
		const frame = message as Partial<RestartPreparation> & { type?: unknown };
		if (
			frame.requestId !== prepared.requestId ||
			frame.sessionId !== prepared.sessionId ||
			frame.sessionFile !== prepared.sessionFile
		)
			return;
		if (frame.type === "restart-commit") admission.resolve();
		if (frame.type === "restart-abort") admission.reject(new Error("Prepared restart aborted before admission"));
	};
	const onDisconnect = (): void => admission.reject(new Error("Restart parent disconnected before admission"));
	process.on("message", onMessage);
	process.once("disconnect", onDisconnect);
	try {
		process.send({
			type: "restart-prepared",
			...prepared,
			pid: process.pid,
			requestElapsedMs: Math.max(0, Date.now() - prepared.requestedAt),
		});
		await admission.promise;
		delete process.env[RESTART_PREPARE_ENV];
	} finally {
		process.off("message", onMessage);
		process.off("disconnect", onDisconnect);
	}
}
