import * as fsSync from "node:fs";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { probeRequirementDeployment, type RequirementDeploymentIdentity } from "./requirement-deployment";

/** Declarative identities carried by requirement receipts, independent of worker ownership. */
export type RequirementIdentity =
	| { kind: "git"; repo: string; commit: string; paths?: string[] }
	| { kind: "file"; path: string; canonicalPath?: string; sha256: string }
	| RequirementDeploymentIdentity;

export type RequirementIdentityTarget =
	| { kind: "git"; repo: string; paths?: string[] }
	| { kind: "file"; path: string }
	| (Omit<RequirementDeploymentIdentity, "value"> & { value?: string });

export type RequirementIdentityCheck =
	| { state: "fresh" }
	| { state: "stale"; kind: RequirementIdentity["kind"]; location: string; expected: string; observed: string }
	| { state: "unverifiable"; kind: RequirementIdentity["kind"]; location: string; expected: string; reason: string };

/** Read a fresh Git status snapshot through the shared, rate-limited status queue. */
export function currentRequirementGitStatus(
	repo: VcsGitRepo,
	signal?: AbortSignal,
	includeUntracked = false,
): Promise<string> {
	return vcs.statusPorcelainFresh(repo, { untracked: includeUntracked ? "all" : "no", nulTerminated: true }, signal);
}

function trackedRequirementChangePaths(status: string): string[] {
	const fields = status.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]!;
		if (!field) continue;
		const code = field.slice(0, 2);
		if (code !== "??") paths.push(field.slice(3));
		if (code.includes("R") || code.includes("C")) {
			const origin = fields[++index];
			if (origin) paths.push(origin);
		}
	}
	return paths;
}

/** Semicolons inside JSON strings are part of a target/path/value, not receipt separators. */
export function splitRequirementIdentitySegments(text: string): string[] {
	if (!text.trim()) return [];
	const segments: string[] = [];
	let quoted = false;
	let escaped = false;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && char === "\\") escaped = true;
		else if (char === '"') quoted = !quoted;
		else if (!quoted && char === ";") {
			segments.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	segments.push(text.slice(start).trim());
	return segments;
}

function wireString(value: string): string {
	return value.length > 0 && !/[\s@;"\\]/.test(value) ? value : JSON.stringify(value);
}

export function formatRequirementIdentity(identity: RequirementIdentity): string {
	if (identity.kind === "file") {
		const canonical = identity.canonicalPath === undefined ? "" : ` canonical=${wireString(identity.canonicalPath)}`;
		return `file:${wireString(identity.path)}@sha256=${identity.sha256.toLowerCase()}${canonical}`;
	}
	if (identity.kind === "git") {
		const paths = identity.paths === undefined ? "" : ` paths=${JSON.stringify(identity.paths)}`;
		return `git:${wireString(identity.repo)}@${identity.commit.toLowerCase()}${paths}`;
	}
	const field = identity.field === undefined ? "" : ` field=${identity.field}`;
	const scope = identity.scope === undefined ? "" : ` scope=${identity.scope}`;
	const env = identity.env === undefined ? "" : ` env=${identity.env}`;
	return `deploy:${wireString(identity.target)}@${wireString(identity.value)}${field}${scope}${env}`;
}

function absoluteIdentityPath(value: string): boolean {
	return path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value) && path.normalize(value) === value;
}

function validGitPath(value: string): boolean {
	return (
		value.length > 0 &&
		Buffer.byteLength(value, "utf8") <= 4096 &&
		value.split("/").length <= REQUIREMENT_ARTIFACT_LIMITS.maxDepth + 1 &&
		!path.posix.isAbsolute(value) &&
		!/[\x00-\x1f\x7f\\]/.test(value) &&
		value.split("/").every(part => part !== "" && part !== "." && part !== "..")
	);
}

