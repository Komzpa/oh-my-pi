import { $ } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadNative } from "./loader-state.js";
import { statusCoordinator } from "./status-coordinator.js";

let native;
function api() {
	native ??= loadNative();
	return native;
}
function vcsError(code, message) {
	const error = new Error(message);
	error.name = "VcsError";
	error.code = code;
	error.exitCode = 1;
	error.stdout = "";
	error.stderr = message;
	return error;
}

const wrapped = new WeakMap();
const wrappedTargets = new WeakMap();
const repoIdentities = new Map();
const invalidatingMethods = new Set([
	"applyPatch", "commitCreate", "checkout", "createBranch", "deleteBranch", "checkoutNewBranch",
	"stageFiles", "unstage", "stageHunks", "restore", "reset", "clean", "readTree", "cherryPick",
	"cherryPickAbort", "cherryPickSkip", "stashPush", "stashTryPop", "merge", "mergeAbort", "rebase", "rebaseAbort",
]);

function canonicalPath(file) {
	try {
		return fs.realpathSync.native(file);
	} catch {
		return path.resolve(file);
	}
}

function repoIdentity(repo) {
	const info = repo.info();
	const identity = `${canonicalPath(info.repoRoot)}\0${canonicalPath(info.gitDir)}`;
	repoIdentities.set(identity, info);
	return { identity, info };
}

function statusEntries(output) {
	const tokens = output.split("\0");
	const statuses = [];
	for (let index = 0; index < tokens.length; index++) {
		const entry = tokens[index];
		if (!entry) continue;
		const status = entry.slice(0, 2);
		statuses.push(status);
		if (status.includes("R") || status.includes("C")) index++;
	}
	return statuses;
}

function summarize(output) {
	const entries = statusEntries(output);
	return {
		staged: entries.filter(status => status[0] !== " " && status[0] !== "?").length,
		unstaged: entries.filter(status => status[1] !== " " && status[1] !== "?").length,
		untracked: entries.filter(status => status === "??").length,
	};
}

function wrapGitRepo(repo) {
	if (!repo || (typeof repo !== "object" && typeof repo !== "function")) return repo;
	const known = wrapped.get(repo);
	if (known) return known;
	const { identity, info } = repoIdentity(repo);
	const proxy = new Proxy(repo, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			if (property === "statusPorcelain") {
				return (options, signal) => {
					const snapshot = normalizedStatusOptions(options);
					const meta = statusMetadata(info);
					return statusCoordinator.request(identity, JSON.stringify(snapshot), meta,
						() => Reflect.apply(value, target, [snapshot, undefined]), signal);
				};
			}
			if (property === "statusSummary" || property === "isDirty") {
				return signal => {
					const snapshot = { untracked: "normal", nulTerminated: true, pathspecs: [] };
					const meta = statusMetadata(info);
					return statusCoordinator.request(identity, JSON.stringify(snapshot), meta,
						() => Reflect.apply(target.statusPorcelain, target, [snapshot, undefined]), signal)
						.then(status => property === "isDirty" ? status.length > 0 : summarize(status));
				};
			}
			if (property === "asGit") return (...args) => wrapRepo(Reflect.apply(value, target, args));
			if (invalidatingMethods.has(property)) {
				return (...args) => {
					statusCoordinator.invalidate(identity);
					const result = Reflect.apply(value, target, args);
					if (!result || typeof result.then !== "function") {
						statusCoordinator.invalidate(identity);
						return result;
					}
					return result.finally(() => statusCoordinator.invalidate(identity));
				};
			}
			return value.bind(target);
		},
	});
	wrapped.set(repo, proxy);
	wrappedTargets.set(proxy, repo);
	return proxy;
}

/** Read an exact status snapshot while still honoring the shared status probe queue. */
export function statusPorcelainFresh(repo, options = {}, signal) {
	const target = wrappedTargets.get(repo);
	if (!target) throw new TypeError("statusPorcelainFresh requires a discovered Git repo");
	const { identity, info } = repoIdentity(target);
	const snapshot = normalizedStatusOptions(options);
	const meta = statusMetadata(info);
	return statusCoordinator.request(identity, JSON.stringify(snapshot), meta,
		() => Reflect.apply(target.statusPorcelain, target, [snapshot, undefined]), signal, true);
}

