/** Authenticated local control for exact live session generations. */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import type { RestartControlIdentity, RestartControlRequest, RestartControlSnapshot } from "./task/restart-queue";

export const RESTART_CONTROL_PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 1_500;
const ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;

export interface RestartControlSource {
	snapshot(): RestartControlSnapshot;
	handle(request: RestartControlRequest): Promise<RestartControlSnapshot>;
}

export interface RestartControlOptions {
	runtimeDir?: string;
}

export interface RestartControlPublication {
	dispose(): Promise<void>;
}

export type RestartControlErrorCode =
	| "target_not_found"
	| "invalid_metadata"
	| "unsupported_protocol"
	| "unsupported_platform"
	| "unreachable"
	| "authentication_failed"
	| "stale_identity"
	| "invalid_request"
	| "request_too_large"
	| "response_too_large"
	| "malformed_response"
	| "handler_failed";

export class RestartControlError extends Error {
	readonly code: RestartControlErrorCode;

	constructor(code: RestartControlErrorCode, message: string = code) {
		super(message);
		this.name = "RestartControlError";
		this.code = code;
	}
}

interface Metadata {
	version: number;
	instanceId: string;
	pid: number;
	endpoint: string;
	token: string;
}

interface WireRequest {
	v: number;
	token: string;
	op: "discover" | RestartControlRequest["op"];
	request?: RestartControlRequest;
}

function runtimeDirectory(): string {
	return path.join(getBaseConfigRoot(), "run", "restart-controls");
}

function identityIsValid(value: unknown): value is RestartControlIdentity {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.instanceId === "string" &&
		ID_PATTERN.test(item.instanceId) &&
		typeof item.sessionId === "string" &&
		item.sessionId.length > 0 &&
		typeof item.generation === "number" &&
		Number.isSafeInteger(item.generation) &&
		item.generation >= 0
	);
}

function sameIdentity(a: RestartControlIdentity, b: RestartControlIdentity): boolean {
	return a.instanceId === b.instanceId && a.sessionId === b.sessionId && a.generation === b.generation;
}

function parseSnapshot(value: unknown): RestartControlSnapshot | null {
	if (typeof value !== "object" || value === null) return null;
	const item = value as Record<string, unknown>;
	if (!identityIsValid(item.identity)) return null;
	if (typeof item.pid !== "number" || !Number.isSafeInteger(item.pid) || item.pid <= 0) return null;
	if (typeof item.cwd !== "string" || item.cwd.length > 4096) return null;
	const request = item.request;
	if (request !== null && (typeof request !== "object" || request === null)) return null;
	return value as RestartControlSnapshot;
}

function parseMetadata(text: string): Metadata | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const meta = raw as Record<string, unknown>;
	if (meta.version !== RESTART_CONTROL_PROTOCOL_VERSION) return null;
	if (typeof meta.instanceId !== "string" || !ID_PATTERN.test(meta.instanceId)) return null;
	if (typeof meta.pid !== "number" || !Number.isSafeInteger(meta.pid) || meta.pid <= 0) return null;
	if (typeof meta.endpoint !== "string" || meta.endpoint.length === 0 || meta.endpoint.length > 4096) return null;
	if (typeof meta.token !== "string" || !/^[a-f0-9]{64}$/.test(meta.token)) return null;
	return {
		version: meta.version,
		instanceId: meta.instanceId,
		pid: meta.pid,
		endpoint: meta.endpoint,
		token: meta.token,
	};
}

function tokenMatches(expected: string, actual: unknown): boolean {
	if (typeof actual !== "string") return false;
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(actual, "utf8");
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function ensurePrivateDir(dir: string): Promise<void> {
	await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fsp.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new RestartControlError("invalid_metadata", "restart control runtime path is not a directory");
	const uid = process.getuid?.();
	if (process.platform !== "win32" && uid !== undefined && stat.uid !== uid) {
		throw new RestartControlError("invalid_metadata", "restart control runtime directory is not owned by this user");
	}
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await fsp.chmod(dir, 0o700);
}

async function endpointPath(dir: string, instanceId: string): Promise<string> {
	const canonical = path.join(dir, `${instanceId}.sock`);
	if (Buffer.byteLength(canonical) < SUN_PATH_LIMIT) return canonical;
	const uid = String(process.getuid?.() ?? 0);
	const key = new Bun.CryptoHasher("sha256").update(uid).update("\0").update(dir).digest("hex").slice(0, 20);
	const fallbackDir = path.join(os.tmpdir(), `omp-restart-${key}`);
	await ensurePrivateDir(fallbackDir);
	return path.join(fallbackDir, `${instanceId}.sock`);
}

function respond(socket: net.Socket, value: object): void {
	const line = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_RESPONSE_BYTES) {
		socket.end(
			`${JSON.stringify({ ok: false, v: RESTART_CONTROL_PROTOCOL_VERSION, error: "response_too_large" })}\n`,
		);
		return;
	}
	socket.end(line);
}