/** Read either one JSON string or an unquoted wire atom. Returns the untouched suffix. */
function readWireAtom(text: string, stopAtAt: boolean): { value: string; rest: string } {
	if (text.startsWith('"')) {
		let escaped = false;
		for (let i = 1; i < text.length; i++) {
			if (escaped) escaped = false;
			else if (text[i] === "\\") escaped = true;
			else if (text[i] === '"') {
				const value: unknown = JSON.parse(text.slice(0, i + 1));
				if (typeof value !== "string") fail("identity atom must be a string");
				return { value, rest: text.slice(i + 1) };
			}
		}
		fail("unterminated identity string");
	}
	if (stopAtAt) {
		const match = /^([^\s;"\\]+)@/.exec(text);
		if (!match) fail("missing identity target or @ delimiter");
		return { value: match[1]!, rest: text.slice(match[1]!.length) };
	}
	const match = /^[^\s;"\\]+/.exec(text);
	if (!match) fail("missing identity target or value");
	return { value: match[0], rest: text.slice(match[0].length) };
}

export function parseRequirementIdentity(text: string): { identity: RequirementIdentity } | { error: string } {
	try {
		const input = text.trim();
		const prefix = /^(git|file|deploy):/.exec(input);
		if (!prefix) fail("expected git:, file:, or deploy: identity");
		const target = readWireAtom(input.slice(prefix[0].length), true);
		if (!target.rest.startsWith("@")) fail("identity requires @ followed by its exact value");
		const value = readWireAtom(target.rest.slice(1), false);
		if (!target.value || !value.value || /[\x00-\x1f\x7f]/.test(value.value)) fail("invalid identity value");
		if (value.rest && !/^\s/.test(value.rest)) fail("identity attributes must be space-separated");
		const suffix = value.rest.trim();
		if (prefix[1] === "file") {
			if (!absoluteIdentityPath(target.value)) fail("file identity requires an exact absolute path");
			if (!/^sha256=[a-fA-F0-9]{64}$/.test(value.value))
				fail("file identity requires sha256= followed by a full SHA-256");
			let canonicalPath: string | undefined;
			if (suffix) {
				if (!suffix.startsWith("canonical=")) fail("file identity accepts only canonical=<absolute path>");
				const canonical = readWireAtom(suffix.slice(10), false);
				if (canonical.rest.trim() || !absoluteIdentityPath(canonical.value))
					fail("file canonical path requires an exact absolute path");
				canonicalPath = canonical.value;
			}
			return {
				identity: {
					kind: "file",
					path: target.value,
					sha256: value.value.slice(7).toLowerCase(),
					...(canonicalPath === undefined ? {} : { canonicalPath }),
				},
			};
		}
		if (prefix[1] === "git") {
			if (!absoluteIdentityPath(target.value)) fail("git identity requires an exact absolute repository root");
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.value)) fail("git identity requires a full commit OID");
			let paths: string[] | undefined;
			if (suffix) {
				if (!suffix.startsWith("paths=")) fail("git identity accepts only paths=<JSON file array>");
				let decoded: unknown;
				try {
					decoded = JSON.parse(suffix.slice(6));
				} catch {
					fail(
						'git paths requires a JSON array of quoted relative paths, for example paths=["src/file.ts","test/file.test.ts"]',
					);
				}
				if (
					!Array.isArray(decoded) ||
					decoded.length === 0 ||
					decoded.length > REQUIREMENT_ARTIFACT_LIMITS.maxFiles ||
					!decoded.every((entry: unknown): entry is string => typeof entry === "string" && validGitPath(entry))
				)
					fail("git paths must be a nonempty bounded array of exact relative file paths");
				paths = decoded;
				if (new Set(paths).size !== paths.length) fail("git paths must be unique");
			}
			return {
				identity: {
					kind: "git",
					repo: target.value,
					commit: value.value.toLowerCase(),
					...(paths ? { paths } : {}),
				},
			};
		}
		const attributes = new Map<string, string>();
		for (const atom of suffix ? suffix.split(/\s+/) : []) {
			const match = /^(field|scope|env)=([^\s=]+)$/.exec(atom);
			if (!match || attributes.has(match[1]!)) fail("invalid or duplicate deployment attribute");
			attributes.set(match[1]!, match[2]!);
		}
		const field = attributes.get("field");
		const scope = attributes.get("scope");
		const env = attributes.get("env");
		if (/^https?:\/\//i.test(target.value)) {
			const url = new URL(target.value);
			if (!url.hostname || url.username || url.password || url.hash)
				fail("deployment URL must not contain credentials or a fragment");
			if (!field || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field))
				fail("HTTP deployment requires field=<dot JSON path>");
			if (scope || env) fail("HTTP deployment does not accept scope or env");
			return { identity: { kind: "deploy", target: target.value, value: value.value, field } };
		}
		if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/.test(target.value))
			fail("deployment target must be an HTTP(S) URL or literal .service unit");
		if (field || (scope !== "user" && scope !== "system") || !env || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))
			fail("unit deployment requires scope=user|system and env=<version key>, without field");
		return { identity: { kind: "deploy", target: target.value, value: value.value, scope, env } };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Bounds for requirement artifacts. Exceeding any bound fails closed with a reason.
 * Top-level resources resolve to local regular files or directories. Canonical targets
 * use non-following stable reads; directory symlinks describe links, never target bytes.
 */
