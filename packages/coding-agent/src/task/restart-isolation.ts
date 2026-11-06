import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
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
}

export async function restartIsolation(child: LiveRestartSubagent): Promise<RestartIsolation | undefined> {
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

/** Called only after all worker writers have quiesced. Failure prevents restart. */
export async function snapshotRestartIsolation(item: RestartIsolation, destination?: string): Promise<void> {
	const dir = destination ?? path.join(getBaseConfigRoot(), "recovery", "isolated-workers");
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${crypto.randomUUID()}.tar.gz`);
	const list = `${file}.files`;
	const repo = vcs.requireGit(item.cwd);
	const paths = new Set([...(await repo.lsFiles(false, false)), ...(await repo.lsFiles(true, true))]);
	const present: string[] = [];
	for (const name of paths) {
		try {
			await fs.lstat(path.join(item.cwd, name));
			present.push(name);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	try {
		await Bun.write(list, present.map(name => `${name}\0`).join(""));
		await $`tar -czf ${file} -C ${item.cwd} --null -T ${list}`.quiet();
		await fs.chmod(file, 0o600);
		const archive = await fs.open(file, "r");
		try {
			await archive.sync();
		} finally {
			await archive.close();
		}
		// Persist the manifest only after the archive has completed successfully.
		item.snapshotPath = file;
		await preserveRestartIsolation(item);
		logger.warn("Isolated worker restart snapshot saved", { ...item });
	} finally {
		await fs.rm(list, { force: true });
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