function serveConnection(socket: net.Socket, token: string, source: RestartControlSource): void {
	let buffer = "";
	let handled = false;
	const fail = (code: RestartControlErrorCode, message?: string): void => {
		handled = true;
		respond(socket, { ok: false, v: RESTART_CONTROL_PROTOCOL_VERSION, error: code, ...(message ? { message } : {}) });
	};

	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.on("data", chunk => {
		if (handled) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
			fail("request_too_large");
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		let raw: unknown;
		try {
			raw = JSON.parse(buffer.slice(0, newline));
		} catch {
			fail("invalid_request");
			return;
		}
		if (typeof raw !== "object" || raw === null) {
			fail("invalid_request");
			return;
		}
		const wire = raw as Record<string, unknown>;
		if (wire.v !== RESTART_CONTROL_PROTOCOL_VERSION) {
			fail("unsupported_protocol");
			return;
		}
		if (!tokenMatches(token, wire.token)) {
			fail("authentication_failed");
			return;
		}
		if (wire.op === "discover") {
			let snapshot: RestartControlSnapshot;
			try {
				snapshot = source.snapshot();
			} catch {
				fail("handler_failed");
				return;
			}
			handled = true;
			respond(socket, { ok: true, v: RESTART_CONTROL_PROTOCOL_VERSION, snapshot });
			return;
		}
		if (wire.op !== "request" && wire.op !== "status" && wire.op !== "cancel") {
			fail("invalid_request");
			return;
		}
		const request = wire.request as RestartControlRequest | undefined;
		if (!request || request.op !== wire.op || !identityIsValid(request.identity)) {
			fail("invalid_request");
			return;
		}
		let current: RestartControlSnapshot;
		try {
			current = source.snapshot();
		} catch {
			fail("handler_failed");
			return;
		}
		if (!sameIdentity(current.identity, request.identity)) {
			fail("stale_identity");
			return;
		}
		handled = true;
		void Promise.resolve()
			.then(() => source.handle(request))
			.then(
				snapshot => {
					if (!sameIdentity(snapshot.identity, request.identity)) {
						fail("stale_identity");
						return;
					}
					handled = true;
					respond(socket, { ok: true, v: RESTART_CONTROL_PROTOCOL_VERSION, snapshot });
				},
				(error: unknown) => fail("handler_failed", boundedErrorMessage(error, token)),
			);
	});
}

function boundedErrorMessage(error: unknown, token: string): string {
	const raw = error instanceof Error ? error.message : "Request handler failed";
	return (
		raw
			.replaceAll(token, "[redacted]")
			.replace(/[\x00-\x1f\x7f]/g, " ")
			.slice(0, 1024) || "Request handler failed"
	);
}