export const REQUIREMENT_ARTIFACT_LIMITS = {
	maxFiles: 4096,
	maxBytes: 256 * 1024 * 1024,
	maxDepth: 32,
} as const;

/**
 * Identity of a requirement resource.
 * - `dirty: false`: `sha256` is the digest the requirement verdict is bound to.
 * - `dirty: true`: this helper cannot attest the resource; `reason` says why.
 * `cwd` preserves the given binding path; `canonicalPaths` records the resolved read targets.
 */
export type RequirementResourceArtifact =
	| { cwd: string; head: null; dirty: false; sha256: string; canonicalPaths: string[] }
	| { cwd: string; head: null; dirty: true; reason: string };

/** Domain tag that keeps manifest digests disjoint from plain file digests. */
const MANIFEST_TAG = "omp-requirement-manifest/v1";

export interface Identity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

type FileEntry = {
	/** Relative path, `/`-separated, unique within the manifest. */
	rel: string;
	abs: string;
	identity: Identity;
} & ({ type: "file" } | { type: "symlink"; target: string });

class ArtifactError extends Error {}

class ArtifactMissingError extends ArtifactError {}

/** Capture real ancestors without following symlinks. Directory mtimes are irrelevant to named files. */
async function safeArtifactParents(abs: string): Promise<Array<{ path: string; dev: number; ino: number }>> {
	const parents: Array<{ path: string; dev: number; ino: number }> = [];
	let parent = path.dirname(abs);
	while (true) {
		const st = await fs.lstat(parent).catch(err => {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")
				throw new ArtifactMissingError(`${parent}: missing`);
			return fail(describeFsError(parent, err));
		});
		if (st.isSymbolicLink()) fail(`${parent}: symlink is not followed`);
		if (!st.isDirectory()) fail(`${parent}: not a directory`);
		parents.push({ path: parent, dev: st.dev, ino: st.ino });
		const next = path.dirname(parent);
		if (next === parent) break;
		parent = next;
	}
	return parents;
}

/** Bounded binary descriptor reads; replacement, resize, mode or ancestor drift fails closed. */
async function readStableArtifactFile(
	abs: string,
	consume: (chunk: Uint8Array) => void,
	signal?: AbortSignal,
	begin?: (st: Stats) => void,
): Promise<Stats> {
	signal?.throwIfAborted();
	const parents = await safeArtifactParents(abs);
	const before = await statRegularFile(abs, abs);
	if (before.size > REQUIREMENT_ARTIFACT_LIMITS.maxBytes)
		fail(`${abs}: exceeds byte bound ${REQUIREMENT_ARTIFACT_LIMITS.maxBytes}`);
	const handle = await fs
		.open(abs, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK)
		.catch(err => fail(describeFsError(abs, err)));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || !sameIdentity(identityOf(before), identityOf(opened)) || before.mode !== opened.mode)
			fail(`${abs}: changed while opening`);
		if (process.platform === "linux" && (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== abs)
			fail(`${abs}: descriptor escaped declared path`);
		begin?.(opened);
		const buffer = new Uint8Array(64 * 1024);
		let bytes = 0;
		while (true) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			bytes += bytesRead;
			if (bytes > before.size || bytes > REQUIREMENT_ARTIFACT_LIMITS.maxBytes)
				fail(`${abs}: changed while reading or exceeds byte bound`);
			consume(buffer.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		const named = await statRegularFile(abs, abs);
		if (
			bytes !== before.size ||
			!sameIdentity(identityOf(before), identityOf(after)) ||
			!sameIdentity(identityOf(before), identityOf(named)) ||
			before.mode !== after.mode ||
			before.mode !== named.mode
		)
			fail(`${abs}: changed while reading`);
		if (JSON.stringify(parents) !== JSON.stringify(await safeArtifactParents(abs)))
			fail(`${abs}: ancestor changed while reading`);
		if ((await fs.realpath(abs)) !== abs) fail(`${abs}: path escaped declared location`);
		return before;
	} finally {
		await handle.close();
	}
}

function fail(reason: string): never {
	throw new ArtifactError(reason);
}

function describeFsError(label: string, err: unknown): string {
	const code =
		typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
	if (code === "ENOENT") return `${label}: missing`;
	if (code === "EACCES" || code === "EPERM") return `${label}: inaccessible (${code})`;
	return `${label}: unreadable (${code ?? "unknown error"})`;
}

