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
  writeFileSync(executable, `#!${process.execPath}\nawait Bun.sleep(60);\nconst args = process.argv.slice(2).join(" ");\nconst replies = {"rev-parse HEAD":"head", "rev-parse --git-path MERGE_HEAD":".git/MERGE_HEAD", "rev-parse --short MERGE_HEAD":"merge", "diff --name-only --diff-filter=U":"a.txt\\na.txt\\nb.txt", "remote":"origin", "log --format=%ct head --not":"1\\n2"};\nconsole.log(replies[args] ?? "");\n`);
  chmodSync(executable, 0o755);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  try {
    const state = await readGitIntegrationState(cwd, 10_000, { ...process.env, PATH: `${cwd}:${previousPath ?? ""}` });
    expect(ticks).toBeGreaterThan(2);
    expect(state?.head).toBe("head");
    expect(state?.mergeHead).toBe("merge");
    expect(state?.unmerged).toBe(2);
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

test("remote publication probes run concurrently and an unreachable remote remains unknown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "omp-git-remotes-"));
  const executable = join(cwd, "git");
  writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "ls-remote") {
  const name = args[2];
  await Bun.write(name, "started");
  const other = name === "one" ? "two" : "one";
  const deadline = Date.now() + 1500;
  while (!(await Bun.file(other).exists()) && Date.now() < deadline) await Bun.sleep(10);
  if (!(await Bun.file(other).exists()) || process.env.FAIL_REMOTE === name) process.exit(1);
  console.log("a".repeat(40) + "\\trefs/heads/main");
} else if (args[0] === "remote") console.log("one\\ntwo");
else if (args[0] === "cat-file") console.log("a".repeat(40) + " commit");
else if (args[0] === "log") console.log("1");
else if (args.join(" ") === "rev-parse HEAD") console.log("head");
`);
  chmodSync(executable, 0o755);
  const env = { ...process.env, PATH: `${cwd}:${process.env.PATH ?? ""}` };
  try {
    const state = await readGitIntegrationState(cwd, 10_000, env);
    expect(state?.unpushed).toBe(1);
    const unknown = await readGitIntegrationState(cwd, 10_000, { ...env, FAIL_REMOTE: "two" });
    expect(unknown?.unpushed).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
