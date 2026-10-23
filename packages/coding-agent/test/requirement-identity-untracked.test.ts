import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkRequirementIdentity,
	currentRequirementIdentity,
	describeGitCheckoutState,
} from "../src/utils/requirement-artifact";

const dirs: string[] = [];
function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	return r.stdout.toString().trim();
}
function fixture(): { root: string; head: string } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "req-identity-")));
	dirs.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.email", "t@example.com");
	git(root, "config", "user.name", "t");
	fs.writeFileSync(path.join(root, "a.txt"), "audited\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "init");
	return { root, head: git(root, "rev-parse", "HEAD") };
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("git requirement identity vs working-tree dirt", () => {
	it("accepts a whole-checkout identity when only untracked files exist", async () => {
		const { root, head } = fixture();
		fs.writeFileSync(path.join(root, "audit-1.png"), "png");
		fs.writeFileSync(path.join(root, "Checking"), "x");
		expect(await checkRequirementIdentity({ kind: "git", repo: root, commit: head })).toEqual({ state: "fresh" });
		const cur = await currentRequirementIdentity({ kind: "git", repo: root });
		expect(cur).toEqual({ identity: { kind: "git", repo: root, commit: head } });
	});

	it("still refuses a modified tracked file and names head and path", async () => {
		const { root, head } = fixture();
		fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
		const r = await checkRequirementIdentity({ kind: "git", repo: root, commit: head });
		expect(r.state).toBe("unverifiable");
		const reason = r.state === "unverifiable" ? r.reason : "";
		expect(reason).toContain(head);
		expect(reason).toContain("a.txt");
		expect(reason).not.toContain("head=unknown");
	});

	it("still refuses a staged tracked change", async () => {
		const { root, head } = fixture();
		fs.writeFileSync(path.join(root, "a.txt"), "staged\n");
		git(root, "add", "a.txt");
		expect((await checkRequirementIdentity({ kind: "git", repo: root, commit: head })).state).toBe("unverifiable");
	});

	it("refuses an untracked file inside explicitly bound paths", async () => {
		const { root, head } = fixture();
		fs.writeFileSync(path.join(root, "new.png"), "png");
		const r = await checkRequirementIdentity({ kind: "git", repo: root, commit: head, paths: ["new.png"] });
		expect(r.state).not.toBe("fresh");
	});

	it("reports the real head and tracked-dirt state for diagnostics", async () => {
		const { root, head } = fixture();
		fs.writeFileSync(path.join(root, "x.png"), "png");
		expect(await describeGitCheckoutState(root)).toEqual({ head, dirty: false });
		fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
		expect(await describeGitCheckoutState(root)).toEqual({ head, dirty: true });
	});
});
