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

export function checkoutKeyFromResources(resources: unknown, fallbackCwd: string) {
	if (Array.isArray(resources))
		for (const resource of resources)
			if (typeof resource === "string") {
				const key = normalizeCheckoutKey(resource);
				if (key) return key;
			}
	return normalizeCheckoutKey(fallbackCwd)!;
}

export function checkoutScopesFromResources(resources: unknown): string[] | undefined {
	if (!Array.isArray(resources) || resources.length === 0) return undefined;
	const scopes = new Set<string>();
	for (const resource of resources) {
		if (typeof resource !== "string") return undefined;
		const value = resource.trim().replace(/^(?:path|repo|repository|checkout|worktree):/, "");
		const key = normalizeCheckoutKey(value.replace(/:[^/]+$/, ""));
		if (!key?.startsWith("path:")) return undefined;
		let target = path.resolve(displayCheckoutKey(key));
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

export function checkoutScopesOverlap(left: string[], right: string[]): boolean {
	for (const leftScope of left) {
		const [leftRoot, leftPath] = leftScope.split("\0");
		for (const rightScope of right) {
			const [rightRoot, rightPath] = rightScope.split("\0");
			if (leftRoot !== rightRoot || leftPath === undefined || rightPath === undefined) continue;
			if (
				leftPath === "." ||
				rightPath === "." ||
				leftPath === rightPath ||
				leftPath.startsWith(`${rightPath}${path.sep}`) ||
				rightPath.startsWith(`${leftPath}${path.sep}`)
			)
				return true;
		}
	}
	return false;
}