export function identityOf(st: Stats): Identity {
	return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

/** Identity unchanged between two stats. Any drift in device, inode, size, or times counts as a change. */
export function sameIdentity(a: Identity, b: Identity): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** UTF-8 byte order equals Unicode codepoint order, unlike UTF-16 `<`. */
function compareCodepoints(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Non-following stat. Symlinks, directories, and other special files are rejected. */
async function statRegularFile(filePath: string, label: string): Promise<Stats> {
	const st = await fs.lstat(filePath).catch(err => {
		if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")
			throw new ArtifactMissingError(`${label}: missing`);
		return fail(describeFsError(label, err));
	});
	if (st.isSymbolicLink()) fail(`${label}: symlink is not followed`);
	if (!st.isFile()) fail(`${label}: not a regular file`);
	return st;
}

/**
 * Streamed SHA-256 of one regular file. Fails closed when the file is missing,
 * inaccessible, non-regular, over the byte bound, or changes while it is read.
 */
export async function hashArtifactFile(filePath: string, signal?: AbortSignal): Promise<string> {
	const abs = path.resolve(filePath);
	const hasher = new Bun.CryptoHasher("sha256");
	await readStableArtifactFile(
		abs,
		chunk => {
			hasher.update(chunk);
		},
		signal,
	);
	return hasher.digest("hex");
}

/** Read the link itself, with the same replacement and ancestor checks as regular files. */
async function readStableArtifactLink(abs: string, rel: string): Promise<FileEntry & { type: "symlink" }> {
	const parents = await safeArtifactParents(abs);
	const before = await fs.lstat(abs).catch(err => fail(describeFsError(abs, err)));
	if (!before.isSymbolicLink()) fail(`${abs}: changed before reading symlink`);
	const target = await fs.readlink(abs).catch(err => fail(describeFsError(abs, err)));
	const after = await fs.lstat(abs).catch(err => fail(describeFsError(abs, err)));
	if (!after.isSymbolicLink() || !sameIdentity(identityOf(before), identityOf(after)) || before.mode !== after.mode)
		fail(`${abs}: changed while reading symlink`);
	if (JSON.stringify(parents) !== JSON.stringify(await safeArtifactParents(abs)))
		fail(`${abs}: ancestor changed while reading symlink`);
	return { rel, abs, identity: identityOf(before), type: "symlink", target };
}

/**
 * Deterministic, bounded listing of a directory tree. Every regular file is included,
 * dotfiles too. Symlinks are entries; special files and excess depth, count, or bytes fail closed.
 * Result is sorted by codepoint order of the relative path.
 */
async function walkDirectory(root: string, signal?: AbortSignal): Promise<FileEntry[]> {
	const { maxFiles, maxBytes, maxDepth } = REQUIREMENT_ARTIFACT_LIMITS;
	const files: FileEntry[] = [];
	let bytes = 0;

	const visit = async (dir: string, relDir: string, depth: number): Promise<void> => {
		signal?.throwIfAborted();
		const before = await fs.lstat(dir).catch(err => fail(describeFsError(dir, err)));
		if (before.isSymbolicLink()) fail(`${dir}: symlink is not followed`);
		if (!before.isDirectory()) fail(`${dir}: not a directory`);
		const dirents: Dirent[] = await fs
			.readdir(dir, { withFileTypes: true })
			.catch(err => fail(describeFsError(dir, err)));
		for (const dirent of dirents) {
			const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
			const abs = path.join(dir, dirent.name);
			if (dirent.isDirectory()) {
				if (depth + 1 > maxDepth) fail(`${rel}: exceeds depth bound ${maxDepth}`);
				await visit(abs, rel, depth + 1);
				continue;
			}
			if (files.length >= maxFiles) fail(`directory exceeds file-count bound ${maxFiles}`);
			let entry: FileEntry;
			if (dirent.isSymbolicLink()) {
				const link = await readStableArtifactLink(abs, rel);
				bytes += Buffer.byteLength(link.target, "utf8");
				entry = link;
			} else {
				if (!dirent.isFile()) fail(`${abs}: not a regular file`);
				const st = await statRegularFile(abs, abs);
				bytes += st.size;
				entry = { rel, abs, identity: identityOf(st), type: "file" };
			}
			if (bytes > maxBytes) fail(`${root}: directory exceeds aggregate byte bound ${maxBytes}`);
			files.push(entry);
		}
		const after = await fs.lstat(dir).catch(err => fail(describeFsError(dir, err)));
		if (!sameIdentity(identityOf(before), identityOf(after)) || after.isSymbolicLink())
			fail(`${dir}: changed while listing`);
	};

	await visit(root, "", 0);
	return files.sort((a, b) => compareCodepoints(a.rel, b.rel));
}

/**
 * Manifest digest: SHA-256 of the JSON text `["omp-requirement-manifest/v1", [[relPath, fileSha256], ...]]`.
 * Rows are in codepoint order of `relPath`. JSON string escaping makes the encoding unambiguous.
 * Symlink rows are [relPath, "symlink", SHA256(JSON(["symlink", readlinkTarget]))].
 * They intentionally bind only the target string: retargeting stales the artifact,
 * while editing the linked file does not. Links are never traversed (even dangling/cyclic ones).
 */
async function manifestSha256(files: readonly FileEntry[], signal?: AbortSignal): Promise<string> {
	const rows: Array<[string, string] | [string, "symlink", string]> = [];
	for (const file of files) {
		signal?.throwIfAborted();
		if (file.type === "symlink") {
			const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(["symlink", file.target])).digest("hex");
			rows.push([file.rel, "symlink", digest]);
		} else rows.push([file.rel, await hashArtifactFile(file.abs, signal)]);
	}
	return new Bun.CryptoHasher("sha256").update(JSON.stringify([MANIFEST_TAG, rows])).digest("hex");
}

/** Directory manifest. A second walk must match the first, so concurrent adds or removes fail closed. */
async function hashDirectory(root: string, signal?: AbortSignal): Promise<string> {
	const parents = await safeArtifactParents(root);
	const before = await fs.lstat(root).catch(err => fail(describeFsError(root, err)));
	const first = await walkDirectory(root, signal);
	if (first.length === 0) fail(`${root}: directory contains no regular files`);
	const digest = await manifestSha256(first, signal);
	const second = await walkDirectory(root, signal);
	const identitiesOf = (files: readonly FileEntry[]) =>
		JSON.stringify(files.map(f => [f.rel, f.type, f.identity, f.type === "symlink" ? f.target : null]));
	const after = await fs.lstat(root).catch(err => fail(describeFsError(root, err)));
	if (
		!after.isDirectory() ||
		!sameIdentity(identityOf(before), identityOf(after)) ||
		identitiesOf(first) !== identitiesOf(second)
	)
		fail(`${root}: changed while hashing`);
	if (JSON.stringify(parents) !== JSON.stringify(await safeArtifactParents(root)))
		fail(`${root}: ancestor changed while hashing`);
	return digest;
}

/** Deepest directory that contains every given directory. */
function commonDirectory(dirs: readonly string[]): string {
	const segments = dirs.map(dir => dir.split(path.sep));
	const first = segments[0];
	let common = first.length;
	for (const parts of segments) {
		let i = 0;
		while (i < common && i < parts.length && parts[i] === first[i]) i++;
		common = i;
	}
	return first.slice(0, common).join(path.sep) || path.sep;
}

/**
 * Identity of a requirement's declared resources. Input order does not matter.
 * - One regular file: plain SHA-256 of its bytes; cwd is the file path itself.
 * - One directory (not a Git repo; callers handle Git): manifest of every file in it; cwd is the directory.
 * - Several regular files: manifest over paths relative to their common parent directory; cwd is that parent.
 *
 * Resource problems never throw; they return `dirty: true` with a specific reason.
 * Abort signals are rethrown.
 */
export async function resolveResourceArtifact(
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<RequirementResourceArtifact> {
	const absPaths = paths.map(p => path.resolve(p));
	const cwd =
		absPaths.length === 1
			? absPaths[0]
			: absPaths.length > 1
				? commonDirectory(absPaths.map(p => path.dirname(p)))
				: path.sep;
	try {
		if (absPaths.length === 0) fail("no resource paths declared");
		if (new Set(absPaths).size !== absPaths.length) fail("duplicate resource path");
		const canonicalPaths: string[] = [];
		for (const abs of absPaths) canonicalPaths.push(await canonicalArtifactPath(abs));
		let sha256: string;
		if (absPaths.length === 1) {
			const [abs] = canonicalPaths;
			const st = await fs.lstat(abs).catch(err => fail(describeFsError(abs, err)));
			sha256 = st.isDirectory() ? await hashDirectory(abs, signal) : await hashArtifactFile(abs, signal);
		} else {
			const files: FileEntry[] = [];
			let bytes = 0;
			for (const [index, abs] of canonicalPaths.entries()) {
				const rel = path.relative(cwd, absPaths[index]!).split(path.sep).join("/");
				const st = await statRegularFile(abs, abs);
				if (files.length >= REQUIREMENT_ARTIFACT_LIMITS.maxFiles) {
					fail(`resource set exceeds file-count bound ${REQUIREMENT_ARTIFACT_LIMITS.maxFiles}`);
				}
				bytes += st.size;
				if (bytes > REQUIREMENT_ARTIFACT_LIMITS.maxBytes) {
					fail(`resource set exceeds aggregate byte bound ${REQUIREMENT_ARTIFACT_LIMITS.maxBytes}`);
				}
				files.push({ rel, abs, identity: identityOf(st), type: "file" });
			}
			files.sort((a, b) => compareCodepoints(a.rel, b.rel));
			sha256 = await manifestSha256(files, signal);
			// Re-check every explicit file after the full manifest is hashed, so an earlier file changed during a later hash fails closed.
			for (const file of files) {
				const current = identityOf(await statRegularFile(file.abs, file.abs));
				if (!sameIdentity(file.identity, current)) fail(`${file.rel}: changed while hashing`);
			}
		}
		for (const [index, abs] of absPaths.entries()) {
			if ((await canonicalArtifactPath(abs)) !== canonicalPaths[index])
				fail(`${abs}: canonical path changed while hashing`);
		}
		return { cwd, head: null, dirty: false, sha256, canonicalPaths };
	} catch (err) {
		if (signal?.aborted) throw err;
		const reason = err instanceof Error ? err.message : String(err);
		return { cwd, head: null, dirty: true, reason };
	}
}

/** Resolve only the declared resource boundary; readers below it must still refuse symlink traversal. */
async function canonicalArtifactPath(given: string): Promise<string> {
	try {
		return await fs.realpath(given);
	} catch (err) {
		const reason = describeFsError(given, err).slice(given.length + 2);
		fail(`${given}: cannot resolve canonical path (${reason})`);
	}
}

/** Git receipts name the checkout root, never an implicit enclosing repository or a symlink alias. */
async function identityGitRepo(root: string): Promise<VcsGitRepo> {
	await safeArtifactParents(root);
	const st = await fs.lstat(root).catch(err => fail(describeFsError(root, err)));
	if (st.isSymbolicLink() || !st.isDirectory() || (await fs.realpath(root)) !== root)
		fail(`${root}: repository root must be a real directory`);
	const repo = vcs.git(root);
	if (!repo || path.resolve(repo.info().repoRoot) !== root) fail(`${root}: not an exact Git checkout root`);
	return repo;
}

/** Compare only the immutable commit's named blob OIDs/modes with stable current file bytes. */
async function checkGitNamedPaths(
	repo: VcsGitRepo,
	root: string,
	commit: string,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<RequirementIdentityCheck> {
	const seen: Array<{
		abs: string;
		identity?: Identity;
		mode?: number;
		parents: Array<{ path: string; dev: number; ino: number }>;
	}> = [];
	const rootBefore = await fs.lstat(root);
	let bytes = 0;
	let stale: RequirementIdentityCheck | undefined;
	for (const relative of paths) {
		signal?.throwIfAborted();
		const abs = path.join(root, relative);
		const expected = await repo.treeEntry(commit, relative, signal);
		if (!expected)
			return {
				state: "unverifiable",
				kind: "git",
				location: abs,
				expected: commit,
				reason: `${relative}: absent from expected commit ${commit}`,
			};
		if (expected.mode !== 0o100644 && expected.mode !== 0o100755)
			return {
				state: "unverifiable",
				kind: "git",
				location: abs,
				expected: expected.oid,
				reason: `${relative}: expected entry is not a regular blob (mode ${expected.mode.toString(8)})`,
			};
		if (expected.oid.length !== commit.length || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expected.oid))
			fail(`${relative}: invalid native blob OID`);
		const chunks: Uint8Array[] = [];
		let started = false;
		try {
			const parents = await safeArtifactParents(abs);
			const st = await readStableArtifactFile(
				abs,
				chunk => {
					chunks.push(new Uint8Array(chunk));
				},
				signal,
				opened => {
					started = true;
					bytes += opened.size;
					if (bytes > REQUIREMENT_ARTIFACT_LIMITS.maxBytes) fail("Git path set exceeds aggregate byte bound");
				},
			);
			const current = await repo.worktreeBlobEntry(relative, Buffer.concat(chunks), signal);
			const { oid, mode } = current;
			seen.push({ abs, identity: identityOf(st), mode: st.mode, parents });
			if (!stale && (oid !== expected.oid.toLowerCase() || mode !== expected.mode)) {
				stale = {
					state: "stale",
					kind: "git",
					location: abs,
					expected: mode === expected.mode ? expected.oid : `${expected.oid} mode=${expected.mode.toString(8)}`,
					observed: mode === expected.mode ? oid : `${oid} mode=${mode.toString(8)}`,
				};
			}
		} catch (err) {
			if (!(err instanceof ArtifactMissingError) || started) throw err;
			// A path missing before the read is a real content change, not an unreadable probe.
			seen.push({ abs, parents: [] });
			stale ??= { state: "stale", kind: "git", location: abs, expected: expected.oid, observed: "(missing)" };
		}
	}
	for (const file of seen) {
		signal?.throwIfAborted();
		const current = await fs.lstat(file.abs).catch(err => {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return undefined;
			return fail(describeFsError(file.abs, err));
		});
		if (file.identity) {
			if (
				!current ||
				!current.isFile() ||
				!sameIdentity(file.identity, identityOf(current)) ||
				current.mode !== file.mode ||
				JSON.stringify(file.parents) !== JSON.stringify(await safeArtifactParents(file.abs))
			)
				fail(`${file.abs}: changed during Git identity probe`);
		} else if (current) fail(`${file.abs}: changed during Git identity probe`);
	}
	const rootAfter = await fs.lstat(root);
	if (
		!rootAfter.isDirectory() ||
		rootAfter.isSymbolicLink() ||
		rootBefore.dev !== rootAfter.dev ||
		rootBefore.ino !== rootAfter.ino
	)
		fail(`${root}: checkout root changed during identity probe`);
	return stale ?? { state: "fresh" };
}

export async function checkRequirementIdentity(
	identity: RequirementIdentity,
	signal?: AbortSignal,
): Promise<RequirementIdentityCheck> {
	const location =
		identity.kind === "git" ? identity.repo : identity.kind === "file" ? identity.path : identity.target;
	const expected =
		identity.kind === "git" ? identity.commit : identity.kind === "file" ? identity.sha256 : identity.value;
	try {
		signal?.throwIfAborted();
		const parsed = parseRequirementIdentity(formatRequirementIdentity(identity));
		if ("error" in parsed) fail(parsed.error);
		identity = parsed.identity;
		if (identity.kind === "deploy") {
			const observed = await probeRequirementDeployment(identity, signal);
			signal?.throwIfAborted();
			if ("error" in observed) fail(observed.error);
			return observed.value === identity.value
				? { state: "fresh" }
				: { state: "stale", kind: "deploy", location, expected: identity.value, observed: observed.value };
		}
		if (identity.kind === "file") {
			// Legacy real-path receipts implicitly bind canonical location to their given path.
			const expectedCanonical = identity.canonicalPath ?? identity.path;
			const canonical = await canonicalArtifactPath(identity.path);
			if (canonical !== expectedCanonical)
				return { state: "stale", kind: "file", location, expected: expectedCanonical, observed: canonical };
			const artifact = await resolveResourceArtifact([identity.path], signal);
			if (artifact.dirty) fail(artifact.reason);
			if (artifact.canonicalPaths[0] !== expectedCanonical)
				return {
					state: "stale",
					kind: "file",
					location,
					expected: expectedCanonical,
					observed: artifact.canonicalPaths[0]!,
				};
			return artifact.sha256 === identity.sha256
				? { state: "fresh" }
				: { state: "stale", kind: "file", location, expected: identity.sha256, observed: artifact.sha256 };
		}
		const repo = await identityGitRepo(identity.repo);
		if (identity.paths) return await checkGitNamedPaths(repo, identity.repo, identity.commit, identity.paths, signal);
		// Unscoped legacy-compatible Git identity is deliberately conservative.
		const resolved = await repo.resolveRef(`${identity.commit}^{commit}`, signal);
		if (resolved?.toLowerCase() !== identity.commit)
			fail(`${identity.commit}: expected commit is unavailable or not a commit`);
		const head = await repo.headSha(signal);
		if (!head) fail(`${identity.repo}: checkout has no HEAD commit`);
		// Untracked files are not committed content: HEAD fully identifies the tree. Only
		// staged/unstaged changes to tracked files make the committed identity unprovable.
		const statusBefore = await currentRequirementGitStatus(repo, signal);
		const [headAfter, statusAfter] = await Promise.all([
			repo.headSha(signal),
			currentRequirementGitStatus(repo, signal),
		]);
		if (headAfter !== head) fail(`${identity.repo}: HEAD changed during identity probe`);
		if (statusAfter !== statusBefore) fail(`${identity.repo}: checkout changed during identity probe`);
		if (head.toLowerCase() !== identity.commit)
			return { state: "stale", kind: "git", location, expected: identity.commit, observed: head };
		const trackedChanges = trackedRequirementChangePaths(statusBefore);
		if (trackedChanges.length)
			fail(
				`${identity.repo}: checkout HEAD ${head} has uncommitted changes to tracked files (${trackedChanges
					.slice(0, 5)
					.join(
						", ",
					)}${trackedChanges.length > 5 ? `, +${trackedChanges.length - 5} more` : ""}); exact named paths are required to verify audited content`,
			);
		return { state: "fresh" };
	} catch (err) {
		if (signal?.aborted) throw err;
		return {
			state: "unverifiable",
			kind: identity.kind,
			location,
			expected,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Real HEAD and tracked-file dirt of a checkout root, for diagnostics that must not invent `head=unknown, dirty=false`. */
export async function describeGitCheckoutState(
	root: string,
	signal?: AbortSignal,
): Promise<{ head: string | null; dirty: boolean } | undefined> {
	try {
		const repo = await identityGitRepo(root);
		const head = (await repo.headSha(signal)) ?? null;
		const status = await currentRequirementGitStatus(repo, signal);
		return { head, dirty: status.length > 0 };
	} catch {
		return undefined;
	}
}

export async function currentRequirementIdentity(
	target: RequirementIdentityTarget,
	signal?: AbortSignal,
): Promise<{ identity: RequirementIdentity } | { error: string }> {
	try {
		signal?.throwIfAborted();
		if (target.kind === "deploy" && target.scope && target.value === undefined)
			fail("service deployment identity requires a declared version value");
		const candidate: RequirementIdentity =
			target.kind === "git"
				? { ...target, commit: "0".repeat(40) }
				: target.kind === "file"
					? { ...target, sha256: "0".repeat(64) }
					: { ...target, value: target.value ?? "probe" };
		const parsed = parseRequirementIdentity(formatRequirementIdentity(candidate));
		if ("error" in parsed) fail(parsed.error);
		// Parse creates a private path array so callers cannot widen scope across awaits.
		target = parsed.identity;
		if (target.kind === "deploy") {
			const deployment: RequirementDeploymentIdentity = { ...target, value: target.value ?? "probe" };
			const observed = await probeRequirementDeployment(deployment, signal);
			signal?.throwIfAborted();
			if ("error" in observed) fail(observed.error);
			const identity: RequirementIdentity = { ...deployment, value: observed.value };
			const roundTrip = parseRequirementIdentity(formatRequirementIdentity(identity));
			if ("error" in roundTrip) fail(`observed deployment value cannot be represented: ${roundTrip.error}`);
			return roundTrip;
		}
		if (target.kind === "file") {
			const artifact = await resolveResourceArtifact([target.path], signal);
			if (artifact.dirty) fail(artifact.reason);
			const canonicalPath = artifact.canonicalPaths[0]!;
			return {
				identity: {
					kind: "file",
					path: target.path,
					sha256: artifact.sha256,
					...(canonicalPath === target.path ? {} : { canonicalPath }),
				},
			};
		}
		const repo = await identityGitRepo(target.repo);
		const head = await repo.headSha(signal);
		if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head))
			fail(`${target.repo}: checkout has no full HEAD commit`);
		const identity: RequirementIdentity = {
			kind: "git",
			repo: target.repo,
			commit: head.toLowerCase(),
			...(target.paths ? { paths: [...target.paths] } : {}),
		};
		const check = target.paths
			? await checkGitNamedPaths(repo, target.repo, identity.commit, target.paths, signal)
			: await checkRequirementIdentity(identity, signal);
		if (check.state !== "fresh")
			fail(
				check.state === "unverifiable"
					? check.reason
					: `${check.location}: expected ${check.expected}, observed ${check.observed}; current bytes are not represented by HEAD`,
			);
		// Named scopes remain named if HEAD moved during the probe. The captured
		// immutable commit still names precisely the verified current blobs.
		return { identity };
	} catch (err) {
		if (signal?.aborted) throw err;
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
