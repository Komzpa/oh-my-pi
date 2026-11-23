/** Admission barrier for a preloaded successor, before session writers or runtime hooks exist. */
import * as path from "node:path";
import { spawn } from "node:child_process";

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

export interface PreparedRestartSuccessor {
	readonly pid: number;
	/** Release the final checkpoint's writer, then admit the successor once. */
	commit(releaseWriter: () => Promise<void>): Promise<number>;
	/** Only an uncommitted candidate can be aborted; the active runtime stays untouched. */
	abort(): Promise<void>;
}

/**
 * Launch a candidate behind the admission barrier using the existing process IPC.
 * The caller remains the terminal/worker owner until it explicitly commits.
 * This does not preload session state or transfer existing worker ownership.
 */
export async function prepareRestartSuccessor(
	command: string[],
	preparation: RestartPreparation,
): Promise<PreparedRestartSuccessor> {
	if (!command[0]) throw new Error("Restart successor command is empty");
	const ready = Promise.withResolvers<void>();
	const exit = Promise.withResolvers<number>();
	const child = spawn(command[0], command.slice(1), {
		stdio: ["inherit", "inherit", "inherit", "ipc"],
		env: { ...process.env, [RESTART_PREPARE_ENV]: JSON.stringify(preparation) },
	});
	child.once("error", error => {
		ready.reject(error);
		exit.resolve(1);
	});
	child.once("exit", code => {
		exit.resolve(code ?? 1);
		ready.reject(new Error(`Restart candidate exited before preparation (exit ${code})`));
	});
	child.on("message", message => {
		if (typeof message !== "object" || message === null) return;
		const frame = message as Partial<RestartPreparation> & { type?: unknown };
		if (
			frame.type === "restart-prepared" &&
			frame.requestId === preparation.requestId &&
			frame.sessionId === preparation.sessionId &&
			frame.sessionFile === preparation.sessionFile
		)
			ready.resolve();
	});
	await ready.promise;
	let state: "ready" | "committing" | "committed" | "aborted" = "ready";
	let commit: Promise<number> | undefined;
	const abort = async (): Promise<void> => {
		if (state === "committing" || state === "committed") throw new Error("Cannot abort a committed restart handoff");
		if (state !== "aborted") {
			state = "aborted";
			if (child.connected) child.send({ ...preparation, type: "restart-abort" });
		}
		await exit.promise;
	};
	return {
		pid: child.pid!,
		abort,
		commit: releaseWriter => {
			if (commit) return commit;
			if (state !== "ready") return Promise.reject(new Error("Restart candidate was aborted"));
			if (!child.connected || child.exitCode !== null || child.signalCode !== null)
				return Promise.reject(new Error("Restart candidate exited before writer release"));
			state = "committing";
			commit = (async () => {
				try {
					await releaseWriter();
				} catch (error) {
					state = "ready";
					await abort();
					throw error;
				}
				state = "committed";
				if (!child.connected) return 1;
				child.send({ ...preparation, type: "restart-commit" });
				return exit.promise;
			})();
			return commit;
		},
	};
}
