import type { PathLike } from "node:fs";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	checkRequirementIdentity,
	checkRequirementDeliveredIdentity,
	currentRequirementIdentity,
	formatRequirementIdentity,
	freezeRequirementIdentityScope,
	parseRequirementIdentity,
	requirementArtifactBase,
	resolveResourceArtifact,
	type RequirementIdentity,
} from "../src/utils/requirement-artifact";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "req-artifact-")));
	roots.push(root);
	return root;
}

async function capture(file: string): Promise<RequirementIdentity> {
	const result = await currentRequirementIdentity({ kind: "file", path: file });
	if ("error" in result) throw new Error(result.error);
	return result.identity;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("frozen Git requirement artifact scope", () => {
	it("captures complete unscoped coverage before a default-branch move", async () => {
		const root = await fixture();
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.name", "Requirement Artifact Test");
		git(root, "config", "user.email", "requirements@example.invalid");
		await Bun.write(path.join(root, "base.txt"), "base\n");
		git(root, "add", ".");
		git(root, "commit", "-qm", "base");
		const base = git(root, "rev-parse", "HEAD");
		git(root, "update-ref", "refs/remotes/origin/main", base);
		git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		git(root, "switch", "-qc", "feature");
		for (const file of ["first.txt", "second.txt"]) {
			await Bun.write(path.join(root, file), `${file}\n`);
			git(root, "add", file);
			git(root, "commit", "-qm", file);
		}

		const result = await currentRequirementIdentity({ kind: "git", repo: root });
		if ("error" in result) throw new Error(result.error);
		const identity = result.identity;
		if (identity.kind !== "git") throw new Error("Git target resolved to another identity kind");
		expect(identity).toMatchObject({ kind: "git", base, paths: ["first.txt", "second.txt"] });
		expect((await requirementArtifactBase(identity)).base).toBe(base);
		expect(await checkRequirementDeliveredIdentity(identity)).toEqual({ state: "fresh" });
		git(root, "update-ref", "refs/remotes/origin/main", identity.commit);
		git(root, "update-ref", "refs/heads/main", identity.commit);
		expect((await requirementArtifactBase(identity)).base).toBe(base);
		await Bun.write(path.join(root, "first.txt"), "regressed\n");
		git(root, "add", "first.txt");
		git(root, "commit", "-qm", "regress audited file");
		expect(await checkRequirementDeliveredIdentity(identity)).toMatchObject({ state: "stale" });
	});

	it("retains the captured base and paths when default branch advances onto the audited merge", async () => {
		const root = await fixture();
		git(root, "init", "--initial-branch=main");
		git(root, "config", "user.name", "Requirement Artifact Test");
		git(root, "config", "user.email", "requirements@example.invalid");
		await Bun.write(path.join(root, "a.txt"), "base a\n");
		await Bun.write(path.join(root, "b.txt"), "base b\n");
		git(root, "add", ".");
		git(root, "commit", "-m", "base");
		const baseCommit = git(root, "rev-parse", "HEAD");

		git(root, "switch", "-c", "first-parent");
		await Bun.write(path.join(root, "a.txt"), "first parent a\n");
		git(root, "add", "a.txt");
		git(root, "commit", "-m", "first parent");
		const firstParent = git(root, "rev-parse", "HEAD");

		git(root, "switch", "--detach", baseCommit);
		await Bun.write(path.join(root, "b.txt"), "second parent b\n");
		git(root, "add", "b.txt");
		git(root, "commit", "-m", "second parent");
		const secondParent = git(root, "rev-parse", "HEAD");
		const mergeTree = git(root, "rev-parse", `${firstParent}^{tree}`);
		const auditedMerge = git(
			root,
			"-c",
			"user.name=Requirement Artifact Test",
			"-c",
			"user.email=requirements@example.invalid",
			"commit-tree",
			mergeTree,
			"-p",
			firstParent,
			"-p",
			secondParent,
			"-m",
			"audited merge",
		);
		git(root, "update-ref", "refs/heads/main", secondParent);
		const accepted = await freezeRequirementIdentityScope({
			kind: "git",
			repo: root,
			commit: auditedMerge,
			base: secondParent,
			paths: ["a.txt"],
		});
		expect(accepted).toMatchObject({ base: secondParent, paths: ["a.txt"] });

		git(root, "update-ref", "refs/heads/main", auditedMerge);
		const afterDefaultBranchMove = await freezeRequirementIdentityScope(accepted);
		expect(afterDefaultBranchMove).toEqual(accepted);
		expect(afterDefaultBranchMove).toMatchObject({ base: secondParent, paths: ["a.txt"] });
	});
});

describe("symlink requirement artifacts", () => {
	it("round-trips canonical location for a regular file and rejects same-byte symlink replacement", async () => {
		const root = await fixture();
		const file = path.join(root, "audited.txt");
		const other = path.join(root, "other.txt");
		await Bun.write(file, "same audited bytes\n");
		await Bun.write(other, "same audited bytes\n");
		const captured = await capture(file);
		const reparsed = parseRequirementIdentity(formatRequirementIdentity(captured));
		expect(reparsed).toEqual({ identity: captured });
		if ("error" in reparsed) throw new Error(reparsed.error);
		await fs.unlink(file);
		await fs.symlink(other, file);
		expect(await checkRequirementIdentity(reparsed.identity)).toMatchObject({
			state: "stale",
			expected: file,
			observed: other,
		});
	});

	it("captures the given and canonical file paths and persists both in receipts", async () => {
		const root = await fixture();
		const target = path.join(root, "target @;.txt");
		const link = path.join(root, "alias.txt");
		await Bun.write(target, "audited bytes");
		await fs.symlink(target, link);
		const identity = await capture(link);
		expect(identity).toMatchObject({ path: link, canonicalPath: target });
		expect(parseRequirementIdentity(formatRequirementIdentity(identity))).toEqual({ identity });
		expect(await checkRequirementIdentity(identity)).toEqual({ state: "fresh" });
	});

	it("marks a top-level retarget stale even when both targets have identical bytes", async () => {
		const root = await fixture();
		const link = path.join(root, "alias");
		await Bun.write(path.join(root, "first"), "same");
		await Bun.write(path.join(root, "second"), "same");
		await fs.symlink("first", link);
		const identity = await capture(link);
		await fs.unlink(link);
		await fs.symlink("second", link);
		expect(await checkRequirementIdentity(identity)).toMatchObject({
			state: "stale",
			expected: path.join(root, "first"),
			observed: path.join(root, "second"),
		});
	});

	it("detects edits to a top-level link's canonical target", async () => {
		const root = await fixture();
		const target = path.join(root, "target");
		const link = path.join(root, "alias");
		await Bun.write(target, "before");
		await fs.symlink(target, link);
		const identity = await capture(link);
		await Bun.write(target, "after!");
		expect(await checkRequirementIdentity(identity)).toMatchObject({ state: "stale", location: link });
	});

	it("binds a path through a symlinked ancestor and detects its retarget", async () => {
		const root = await fixture();
		await Bun.write(path.join(root, "first", "file"), "same");
		await Bun.write(path.join(root, "second", "file"), "same");
		const link = path.join(root, "parent");
		await fs.symlink("first", link);
		const identity = await capture(path.join(link, "file"));
		expect(identity).toMatchObject({ canonicalPath: path.join(root, "first", "file") });
		await fs.unlink(link);
		await fs.symlink("second", link);
		expect(await checkRequirementIdentity(identity)).toMatchObject({ state: "stale" });
	});

	it("hashes directory symlink entries without reading their targets, including dangling and cyclic links", async () => {
		const root = await fixture();
		const dir = path.join(root, "skill");
		const target = path.join(root, "target");
		await fs.mkdir(dir);
		await Bun.write(target, "before");
		await fs.symlink(target, path.join(dir, "SKILL.md"));
		await fs.symlink("missing", path.join(dir, "dangling"));
		await fs.symlink(".", path.join(dir, "cycle"));
		const identity = await capture(dir);
		await Bun.write(target, "after");
		expect(await checkRequirementIdentity(identity)).toEqual({ state: "fresh" });
		await fs.unlink(path.join(dir, "SKILL.md"));
		await fs.symlink("elsewhere", path.join(dir, "SKILL.md"));
		expect(await checkRequirementIdentity(identity)).toMatchObject({ state: "stale" });
	});

	it("distinguishes a symlink from a regular file containing the same target string", async () => {
		const dir = await fixture();
		const entry = path.join(dir, "entry");
		await fs.symlink("destination", entry);
		const identity = await capture(dir);
		await fs.unlink(entry);
		await Bun.write(entry, "destination");
		expect(await checkRequirementIdentity(identity)).toMatchObject({ state: "stale" });
	});

	it("canonicalizes a top-level directory alias containing a symlink", async () => {
		const root = await fixture();
		const dir = path.join(root, "skill");
		const alias = path.join(root, "alias");
		await Bun.write(path.join(dir, "file"), "content");
		await fs.symlink("missing", path.join(dir, "link"));
		await fs.symlink(dir, alias);
		const identity = await capture(alias);
		expect(identity).toMatchObject({ canonicalPath: dir });
		expect(await checkRequirementIdentity(identity)).toEqual({ state: "fresh" });
	});

	it("names a dangling top-level path and why it cannot be resolved", async () => {
		const root = await fixture();
		const link = path.join(root, "dangling");
		await fs.symlink("missing", link);
		const result = await currentRequirementIdentity({ kind: "file", path: link });
		expect(result).toEqual({ error: `${link}: cannot resolve canonical path (missing)` });
	});

	it("rejects replacement of the canonical file while it is opened", async () => {
		const root = await fixture();
		const file = path.join(root, "file");
		await Bun.write(file, "before");
		const open = fs.open;
		const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
			await fs.rename(file, path.join(root, "old"));
			await Bun.write(file, "after!");
			return open(...args);
		});
		try {
			expect(await resolveResourceArtifact([file])).toMatchObject({
				dirty: true,
				reason: `${file}: changed while opening`,
			});
		} finally {
			spy.mockRestore();
		}
	});

	for (const change of ["resize", "rewrite", "ancestor"] as const) {
		it(`refuses ${change} drift during a canonical file read`, async () => {
			const root = await fixture();
			const parent = path.join(root, "parent");
			const file = path.join(parent, "file");
			await Bun.write(file, "before");
			const open = fs.open;
			const spy = spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args);
				if (change === "ancestor") {
					await fs.rename(parent, path.join(root, "old-parent"));
					await Bun.write(file, "before");
				} else {
					await Bun.write(file, change === "resize" ? "longer content" : "after!");
					// Some filesystems expose only millisecond stat times. Force a distinct tick for the same-size rewrite.
					if (change === "rewrite") await fs.utimes(file, new Date(0), new Date(0));
				}
				return handle;
			});
			try {
				const artifact = await resolveResourceArtifact([file]);
				expect(artifact).toMatchObject({ dirty: true });
				if (!artifact.dirty) throw new Error("unstable bytes were attested");
				expect(artifact.reason).toContain(file);
			} finally {
				spy.mockRestore();
			}
		});
	}

	it("refuses a link retarget during its readlink probe", async () => {
		const root = await fixture();
		const link = path.join(root, "link");
		await fs.symlink("first", link);
		const readlink = fs.readlink;
		const spy = spyOn(fs, "readlink").mockImplementation((async (file: PathLike) => {
			const target = await readlink(file);
			await fs.unlink(link);
			await fs.symlink("second", link);
			return target;
		}) as typeof fs.readlink);
		try {
			expect(await resolveResourceArtifact([root])).toMatchObject({
				dirty: true,
				reason: `${link}: changed while reading symlink`,
			});
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps missing resources and directories without entries unverifiable", async () => {
		const root = await fixture();
		expect(await resolveResourceArtifact([path.join(root, "missing")])).toMatchObject({ dirty: true });
		expect(await resolveResourceArtifact([root])).toMatchObject({
			dirty: true,
			reason: `${root}: directory contains no regular files`,
		});
	});
});
