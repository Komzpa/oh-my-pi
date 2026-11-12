import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";

/** Detect tracked checkout changes, including edits to already-dirty files. No rollback: other writers may own them. */
export async function createReadOnlyGuard(cwd: string): Promise<(() => Promise<string | undefined>) | undefined> {
	const repo = vcs.git(cwd);
	if (!repo) return undefined;
	const fingerprint = async () => {
		const [head, status, staged, unstaged] = await Promise.all([
			repo.headSha(),
			repo.statusPorcelain({ untracked: "no" }),
			repo.diffText({ cached: true, binary: true }),
			repo.diffText({ binary: true }),
		]);
		return Bun.hash(JSON.stringify([head, status, staged, unstaged]));
	};
	const before = await fingerprint();
	return async () => {
		try {
			if ((await fingerprint()) === before) return undefined;
			return `Read-only worker failed: tracked checkout changed at ${shortenPath(cwd)}; inspect git diff/status before retrying (concurrent writers also count).`;
		} catch {
			return `Read-only worker failed: cannot verify tracked checkout at ${shortenPath(cwd)}; inspect git status before retrying.`;
		}
	};
}
