import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export function normalizeCheckoutKey(value: string) {
	const trimmed = value
		.trim()
		.replace(/[),.;:'"`]+$/g, "")
		.replace(/\/+$/g, "");
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
		let candidate = displayCheckoutKey(key);
		try {
			while (true) {
				try {
					fs.lstatSync(candidate);
					break;
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
					const parent = path.dirname(candidate);
					if (parent === candidate) return undefined;
					candidate = parent;
				}
			}
			candidate = fs.realpathSync(candidate);
			if (!fs.statSync(candidate).isDirectory()) candidate = path.dirname(candidate);
			const repo = vcs.git(candidate);
			if (!repo) return undefined;
			scopes.add(fs.realpathSync(repo.info().repoRoot));
		} catch {
			return undefined;
		}
	}
	return scopes.size ? [...scopes].sort() : undefined;
}
