import * as fs from "node:fs/promises";
import * as path from "node:path";

async function workspacePackages(root: string): Promise<Map<string, string>> {
	let manifest: Record<string, unknown>;
	try {
		const value: unknown = await Bun.file(path.join(root, "package.json")).json();
		if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
		manifest = value as Record<string, unknown>;
	} catch {
		return new Map();
	}
	const raw = manifest.workspaces;
	const patterns: unknown[] = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && !Array.isArray(raw) && "packages" in raw && Array.isArray(raw.packages)
			? raw.packages
			: [];
	const packages = new Map<string, string>();
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
		const glob = new Bun.Glob(path.join(pattern, "package.json"));
		for await (const match of glob.scan({ cwd: root, onlyFiles: true })) {
			const packageRoot = path.dirname(path.join(root, match));
			try {
				const value: unknown = await Bun.file(path.join(packageRoot, "package.json")).json();
				if (!value || typeof value !== "object" || Array.isArray(value)) continue;
				const name = (value as Record<string, unknown>).name;
				if (typeof name === "string") packages.set(name, packageRoot);
			} catch {
				// An unreadable workspace member cannot provide a safe package link.
			}
		}
	}
	return packages;
}

async function linkPath(target: string, destination: string): Promise<void> {
	const stat = await fs.stat(target);
	await fs.symlink(target, destination, stat.isDirectory() ? "dir" : "file");
}

async function linkPackageEntry(
	name: string,
	sourceEntry: string,
	destination: string,
	packages: ReadonlyMap<string, string>,
): Promise<boolean> {
	const workspacePath = packages.get(name);
	if (workspacePath) {
		await linkPath(workspacePath, destination);
		return true;
	}
	await linkPath(sourceEntry, destination);
	return false;
}

/**
 * Rebind workspace package links when an isolated checkout inherited a
 * symlink to another checkout's node_modules. Registry packages remain linked
 * to that external cache; only names declared by the worker checkout's own
 * workspace manifests resolve to its local source.
 */
export async function repairBorrowedWorkspaceNodeModules(workerRoot: string): Promise<void> {
	const nodeModules = path.join(workerRoot, "node_modules");
	try {
		if (!(await fs.lstat(nodeModules)).isSymbolicLink()) return;
	} catch {
		return;
	}

	let borrowedRoot: string;
	try {
		borrowedRoot = await fs.realpath(nodeModules);
	} catch {
		return;
	}
	const relativeTarget = path.relative(path.resolve(workerRoot), borrowedRoot);
	if (
		relativeTarget === "" ||
		(relativeTarget !== ".." && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget))
	) {
		return;
	}

	const packages = await workspacePackages(workerRoot);
	if (packages.size === 0) return;
	const entries = await fs.readdir(borrowedRoot, { withFileTypes: true });
	let hasWorkspaceEntry = false;
	for (const entry of entries) {
		if (entry.name === ".bin") continue;
		const sourceEntry = path.join(borrowedRoot, entry.name);
		const stat = await fs.stat(sourceEntry).catch(() => undefined);
		if (entry.name.startsWith("@") && stat?.isDirectory()) {
			for (const member of await fs.readdir(sourceEntry)) {
				if (packages.has(`${entry.name}/${member}`)) hasWorkspaceEntry = true;
			}
		} else if (packages.has(entry.name)) {
			hasWorkspaceEntry = true;
		}
	}
	if (!hasWorkspaceEntry) return;

	const stagingRoot = await fs.mkdtemp(path.join(workerRoot, ".omp-node_modules-"));
	try {
		for (const entry of entries) {
			const sourceEntry = path.join(borrowedRoot, entry.name);
			const destination = path.join(stagingRoot, entry.name);
			if (entry.name === ".bin") {
				await linkPath(sourceEntry, destination);
				continue;
			}
			const stat = await fs.stat(sourceEntry).catch(() => undefined);
			if (entry.name.startsWith("@") && stat?.isDirectory()) {
				await fs.mkdir(destination);
				for (const member of await fs.readdir(sourceEntry)) {
					await linkPackageEntry(
						`${entry.name}/${member}`,
						path.join(sourceEntry, member),
						path.join(destination, member),
						packages,
					);
				}
				continue;
			}
			await linkPackageEntry(entry.name, sourceEntry, destination, packages);
		}
		await fs.rm(nodeModules);
		await fs.rename(stagingRoot, nodeModules);
	} catch (error) {
		await fs.rm(stagingRoot, { recursive: true, force: true });
		throw error;
	}
}
