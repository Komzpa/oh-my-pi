import { useFastGitStatusCoordinator } from "../helpers/fast-status-coordinator";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createStatusCoordinator, statusCoordinator } from "../../../natives/native/status-coordinator.js";
import {
	checkRequirementIdentity,
	type RequirementGitStatusSnapshots,
	currentRequirementIdentity,
	currentRequirementGitStatus,
	formatRequirementIdentity,
} from "../../src/utils/requirement-artifact";

import { getRequirementRowArtifact } from "../../src/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

useFastGitStatusCoordinator();

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
	it("checks fresh foreground status through the shared status queue", async () => {
		const { root } = await fixture({ "artifact.txt": "before\n" });
		const repo = vcs.requireGit(root);
		const queue = spyOn(statusCoordinator, "request");
		try {
			expect(await currentRequirementGitStatus(repo)).toBe("");
			fs.writeFileSync(path.join(root, "artifact.txt"), "after\n");
			expect(await currentRequirementGitStatus(repo)).toContain("artifact.txt");
			expect(queue).toHaveBeenCalled();
		} finally {
			queue.mockRestore();
		}
	});

	for (const reftable of [false, true]) {
		it(`ignores group execute permission in ${reftable ? "reftable" : "ordinary"} Git path identities`, async () => {
			if (process.platform === "win32") return;
			const { root, head } = await fixture({ "script.sh": "echo ready\n" });
			if (reftable) execFileSync("git", ["-C", root, "refs", "migrate", "--ref-format=reftable"]);
			fs.chmodSync(path.join(root, "script.sh"), 0o654);
			expect(
				await checkRequirementIdentity({ kind: "git", repo: root, commit: head, paths: ["script.sh"] }),
			).toEqual({ state: "fresh" });
			fs.chmodSync(path.join(root, "script.sh"), 0o754);
			expect(
				(await checkRequirementIdentity({ kind: "git", repo: root, commit: head, paths: ["script.sh"] })).state,
			).not.toBe("fresh");
		}, 30_000);
	}

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

	it("authenticates reftable named paths including clean filters and tracked executable modes", async () => {
		const { root } = await fixture({
			".gitattributes": "src/run.sh text eol=crlf\n",
			"src/run.sh": "#!/bin/sh\necho ready\n",
		});
		execFileSync("git", ["-C", root, "update-index", "--chmod=+x", "src/run.sh"]);
		execFileSync("git", ["-C", root, "commit", "-qm", "record executable"]);
		execFileSync("git", ["-C", root, "refs", "migrate", "--ref-format=reftable"]);
		execFileSync("git", ["-C", root, "config", "core.fileMode", "false"]);
		fs.chmodSync(path.join(root, "src/run.sh"), 0o644);
		fs.writeFileSync(path.join(root, "src/run.sh"), "#!/bin/sh\r\necho ready\r\n");
		const current = await currentRequirementIdentity({ kind: "git", repo: root, paths: ["src/run.sh"] });
		if ("error" in current) throw new Error(current.error);
		expect(await checkRequirementIdentity(current.identity)).toEqual({ state: "fresh" });
		fs.writeFileSync(path.join(root, "src/run.sh"), "#!/bin/sh\necho changed\n");
		vcs.invalidateStatus(root);
		expect((await checkRequirementIdentity(current.identity)).state).not.toBe("fresh");
	}, 30_000);

	it("refreshes external worktree edits at each gate while sharing one scan across its rows", async () => {
		const { root, head } = await fixture({ "artifact.txt": "audited\n" });
		let clock = 0;
		const coordinator = createStatusCoordinator({
			now: () => clock,
			setTimer: (callback, delay) =>
				setTimeout(() => {
					clock += delay ?? 0;
					callback();
				}, 0),
		});
		let scans = 0;
		const queue = spyOn(statusCoordinator, "request").mockImplementation((key, snapshot, meta, run, signal, fresh) =>
			coordinator.request(
				key,
				snapshot,
				meta,
				() => {
					scans++;
					return run();
				},
				signal,
				fresh,
			),
		);
		try {
			// Prime the production display cache, then start a separate foreground gate.
			await vcs.requireGit(root).statusPorcelain({ untracked: "no", nulTerminated: true });
			const phases: TodoPhase[] = [
				{
					name: "Plan",
					tasks: [0, 1].map(row => ({
						content: `row ${row}`,
						status: "pending",
						schedule: { resources: [root] },
					})),
				},
			];
			const receipt = (row: string): string =>
				`row ${JSON.stringify(row)} @ ${formatRequirementIdentity({ kind: "git", repo: root, commit: head })}`;
			const gate: RequirementGitStatusSnapshots = new Map();
			for (const task of phases[0]!.tasks) {
				const artifact = await getRequirementRowArtifact(
					{ cwd: root, receipt: receipt(task.content), gitStatusSnapshots: gate },
					task.content,
					phases,
				);
				expect(artifact.dirty).toBe(false);
				expect(artifact.identityCheck?.reason).toBeUndefined();
			}
			const scansAfterFirstGate = scans;
			// External editors do not invalidate the native coordinator's epoch.
			fs.writeFileSync(path.join(root, "artifact.txt"), "external edit\n");
			const nextGate: RequirementGitStatusSnapshots = new Map();
			const changed = await getRequirementRowArtifact(
				{ cwd: root, receipt: receipt("row 0"), gitStatusSnapshots: nextGate },
				"row 0",
				phases,
			);
			expect(changed.dirty).toBe(true);
			expect(changed.identityCheck?.reason).toContain("artifact.txt");
			expect(scansAfterFirstGate).toBe(2);
			expect(scans).toBe(3);
		} finally {
			queue.mockRestore();
		}
	});

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
