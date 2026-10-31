import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitIntegrationState } from "./todo_dispatch";

test("Git integration probing yields while Git is slow and retains merge facts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-git-integration-"));
  const previousPath = process.env.PATH;
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "MERGE_HEAD"), "merge\n");
  const executable = join(cwd, "git");
  writeFileSync(executable, `#!${process.execPath}\nawait Bun.sleep(60);\nconst args = process.argv.slice(2).join(" ");\nconst replies = {"rev-parse HEAD":"head", "rev-parse --git-path MERGE_HEAD":".git/MERGE_HEAD", "rev-parse --short MERGE_HEAD":"merge", "diff --name-only --diff-filter=U":"a.txt\\na.txt\\nb.txt", "log --format=%ct @{upstream}..HEAD":"1\\n2"};\nconsole.log(replies[args] ?? "");\n`);
  chmodSync(executable, 0o755);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  try {
    process.env.PATH = `${cwd}:${previousPath ?? ""}`;
    const state = await readGitIntegrationState(cwd, 10_000);
    expect(ticks).toBeGreaterThan(2);
    expect(state?.head).toBe("head");
    expect(state?.mergeHead).toBe("merge");
    expect(state?.unmerged).toBe(2);
    expect(state?.unpushed).toBe(2);
    expect(state?.oldestUnpushedAgeMs).toBe(9_000);
  } finally {
    clearInterval(ticker);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
