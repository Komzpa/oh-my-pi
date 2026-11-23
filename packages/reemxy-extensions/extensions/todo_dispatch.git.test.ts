import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitIntegrationState } from "./todo_dispatch";

test("Git integration probing yields while Git is slow and retains merge facts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-git-integration-"));
  const previousPath = process.env.PATH;
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "MERGE_HEAD"), "merge\n");
  const executable = join(cwd, "git");
  writeFileSync(executable, `#!${process.execPath}\nawait Bun.sleep(60);\nconst args = process.argv.slice(2).join(" ");\nconst replies = {"rev-parse HEAD":"head", "rev-parse --git-path MERGE_HEAD":".git/MERGE_HEAD", "rev-parse --short MERGE_HEAD":"merge", "diff --name-only --diff-filter=U":"a.txt\\na.txt\\nb.txt", "symbolic-ref --quiet --short HEAD":"main", "ls-remote --heads origin refs/heads/main":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\trefs/heads/main", "cat-file --batch-check=%(objectname) %(objecttype)":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa commit", "log --format=%ct head --not aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":"1\\n2"};\nconsole.log(replies[args] ?? "");\n`);
  chmodSync(executable, 0o755);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  try {
    const state = await readGitIntegrationState(cwd, 10_000, { ...process.env, PATH: `${cwd}:${previousPath ?? ""}` });
    expect(ticks).toBeGreaterThan(2);
    expect(state?.head).toBe("head");
    expect(state?.mergeHead).toBe("merge");
    expect(state?.unmerged).toBe(2);
    expect(state?.pushRemote).toBe("origin");
    expect(state?.pushBranch).toBe("main");
    expect(state?.unpushed).toBe(2);
    expect(state?.oldestUnpushedAgeMs).toBe(9_000);
  } finally {
    clearInterval(ticker);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a non-repository has no Git integration state", async () => {
  const cwd = mkdtempSync(join("/tmp", "omp-no-git-"));
  try {
    expect(await readGitIntegrationState(cwd, Date.now())).toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("publication checks the configured remote, not an unrelated remote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-git-target-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
  try {
    git(dir, "init", "--bare", "origin.git");
    git(dir, "init", "--bare", "other.git");
    git(dir, "clone", join(dir, "origin.git"), "work");
    const work = join(dir, "work");
    git(work, "remote", "add", "other", join(dir, "other.git"));
    writeFileSync(join(work, "file"), "base");
    git(work, "add", "file");
    git(work, "commit", "-m", "base");
    git(work, "push", "-u", "origin", "HEAD");
    git(work, "push", "other", "HEAD");
    writeFileSync(join(work, "file"), "changed");
    git(work, "commit", "-am", "next");
    git(work, "push", "other", "HEAD");
    const pending = await readGitIntegrationState(work, Date.now(), env);
    expect(pending?.pushRemote).toBe("origin");
    expect(pending?.unpushed).toBe(1);
    git(work, "push", "origin", "HEAD");
    git(work, "remote", "set-url", "other", join(dir, "missing.git"));
    expect((await readGitIntegrationState(work, Date.now(), env))?.unpushed).toBe(0);
    git(work, "remote", "set-url", "origin", join(dir, "missing.git"));
    expect((await readGitIntegrationState(work, Date.now(), env))?.unpushed).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
