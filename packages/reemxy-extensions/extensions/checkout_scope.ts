import { isReadOnlyWorkerRole } from "@oh-my-pi/pi-coding-agent/task/read-only-policy";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export function normalizeCheckoutKey(value: string) {
	const trimmed = value.trim().replace(/[),.;:'"`]+$/g, "").replace(/\/+$/g, "");
	if (!trimmed) return null;
	return trimmed.startsWith("/") ? `path:${trimmed}` : `name:${trimmed}`;
}

export function displayCheckoutKey(key: string) {
	return key.replace(/^(path|name):/, "");
}

function checkoutResourceValue(resource: string) {
	return resource.trim().replace(/^(?:path|repo|repository|checkout|worktree):/, "");
}

export function checkoutKeyFromResources(resources: unknown, fallbackCwd: string) {
	if (Array.isArray(resources))
		for (const resource of resources)
			if (typeof resource === "string") {
				const key = normalizeCheckoutKey(checkoutResourceValue(resource));
				if (key) return key;
			}
	return normalizeCheckoutKey(fallbackCwd)!;
}

export function checkoutScopesFromResources(resources: unknown): string[] | undefined {
	if (!Array.isArray(resources) || resources.length === 0) return undefined;
	const keys: string[] = [];
	for (const resource of resources) {
		if (typeof resource !== "string") return undefined;
		const value = checkoutResourceValue(resource);
		const key = normalizeCheckoutKey(value.replace(/:[^/]+$/, ""));
		if (!key) return undefined;
		keys.push(key);
	}
	// A relative file path (src/x.ts) beside exactly one absolute worktree lives
	// in that worktree. Without this, the row fell back to the session cwd and
	// every sibling-worktree writer collided on the shared checkout. A bare word
	// stays ambiguous: it may name another repository.
	const absolute = keys.filter(key => key.startsWith("path:"));
	const scopes = new Set<string>();
	for (const key of keys) {
		let resolved = key;
		if (!key.startsWith("path:")) {
			const relative = displayCheckoutKey(key);
			if (absolute.length !== 1 || !relative.includes("/") || path.isAbsolute(relative)) return undefined;
			resolved = `path:${path.join(displayCheckoutKey(absolute[0]!), relative)}`;
		}
		let target = path.resolve(displayCheckoutKey(resolved));
		try {
			let existing = target;
			const suffix: string[] = [];
			while (true) {
				try {
					fs.lstatSync(existing);
					break;
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
					const parent = path.dirname(existing);
					if (parent === existing) return undefined;
					suffix.unshift(path.basename(existing));
					existing = parent;
				}
			}
		target = path.join(fs.realpathSync(existing), ...suffix);
		const repo = vcs.git(target);
		if (!repo) {
			scopes.add(`${target}\0.`);
			continue;
		}
		const root = fs.realpathSync(repo.info().repoRoot);
		const relativeTarget = path.relative(root, target);
		if (relativeTarget === ".." || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
			scopes.add(`${target}\0.`);
			continue;
		}
		scopes.add(`${root}\0${relativeTarget || "."}`);
		} catch {
			return undefined;
		}
	}
	return scopes.size ? [...scopes].sort() : undefined;
}

export function checkoutScopesContain(roots: string[], targets: string[]): boolean {
	return targets.every(target =>
		roots.some(root => {
			const [rootRepo, rootPath] = root.split("\0");
			const [targetRepo, targetPath] = target.split("\0");
			if (!rootRepo || rootPath === undefined || !targetRepo || targetPath === undefined) return false;
			const allowed = path.resolve(rootRepo, rootPath);
			const resolved = path.resolve(targetRepo, targetPath);
			return resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`);
		}),
	);
}

export function checkoutScopesOverlap(left: string[], right: string[]): boolean {
	return left.some(l => right.some(r => checkoutScopesContain([l], [r]) || checkoutScopesContain([r], [l])));
}

export function readOnlyRow(row: { schedule?: { readOnly?: boolean; agentProfile?: string } }): boolean {
	return row.schedule?.readOnly === true || isReadOnlyWorkerRole(row.schedule?.agentProfile ?? "");
}

export function readOnlyClaim(row: { schedule?: { readOnly?: boolean; owner?: string; ownerReadOnly?: { owner: string; readOnly: boolean }; agentProfile?: string } }): boolean {
	return (row.schedule?.ownerReadOnly?.owner === row.schedule?.owner && row.schedule?.ownerReadOnly?.readOnly === true) || readOnlyRow(row);
}
