import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getBaseConfigRoot, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../session/session-manager";
import type { LiveRestartSubagent } from "./restart-recovery";

export interface RestartIsolation {
	id: string;
	name: string;
	row?: string;
	cwd: string;
	marker: string;
	snapshotPath?: string;
	captureDeadlineAt?: number;
	captureError?: string;
}

export async function restartIsolation(
	child: Pick<LiveRestartSubagent, "id" | "displayName" | "sessionFile">,
): Promise<RestartIsolation | undefined> {
	if (!child.sessionFile) return undefined;
	const peek = await SessionManager.peekSessionInit(child.sessionFile);
	if (!peek?.init?.isolated) return undefined;
	return {
		id: child.id,
		name: child.displayName,
		row: restartRow(peek.init),
		cwd: peek.cwd,
		marker: path.join(path.dirname(child.sessionFile), `${child.id}.restart-isolation.json`),
	};
}

/** The todo row a worker serves: the structured `row` when the runtime recorded one, else the packet's `Row:` line. */
function restartRow(init: { task?: string }): string | undefined {
	const recorded = (init as { row?: unknown }).row;
	if (typeof recorded === "string" && recorded.trim()) return recorded;
	const line = init.task?.split("\n").find(entry => /^Row:\s*\S/.test(entry));
	return line?.replace(/^Row:\s*/, "").trim() ?? init.task?.split("\n", 1)[0];
}

/** A missing upstream is unsafe: a fresh isolated repository commonly has none. */
export async function isolationHasWork(cwd: string): Promise<boolean> {
	const repo = vcs.requireGit(cwd);
	if (await repo.isDirty()) return true;
	const upstream = await repo.resolveRef("@{upstream}");
	if (!upstream) return true;
	return (await repo.revListRange(upstream, "HEAD")).length > 0;
}

export async function preserveRestartIsolation(item: RestartIsolation): Promise<void> {
	const pending = `${item.marker}.${crypto.randomUUID()}.pending`;
	try {
		await Bun.write(pending, JSON.stringify(item));
		await fs.rename(pending, item.marker);
	} finally {
		await fs.rm(pending, { force: true });
	}
}

/** Copy-on-write where supported; byte copies elsewhere. Never share mutable inodes. */
async function copySnapshotPath(source: string, destination: string): Promise<void> {
	await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
}

/** Materialize alternates too: a recovery must survive deletion of the source repository. */
async function copySnapshotObjects(source: string, destination: string, seen = new Set<string>()): Promise<void> {
	const canonical = await fs.realpath(source);
	if (seen.has(canonical)) return;
	seen.add(canonical);
	let alternates: string[] = [];
	try {
		alternates = (await Bun.file(path.join(source, "info/alternates")).text()).split("\n").filter(Boolean);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	for (const alternate of alternates) {
		await copySnapshotObjects(path.resolve(source, alternate), destination, seen);
	}
	await fs.cp(source, destination, {
		recursive: true,
		verbatimSymlinks: true,
		mode: fs.constants.COPYFILE_FICLONE,
		filter: file => file !== path.join(source, "info/alternates"),
	});
}

/** Capture dirty bytes and Git history without asking the worker to commit or push. */
export async function snapshotRestartIsolation(item: RestartIsolation, destination?: string): Promise<void> {
	const dir = destination ?? path.join(getBaseConfigRoot(), "recovery", "isolated-workers");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const snapshot = path.join(dir, crypto.randomUUID());
	await fs.mkdir(snapshot, { mode: 0o700 });
	try {
		const repo = vcs.requireGit(item.cwd);
		const info = repo.info();
		// Walk the filesystem, not Git's visible paths: ignored worker output is work too.
		const names: { name: string; symlink: boolean; file: boolean }[] = [];
		const directories = [""];
		for (let index = 0; index < directories.length; index++) {
			const directory = directories[index];
			for (const entry of await fs.readdir(path.join(item.cwd, directory), { withFileTypes: true })) {
				if (!directory && entry.name === ".git") continue;
				const name = path.join(directory, entry.name);
				if (entry.isDirectory()) directories.push(name);
				else names.push({ name, symlink: entry.isSymbolicLink(), file: entry.isFile() });
			}
		}
		await Promise.all(directories.map(directory => fs.mkdir(path.join(snapshot, directory), { recursive: true })));
		let next = 0;
		const copied = await Promise.allSettled(
			Array.from({ length: Math.min(32, names.length) }, async () => {
				while (next < names.length) {
					const entry = names[next++];
					const name = entry.name;
					try {
						const source = path.join(item.cwd, name);
						const target = path.join(snapshot, name);
						if (entry.symlink) await fs.symlink(await fs.readlink(source), target);
						else if (entry.file) await fs.copyFile(source, target, fs.constants.COPYFILE_FICLONE);
						else await copySnapshotPath(source, target);
					} catch (error) {
						// Deleted tracked files must stay deleted.
						if (!isEnoent(error)) throw error;
					}
				}
			}),
		);
		const failure = copied.find(result => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		const git = path.join(snapshot, ".git");
		await fs.cp(info.commonDir, git, {
			recursive: true,
			verbatimSymlinks: true,
			mode: fs.constants.COPYFILE_FICLONE,
			filter: file => !["objects", "worktrees"].some(name => file === path.join(info.commonDir, name)),
		});
		if (info.gitDir !== info.commonDir) {
			await fs.cp(info.gitDir, git, {
				recursive: true,
				verbatimSymlinks: true,
				mode: fs.constants.COPYFILE_FICLONE,
				filter: file => !["commondir", "gitdir"].some(name => file === path.join(info.gitDir, name)),
			});
		}
		await copySnapshotObjects(path.join(info.commonDir, "objects"), path.join(git, "objects"));
		item.snapshotPath = snapshot;
		await preserveRestartIsolation(item);
		logger.warn("Isolated worker restart snapshot saved", { ...item });
	} catch (error) {
		await fs.rm(snapshot, { recursive: true, force: true });
		throw error;
	}
}

/** Recover a missing worktree. An existing worktree remains authoritative. */
export async function restoreRestartIsolation(item: RestartIsolation): Promise<void> {
	while (item.captureDeadlineAt !== undefined) {
		if (Date.now() >= item.captureDeadlineAt) throw new Error(`Restart snapshot deadline expired for ${item.id}`);
		await Bun.sleep(Math.min(10, Math.max(1, item.captureDeadlineAt - Date.now())));
		const updated = (await Bun.file(item.marker).json()) as RestartIsolation;
		if (updated.id !== item.id || updated.cwd !== item.cwd)
			throw new Error(`Restart snapshot identity changed for ${item.id}`);
		Object.assign(item, { captureDeadlineAt: undefined }, updated);
	}
	if (item.captureError) throw new Error(item.captureError);
	try {
		await fs.lstat(item.cwd);
		return;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (!item.snapshotPath) throw new Error(`No restart isolation snapshot for ${item.id}`);
	if (!(await fs.stat(item.snapshotPath)).isDirectory())
		throw new Error(`Legacy archive requires manual recovery: ${item.snapshotPath}`);
	const pending = `${item.cwd}.${crypto.randomUUID()}.recovery`;
	try {
		await copySnapshotPath(item.snapshotPath, pending);
		await fs.rename(pending, item.cwd);
	} finally {
		await fs.rm(pending, { recursive: true, force: true });
	}
}

export async function readRestartIsolation(sessionFile: string, id: string): Promise<RestartIsolation | undefined> {
	try {
		return await Bun.file(path.join(path.dirname(sessionFile), `${id}.restart-isolation.json`)).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}