function query(meta: Metadata, payload: Omit<WireRequest, "v" | "token">): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let buffer = "";
	let settled = false;
	const socket = net.createConnection({ path: meta.endpoint });
	const timer = setTimeout(() => finish(new RestartControlError("unreachable")), REQUEST_TIMEOUT_MS);
	const finish = (result: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.destroy();
		if (result instanceof Error) reject(result);
		else resolve(result);
	};
	socket.once("error", () => finish(new RestartControlError("unreachable")));
	socket.once("connect", () => {
		const line = `${JSON.stringify({ v: RESTART_CONTROL_PROTOCOL_VERSION, token: meta.token, ...payload })}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
			finish(new RestartControlError("request_too_large"));
			return;
		}
		socket.write(line);
	});
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
			finish(new RestartControlError("response_too_large"));
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		let raw: unknown;
		try {
			raw = JSON.parse(buffer.slice(0, newline));
		} catch {
			finish(new RestartControlError("malformed_response"));
			return;
		}
		if (typeof raw !== "object" || raw === null) {
			finish(new RestartControlError("malformed_response"));
			return;
		}
		const response = raw as Record<string, unknown>;
		if (response.v !== RESTART_CONTROL_PROTOCOL_VERSION) {
			finish(new RestartControlError("unsupported_protocol"));
			return;
		}
		if (response.ok !== true) {
			const code = response.error;
			const message = typeof response.message === "string" ? response.message.slice(0, 1024) : undefined;
			finish(
				new RestartControlError(
					isControlErrorCode(code) ? code : "malformed_response",
					message ?? (isControlErrorCode(code) ? code : "malformed_response"),
				),
			);
			return;
		}
		finish(response.snapshot);
	});
	socket.once("close", () => {
		if (!settled) finish(new RestartControlError("unreachable"));
	});
	return promise;
}

function isControlErrorCode(value: unknown): value is RestartControlErrorCode {
	return (
		typeof value === "string" &&
		[
			"target_not_found",
			"invalid_metadata",
			"unsupported_protocol",
			"unsupported_platform",
			"unreachable",
			"authentication_failed",
			"stale_identity",
			"invalid_request",
			"request_too_large",
			"response_too_large",
			"malformed_response",
			"handler_failed",
		].includes(value)
	);
}

async function readMetadata(dir: string, instanceId: string): Promise<Metadata> {
	if (!ID_PATTERN.test(instanceId)) throw new RestartControlError("target_not_found");
	let text: string;
	try {
		text = await Bun.file(path.join(dir, `${instanceId}.json`)).text();
	} catch (error) {
		if (isEnoent(error)) throw new RestartControlError("target_not_found");
		throw error;
	}
	const meta = parseMetadata(text);
	if (!meta || meta.instanceId !== instanceId) throw new RestartControlError("invalid_metadata");
	return meta;
}

export async function publishRestartControl(
	source: RestartControlSource,
	options?: RestartControlOptions,
): Promise<RestartControlPublication> {
	if (process.platform === "win32") throw new RestartControlError("unsupported_platform");
	const dir = options?.runtimeDir ?? runtimeDirectory();
	await ensurePrivateDir(dir);
	const initial = source.snapshot();
	if (!identityIsValid(initial.identity)) throw new RestartControlError("invalid_metadata");
	const instanceId = initial.identity.instanceId;
	const token = crypto.randomBytes(32).toString("hex");
	const endpoint = await endpointPath(dir, instanceId);
	const metadataPath = path.join(dir, `${instanceId}.json`);
	const meta: Metadata = { version: RESTART_CONTROL_PROTOCOL_VERSION, instanceId, pid: process.pid, endpoint, token };
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		serveConnection(socket, token, source);
	});
	let bound = false;
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(endpoint, () => {
		bound = true;
		listening.resolve();
	});
	try {
		await listening.promise;
		await fsp.chmod(endpoint, 0o600);
		const handle = await fsp.open(metadataPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(meta), "utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (bound) {
			server.close();
			try {
				await fsp.rm(endpoint, { force: true });
			} catch {}
		}
		throw error;
	}
	const removeOwnedArtifacts = async (): Promise<void> => {
		try {
			const current = parseMetadata(await Bun.file(metadataPath).text());
			if (current?.token === token && current.endpoint === endpoint) {
				await fsp.rm(metadataPath, { force: true });
				await fsp.rm(endpoint, { force: true });
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	};
	let disposed = false;
	return {
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			for (const socket of sockets) socket.destroy();
			await removeOwnedArtifacts();
			await closed.promise;
		},
	};
}

export async function listRestartControls(options?: RestartControlOptions): Promise<RestartControlSnapshot[]> {
	const dir = options?.runtimeDir ?? runtimeDirectory();
	let names: string[];
	try {
		const stat = await fsp.lstat(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RestartControlError("invalid_metadata");
		const uid = process.getuid?.();
		if (uid !== undefined && stat.uid !== uid) throw new RestartControlError("invalid_metadata");
		if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new RestartControlError("invalid_metadata");
		names = await fsp.readdir(dir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const snapshots: RestartControlSnapshot[] = [];
	for (const name of names.filter(entry => entry.endsWith(".json")).sort()) {
		const filenameId = name.slice(0, -5);
		let meta: Metadata;
		try {
			meta = await readMetadata(dir, filenameId);
		} catch {
			continue;
		}
		try {
			const snapshot = parseSnapshot(await query(meta, { op: "discover" }));
			if (snapshot?.identity.instanceId === meta.instanceId) snapshots.push(snapshot);
		} catch {
			// Discovery omits unavailable/malformed endpoints; an explicit operation reports its error.
		}
	}
	return snapshots;
}

export async function sendRestartControl(
	request: RestartControlRequest,
	options?: RestartControlOptions,
): Promise<RestartControlSnapshot> {
	if (!identityIsValid(request.identity)) throw new RestartControlError("invalid_request");
	const dir = options?.runtimeDir ?? runtimeDirectory();
	const meta = await readMetadata(dir, request.identity.instanceId);
	if (meta.instanceId !== request.identity.instanceId) throw new RestartControlError("stale_identity");
	const snapshot = parseSnapshot(await query(meta, { op: request.op, request }));
	if (!snapshot) throw new RestartControlError("malformed_response");
	if (!sameIdentity(snapshot.identity, request.identity)) throw new RestartControlError("stale_identity");
	return snapshot;
}
