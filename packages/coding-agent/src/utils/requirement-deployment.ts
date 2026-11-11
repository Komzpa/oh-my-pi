import * as fs from "node:fs/promises";
import { ptree } from "@oh-my-pi/pi-utils";
import { withTimeoutSignal } from "./fetch-timeout";

export type RequirementDeploymentIdentity = {
	kind: "deploy";
	target: string;
	value: string;
	field?: string;
	scope?: "user" | "system";
	env?: string;
};

const TIMEOUT_MS = 5_000;
const MAX_HTTP_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_ENV_BYTES = 64 * 1024;

/** Operator-owned exact URLs; model-supplied declarations cannot grant network access. */
function isTrustedDeploymentUrl(target: string): boolean {
	try {
		const targets: unknown = JSON.parse(process.env.OMP_TRUSTED_DEPLOYMENT_URLS ?? "[]");
		return Array.isArray(targets) && targets.some(url => typeof url === "string" && url === target);
	} catch {
		return false;
	}
}

function failure(reason: string): { error: string } {
	return { error: reason };
}

function readField(value: unknown, field: string): unknown {
	let current = value;
	for (const key of field.split(".")) {
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

async function readBoundedBytes(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	signal: AbortSignal,
	onOverflow?: () => void,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				onOverflow?.();
				throw new Error(`output exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function probeHttp(
	identity: RequirementDeploymentIdentity,
	signal?: AbortSignal,
): Promise<{ value: string } | { error: string }> {
	if (!identity.field || !/^[^.]*(\.[^.]+)*$/.test(identity.field))
		return failure("HTTP deployment field is missing or invalid");
	let url: URL;
	try {
		url = new URL(identity.target);
	} catch {
		return failure("HTTP deployment URL is invalid");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
		return failure("HTTP deployment URL must be an HTTP(S) URL without credentials or fragment");
	}
	if (!isTrustedDeploymentUrl(identity.target))
		return failure("HTTP deployment URL is not in the operator's OMP_TRUSTED_DEPLOYMENT_URLS list");
	const boundedSignal = withTimeoutSignal(TIMEOUT_MS, signal);
	try {
		const response = await fetch(identity.target, { method: "GET", redirect: "error", signal: boundedSignal });
		if (!response.ok) return failure(`HTTP deployment probe returned status ${response.status}`);
		const body = response.body
			? await readBoundedBytes(response.body, MAX_HTTP_BYTES, boundedSignal)
			: new Uint8Array();
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		} catch {
			return failure("HTTP deployment response is not valid UTF-8 JSON");
		}
		const found = readField(parsed, identity.field);
		if (typeof found === "string") return { value: found };
		if (typeof found === "number" && Number.isFinite(found)) return { value: String(found) };
		return failure(`HTTP deployment field ${identity.field} is absent or not a string/finite number`);
	} catch (error) {
		return failure(
			boundedSignal.aborted
				? "HTTP deployment probe timed out or was cancelled"
				: `HTTP deployment probe failed: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
}

interface CommandResult {
	stdout: string;
	exitCode: number;
}

async function runCommand(args: string[], signal: AbortSignal): Promise<CommandResult> {
	using child = ptree.spawn(args, { signal });
	try {
		const stdout = new TextDecoder("utf-8", { fatal: true }).decode(
			await readBoundedBytes(child.stdout, MAX_COMMAND_BYTES, signal, () => child.kill()),
		);
		const exitCode = await child.exited;
		return { stdout, exitCode };
	} catch (error) {
		child.kill();
		await child.proc.exited.catch(() => {});
		throw error;
	}
}

async function readEnvironment(pid: number, key: string): Promise<string | undefined> {
	const handle = await fs.open(`/proc/${pid}/environ`, "r");
	try {
		const buffer = new Uint8Array(MAX_ENV_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
		if (bytesRead > MAX_ENV_BYTES) throw new Error("process environment exceeds read bound");
		const bytes = buffer.subarray(0, bytesRead);
		const prefix = new TextEncoder().encode(`${key}=`);
		let start = 0;
		for (let i = 0; i <= bytes.length; i++) {
			if (i !== bytes.length && bytes[i] !== 0) continue;
			const entry = bytes.subarray(start, i);
			start = i + 1;
			if (entry.length < prefix.length) continue;
			let matches = true;
			for (let j = 0; j < prefix.length; j++) if (entry[j] !== prefix[j]) matches = false;
			if (matches) return new TextDecoder("utf-8", { fatal: true }).decode(entry.subarray(prefix.length));
		}
		return undefined;
	} finally {
		await handle.close();
	}
}

function parseSystemdShow(output: string): { MainPID?: string; InvocationID?: string; ActiveState?: string } {
	const result: { MainPID?: string; InvocationID?: string; ActiveState?: string } = {};
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator < 0) continue;
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (key === "MainPID") result.MainPID = value;
		else if (key === "InvocationID") result.InvocationID = value;
		else if (key === "ActiveState") result.ActiveState = value;
	}
	return result;
}

async function probeUnit(
	identity: RequirementDeploymentIdentity,
	signal?: AbortSignal,
): Promise<{ value: string } | { error: string }> {
	if (!/^[A-Za-z0-9_.:@-]+\.service$/.test(identity.target))
		return failure("Unit deployment target must be one literal .service name");
	if (identity.scope !== "user" && identity.scope !== "system")
		return failure("Unit deployment scope must be user or system");
	if (!identity.env || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identity.env))
		return failure("Unit deployment environment key is invalid");
	const boundedSignal = ptree.combineSignals(signal, TIMEOUT_MS)!;
	const args = [
		"systemctl",
		...(identity.scope === "user" ? ["--user"] : []),
		"show",
		"--property=MainPID",
		"--property=InvocationID",
		"--property=ActiveState",
		"--",
		identity.target,
	];
	try {
		const first = await runCommand(args, boundedSignal);
		if (first.exitCode !== 0) return failure("systemctl could not inspect the declared unit");
		const before = parseSystemdShow(first.stdout);
		if (before.ActiveState !== "active")
			return failure(`Unit is not active (${before.ActiveState ?? "state unavailable"})`);
		if (!before.MainPID || !/^[1-9][0-9]*$/.test(before.MainPID) || !before.InvocationID)
			return failure("Unit has no verifiable running process identity");
		const pid = Number(before.MainPID);
		if (!Number.isSafeInteger(pid)) return failure("Unit MainPID is invalid");
		const value = await readEnvironment(pid, identity.env);
		if (value === undefined) return failure(`Running process does not expose ${identity.env}`);
		// Equality is enough for acceptance. Never export an arbitrary environment
		// value into the auditor prompt or even a mismatch diagnostic.
		if (value !== identity.value) return failure("Running process does not match the declared deployment version");
		const second = await runCommand(args, boundedSignal);
		if (second.exitCode !== 0) return failure("systemctl could not recheck the declared unit");
		const after = parseSystemdShow(second.stdout);
		if (
			after.ActiveState !== "active" ||
			after.MainPID !== before.MainPID ||
			after.InvocationID !== before.InvocationID
		) {
			return failure("Unit process or invocation changed during the probe");
		}
		return { value: identity.value };
	} catch (error) {
		return failure(
			boundedSignal.aborted
				? "Unit deployment probe timed out or was cancelled"
				: `Unit deployment probe failed: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
}

export function probeRequirementDeployment(
	identity: RequirementDeploymentIdentity,
	signal?: AbortSignal,
): Promise<{ value: string } | { error: string }> {
	if (identity.kind !== "deploy") return Promise.resolve(failure("Deployment identity kind must be deploy"));
	if (identity.scope !== undefined || identity.env !== undefined) return probeUnit(identity, signal);
	return probeHttp(identity, signal);
}
