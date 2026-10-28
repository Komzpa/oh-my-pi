import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { statusCoordinator } from "../../../natives/native/status-coordinator.js";
import {
	checkRequirementIdentity,
	currentRequirementIdentity,
	currentRequirementGitStatus,
} from "../../src/utils/requirement-artifact";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>): Promise<{ root: string; head: string }> {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-requirement-"));
	roots.push(base);
	const root = path.join(base, "repo");
	// These identities depend only on the fixture's declared files. Cloning
	// the entire OMP checkout makes unrelated source size dominate every case.
	fs.mkdirSync(root);
	execFileSync("git", ["init", "-q", "-b", "main", root]);
	for (const [name, value] of Object.entries(files)) {
		const target = path.join(root, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, value);
	}
	const repo = vcs.requireGit(root);
	await repo.configSet("user.email", "native-test@example.invalid");
	await repo.configSet("user.name", "Native Requirement Fixture");
	await repo.stageFiles(Object.keys(files));
	const head = await repo.commitCreate("native artifact fixture", {});
	return { root, head: typeof head === "string" ? head : (await repo.headSha())! };
}

describe("native Git worktree identity", () => {
	it("checks foreground status without entering the display polling queue", async () => {
		const { root } = await fixture({ "artifact.txt": "before\n" });
		const repo = vcs.requireGit(root);
		const queue = spyOn(statusCoordinator, "request").mockImplementation(() => {
			throw new Error("display polling must not hold a requirement gate");
		});
		try {
			expect(await currentRequirementGitStatus(repo)).toBe("");
			fs.writeFileSync(path.join(root, "artifact.txt"), "after\n");
			expect(await currentRequirementGitStatus(repo)).toContain("artifact.txt");
			expect(queue).not.toHaveBeenCalled();
		} finally {
			queue.mockRestore();
		}
	});

	it("applies eol clean filters before checking named path receipts", async () => {
		const { root } = await fixture({
			".gitattributes": "src/a.ts text eol=crlf\n",
			"src/a.ts": "export const a = 1;\n",
		});
		fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\r\n");
		const current = await currentRequirementIdentity({ kind: "git", repo: root, paths: ["src/a.ts"] });
		expect("identity" in current).toBe(true);
		if ("error" in current) throw new Error(current.error);
		expect(await checkRequirementIdentity(current.identity)).toEqual({ state: "fresh" });
	}, 30_000);

	it("uses the tracked executable mode when core.fileMode disables worktree mode checks", async () => {
		const { root } = await fixture({ "src/run.sh": "#!/bin/sh\necho ready\n" });
		const repo = vcs.requireGit(root);
		const file = path.join(root, "src/run.sh");
		fs.chmodSync(file, 0o755);
		await repo.stageFiles(["src/run.sh"]);
		execFileSync("git", ["-C", root, "update-index", "--chmod=+x", "src/run.sh"]);
		await repo.commitCreate("record executable mode", {});
		const head = await repo.headSha();
		if (!head) throw new Error("fixture commit has no HEAD");
		await repo.configSet("core.fileMode", "false");
		fs.chmodSync(file, 0o644);
		const current = await currentRequirementIdentity({ kind: "git", repo: root, paths: ["src/run.sh"] });
		expect("identity" in current).toBe(true);
		if ("error" in current) throw new Error(current.error);
		expect(await checkRequirementIdentity(current.identity)).toEqual({ state: "fresh" });
	}, 30_000);

	it("rejects a session write while confirming HEAD stayed fixed", async () => {
		const { root, head } = await fixture({ "src/a.ts": "export const a = 1;\n" });
		const repo = vcs.requireGit(root);
		const originalHead = repo.headSha.bind(repo);
		let headReads = 0;
		const headProbe = spyOn(Object.getPrototypeOf(repo), "headSha").mockImplementation(async function (
			this: typeof repo,
			signal: Parameters<typeof repo.headSha>[0],
		) {
			if (++headReads === 2) {
				fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 2;\n");
				vcs.invalidateStatus(root);
			}
			return originalHead(signal);
		});
		try {
			const result = await checkRequirementIdentity({ kind: "git", repo: root, commit: head });
			expect(result.state).toBe("unverifiable");
			if (result.state === "unverifiable") expect(result.reason).toContain("checkout changed during identity probe");
			expect(headReads).toBe(2);
		} finally {
			headProbe.mockRestore();
		}
	}, 30_000);

	it("requires the declared expected version before probing a service deployment", async () => {
		const result = await currentRequirementIdentity({
			kind: "deploy",
			target: "omp-agent.service",
			scope: "system",
			env: "BUILD_ID",
		});
		expect("error" in result).toBe(true);
		if ("error" in result) expect(result.error).toContain("requires a declared version value");
	});
});