function wrapRepo(repo) {
	if (!repo || (typeof repo !== "object" && typeof repo !== "function")) return repo;
	if (typeof repo.info === "function" && typeof repo.statusPorcelain === "function") return wrapGitRepo(repo);
	if (typeof repo.kind !== "function" || repo.kind() !== "git" || typeof repo.asGit !== "function") return repo;
	const nativeGit = repo.asGit();
	if (!nativeGit) return repo;
	const gitRepo = wrapGitRepo(nativeGit);
	return new Proxy(repo, {
		get(target, property) {
			if (property === "asGit") return () => gitRepo;
			if (property === "statusPorcelain" || property === "statusSummary") return (...args) => gitRepo[property](...args);
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function normalizedStatusOptions(options = {}) {
	return {
		untracked: options.untracked ?? "normal",
		nulTerminated: options.nulTerminated ?? false,
		pathspecs: [...(options.pathspecs ?? [])],
	};
}

function statusMetadata(info) {
	const stat = file => {
		try {
			const item = fs.statSync(file, { bigint: true });
			return [item.dev, item.ino, item.size, item.mtimeNs, item.ctimeNs].join(":");
		} catch (error) {
			return `missing:${error?.code ?? "error"}`;
		}
	};
	let head = "";
	try { head = fs.readFileSync(info.headPath, "utf8"); } catch {}
	const ref = /^ref: (.+)\n?$/.exec(head)?.[1];
	const refPath = ref ? path.resolve(info.commonDir, ref) : "";
	return JSON.stringify([stat(path.join(info.gitDir, "index")), stat(info.headPath), refPath ? stat(refPath) : "", stat(path.join(info.commonDir, "packed-refs")), head]);
}

/** Invalidate cached Git status after a file-writing tool; this never resets the probe rate limit. */
export function invalidateStatus(dir) {
	if (dir === undefined) {
		if (repoIdentities.size === 0) statusCoordinator.invalidate();
		else for (const identity of repoIdentities.keys()) statusCoordinator.invalidate(identity);
		return;
	}
	const target = path.resolve(dir);
	for (const [identity, info] of repoIdentities) {
		for (const root of [info.repoRoot, info.gitDir]) {
			const relative = path.relative(canonicalPath(root), canonicalPath(target));
			if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
				statusCoordinator.invalidate(identity);
				break;
			}
		}
	}
}

/** Snapshot repository identity, status metadata, and explicit invalidation generation. */
export function statusEpoch(repo) {
	const directGitRepo = typeof repo?.info === "function" && typeof repo?.statusPorcelain === "function" ? repo : null;
	const nativeRepo = directGitRepo ?? repo?.asGit?.();
	if (!nativeRepo || typeof nativeRepo.statusPorcelain !== "function") return null;
	const { identity, info } = repoIdentity(nativeRepo);
	return { identity, metadata: statusMetadata(info), generation: statusCoordinator.epoch(identity) };
}

/**
 * True when `error` is a native VCS failure. The native layer constructs these
 * on the JS thread as real `Error` objects with `name: "VcsError"`, a
 * machine-readable `code`, and `exitCode`/`stdout`/`stderr` properties — an
 * `instanceof` check is impossible for foreign-constructed errors, so identity
 * rides on `name`.
 */
export function isVcsError(error) {
	return error instanceof Error && error.name === "VcsError";
}

/** True when a cherry-pick failed because the commit is already applied. */
export function isEmptyCherryPick(error) {
	return isVcsError(error) && error.code === "EmptyCherryPick";
}

/** Discover the git repository containing `dir`; `null` outside any checkout. */
export function git(dir) {
	return wrapRepo(api().vcsGitDiscover(dir));
}
/** Discover the repository owning `dir`; `null` outside any repository. */
export function repo(dir) {
	return wrapRepo(api().vcsDiscover(dir));
}

/** Like {@link repo}, but equal-root jj+git ties prefer Jujutsu for display. Git-safe automation must keep using {@link repo}. */
export function repoForDisplay(dir) {
	return wrapRepo(api().vcsDiscoverForDisplay(dir));
}

/** Like {@link repo}, asserting any requested backend capabilities. */
export function require(dir, ...features) {
	const discovered = repo(dir);
	if (!discovered) throw vcsError("NotARepository", `not a repository: ${dir}`);
	for (const feature of features) {
		if (!discovered.supports(feature)) {
			throw vcsError(
				"Unsupported",
				`\`${feature}\` is not supported on a ${discovered.kind()} repository`,
			);
		}
	}
	return discovered;
}

/** Like {@link git}, but throws a `NotARepository` VcsError. */
export function requireGit(dir) {
	const repo = git(dir);
	if (!repo) {
		throw vcsError("NotARepository", `not a repository: ${dir}`);
	}
	return repo;
}

/** Repository metadata only (cheap fs walk) — for synchronous render paths. */
export function gitInfo(dir) {
	return api().vcsGitRepoInfo(dir);
}

/** Discover the Jujutsu workspace containing `dir`; `null` when absent. */
export function jj(dir) {
	return api().vcsJjDiscover(dir);
}

/** Whether jj is the nearest VCS ancestor, making git automation unsafe. */
export function isPureJj(dir) {
	return api().vcsIsPureJj(dir);
}

/** Clone a repository (git CLI under the hood for credential parity). */
export function clone(url, target, options = {}, signal) {
	return api().vcsGitClone(url, target, options, signal);
}

/** Sever a copied working tree from shared git metadata. */
export function detachGitDir(worktreeRoot, sourceCommonDir, signal) {
	return api().vcsDetachGitDir(worktreeRoot, sourceCommonDir, signal);
}

/**
 * Publish `from` at `to` only once fully written: copy to a sibling temp name,
 * then hard-link it into place (Git's own `finalize_object_file` strategy) so
 * readers never see a partial file and an interrupted copy leaves only a
 * `tmp_` file that `git gc` prunes. An existing `to` was itself published
 * whole and holds the same content-addressed bytes, so it is kept.
 */
async function publishGitObjectFile(from, to) {
	const tmp = path.join(path.dirname(to), `tmp_obj_omp_${crypto.randomUUID()}`);
	try {
		await fs.promises.copyFile(from, tmp, fs.constants.COPYFILE_EXCL);
		try {
			await fs.promises.link(tmp, to);
		} catch (error) {
			if (error?.code === "EEXIST") return;
			// Filesystems without hard links: rename is still atomic, and any
			// file it replaces holds identical content-addressed bytes.
			if (error?.code !== "EPERM" && error?.code !== "ENOTSUP" && error?.code !== "EXDEV") throw error;
			await fs.promises.rename(tmp, to);
		}
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
}

/**
 * Keep objects created in an isolated Git repository reachable after its
 * worktree is removed, without changing the destination's refs or index.
 * Every file is published atomically; a pack is published before its index.
 */
export async function copyGitObjects(isolationRoot, sourceRoot) {
	const from = path.join(requireGit(isolationRoot).info().commonDir, "objects");
	const to = path.join(requireGit(sourceRoot).info().commonDir, "objects");
	for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
		await fs.promises.mkdir(path.join(to, entry.name), { recursive: true });
		for (const name of await fs.promises.readdir(path.join(from, entry.name))) {
			if (!/^[0-9a-f]{38,62}$/.test(name)) continue;
			await publishGitObjectFile(path.join(from, entry.name, name), path.join(to, entry.name, name));
		}
	}
	const packs = (await fs.promises.readdir(path.join(from, "pack"))).filter(name => name.startsWith("pack-"));
	await fs.promises.mkdir(path.join(to, "pack"), { recursive: true });
	// The index must only become visible after the pack it describes.
	for (const name of packs.filter(name => name.endsWith(".pack"))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
	for (const name of packs.filter(name => /\.(?:idx|rev|keep|promisor|mtimes)$/.test(name))) {
		await publishGitObjectFile(path.join(from, "pack", name), path.join(to, "pack", name));
	}
}

/**
 * Run Git's checkout hook in a newly created linked worktree, using the same
 * null old HEAD and branch-switch flag as `git worktree add`.
 */
export async function runPostCheckoutHook(worktreeRoot, head) {
	const nullOid = "0".repeat(head.length);
	const result = await $`git hook run --ignore-missing post-checkout -- ${nullOid} ${head} 1`
		.cwd(worktreeRoot)
		.quiet()
		.nothrow();
	return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** Join patch fragments, preserving each part's trailing newline. */
export function joinPatches(parts) {
	return api().vcsJoinPatches(parts);
}

/** Validate hunk selections against a raw diff. */
export function validateHunkSelections(rawDiff, selections) {
	return api().vcsValidateHunkSelections(rawDiff, selections);
}

/** Stat-poll interval for {@link watch}. */
export const HEAD_WATCH_INTERVAL_MS = 1000;

/**
 * Watch a repository for head changes; returns a disposer.
 *
 * Stat-polls via `fs.watchFile` instead of `fs.watch`: backends may atomically
 * replace the watched entry, permanently silencing inotify-backed watchers.
 */
export function watch(repo, onChange, intervalMs = HEAD_WATCH_INTERVAL_MS) {
	const target = repo.watchTarget();
	const listener = (curr, prev) => {
		if (curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino || curr.size !== prev.size) onChange();
	};
	fs.watchFile(target, { interval: intervalMs }, listener).unref();
	return () => fs.unwatchFile(target, listener);
}
