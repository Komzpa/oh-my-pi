/**
 * Isolated component benchmark, not an interactive restart acceptance test.
 * Run: bun packages/coding-agent/bench/restart-pipeline.ts
 * Keeps fixtures, raw samples and report in the printed temporary directory.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, setAgentDir } from "@oh-my-pi/pi-utils";
import { CURRENT_SESSION_VERSION } from "../src/session/session-entries";
import { SessionManager } from "../src/session/session-manager";
import {
	restoreRestartIsolation,
	snapshotRestartIsolation,
	type RestartIsolation,
} from "../src/task/restart-isolation";

const RUNS = 10;
const ENTRIES = 200_000;
const TRANSCRIPTS = 1_000;
const WORKER_FILES = 256;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restart-pipeline-"));
setAgentDir(path.join(root, "agent"));
logger.setTransports({ file: path.join(root, "runtime.log"), console: false });
const samples: Record<string, number[]> = {};
const timestamp = "2026-11-06T00:00:00.000Z";
const raw = path.join(root, "samples.jsonl");

async function measured<T>(stage: string, run: number, action: () => Promise<T>): Promise<T> {
	const start = performance.now();
	const value = await action();
	const durationMs = performance.now() - start;
	(samples[stage] ??= []).push(durationMs);
	await fs.appendFile(raw, `${JSON.stringify({ stage, run, durationMs })}\n`);
	return value;
}

function check(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function journal(): Promise<string> {
	const file = path.join(root, "sessions", "large.jsonl");
	await fs.mkdir(path.dirname(file), { recursive: true });
	const writer = Bun.file(file).writer();
	writer.write(
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "benchmark", timestamp, cwd: root })}\n`,
	);
	const padding = "history payload ".repeat(175);
	for (let index = 0; index < ENTRIES; index++) {
		const base = { id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp };
		const row =
			index === ENTRIES - 5
				? { ...base, type: "reset_boundary" }
				: index > ENTRIES - 5
					? { ...base, type: "message", message: { role: "user", content: `active-${index}`, timestamp: index } }
					: { ...base, type: "custom", customType: "benchmark-history", data: padding };
		writer.write(`${JSON.stringify(row)}\n`);
		if (index % 1_000 === 0) await writer.flush();
	}
	await writer.end();
	await Promise.all(
		Array.from({ length: TRANSCRIPTS }, (_, index) =>
			Bun.write(
				path.join(root, "sessions", "large", `child-${index}.jsonl`),
				`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: `child-${index}`, timestamp, cwd: root })}\n`,
			),
		),
	);
	check((await fs.stat(file)).size >= 500 * 1024 * 1024, "journal must exceed 500 MiB");
	return file;
}

async function worker(index: number): Promise<RestartIsolation> {
	const cwd = path.join(root, `worker-${index}`);
	// Minimal local Git repository; fixture construction never invokes a remote.
	await fs.mkdir(path.join(cwd, ".git", "objects"), { recursive: true });
	await fs.mkdir(path.join(cwd, ".git", "refs", "heads"), { recursive: true });
	await Bun.write(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/worker\n");
	await Bun.write(
		path.join(cwd, ".git", "config"),
		"[core]\n\trepositoryformatversion = 0\n\tbare = false\n[user]\n\tname = Restart benchmark\n\temail = benchmark@example.invalid\n[commit]\n\tgpgsign = false\n",
	);
	const repo = vcs.requireGit(cwd);
	await Promise.all(
		Array.from({ length: WORKER_FILES }, (_, number) =>
			Bun.write(path.join(cwd, `file-${number}`), `${number}\n${"fixture".repeat(1170)}`),
		),
	);
	await Bun.write(path.join(cwd, "tracked"), "baseline");
	await Bun.write(path.join(cwd, "deleted"), "deleted later");
	await repo.stageFiles(["."]);
	const baseline = await repo.commitCreate("benchmark baseline", {});
	// A local remote-tracking ref establishes exactly one unpublished commit.
	await Bun.write(path.join(cwd, ".git", "refs", "remotes", "origin", "published"), `${baseline}\n`);
	await repo.configSet("remote.origin.url", path.join(root, "nonexistent-local-remote"));
	await repo.configSet("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
	await repo.configSet("branch.worker.remote", "origin");
	await repo.configSet("branch.worker.merge", "refs/heads/published");
	await Bun.write(path.join(cwd, "tracked"), "unpublished commit");
	await repo.stageFiles(["tracked"]);
	await repo.commitCreate("benchmark unpublished", {});
	await Bun.write(path.join(cwd, "tracked"), "staged bytes");
	await repo.stageFiles(["tracked"]);
	await Bun.write(path.join(cwd, "tracked"), "dirty bytes\0\n");
	await Bun.write(path.join(cwd, "untracked"), crypto.getRandomValues(new Uint8Array(65536)));
	await fs.rm(path.join(cwd, "deleted"));
	await fs.symlink("tracked", path.join(cwd, "link"));
	const ready = vcs.requireGit(cwd);
	const upstream = await ready.resolveRef("@{upstream}");
	check(
		!!upstream && (await ready.revListRange(upstream, "HEAD")).length === 1,
		"fixture must have one unpushed commit",
	);
	check(await ready.isDirty(), "fixture must be dirty");
	return {
		id: `worker-${index}`,
		name: `Worker ${index}`,
		cwd,
		marker: path.join(root, "markers", `worker-${index}.json`),
	};
}

async function fingerprint(cwd: string): Promise<string> {
	const repo = vcs.requireGit(cwd);
	const names = [...new Set([...(await repo.lsFiles(false, false)), ...(await repo.lsFiles(true, true))])].sort();
	const rows = await Promise.all(
		names.map(async name => {
			const target = path.join(cwd, name);
			try {
				const stat = await fs.lstat(target);
				return [
					name,
					stat.mode & 0o777,
					stat.isSymbolicLink()
						? await fs.readlink(target)
						: new Bun.CryptoHasher("sha256").update(await Bun.file(target).arrayBuffer()).digest("hex"),
				];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, "deleted"];
				throw error;
			}
		}),
	);
	return JSON.stringify({
		rows,
		head: await repo.headSha(),
		status: await repo.statusPorcelain({ untracked: "all" }),
		committed: (await repo.showBlob("HEAD:tracked")).data.toString("hex"),
		staged: (await repo.showBlob(":tracked")).data.toString("hex"),
	});
}

/** cc94a8e8401 tar payload algorithm; benchmark-local marker replaces its production marker. */
async function legacyTar(item: RestartIsolation, destination: string): Promise<void> {
	const repo = vcs.requireGit(item.cwd);
	const names = new Set([...(await repo.lsFiles(false, false)), ...(await repo.lsFiles(true, true))]);
	const present: string[] = [];
	for (const name of names) {
		try {
			await fs.lstat(path.join(item.cwd, name));
			present.push(name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const list = `${destination}.files`;
	try {
		await Bun.write(list, present.map(name => `${name}\0`).join(""));
		await $`tar -czf ${destination} -C ${item.cwd} --null -T ${list}`.quiet();
		await fs.chmod(destination, 0o600);
		const archive = await fs.open(destination, "r");
		try {
			await archive.sync();
		} finally {
			await archive.close();
		}
		await Bun.write(`${destination}.marker`, JSON.stringify({ ...item, snapshotPath: destination }));
	} finally {
		await fs.rm(list, { force: true });
	}
}

function percentile(values: number[], fraction: number): number {
	return [...values].sort((left, right) => left - right)[Math.ceil(values.length * fraction) - 1]!;
}

console.log(JSON.stringify({ event: "fixtures-start", root }));
const file = await journal();
const workers = await Promise.all(Array.from({ length: 4 }, (_, index) => worker(index)));
const expected = await Promise.all(workers.map(item => fingerprint(item.cwd)));
console.log(
	JSON.stringify({
		event: "fixtures-ready",
		journalBytes: (await fs.stat(file)).size,
		entries: ENTRIES,
		transcripts: TRANSCRIPTS,
		workers: workers.length,
	}),
);
if (process.env.OMP_RESTART_FIXTURE_ONLY) process.exit(0);
for (let run = 0; run < RUNS; run++) {
	await measured("bun_exec_floor", run, async () => {
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "inherit" });
		check((await child.exited) === 0, "exec floor child failed");
	});
	await fs.rm(`${file}.index-handoff`, { force: true });
	const original = await measured("journal_open_without_handoff", run, () =>
		SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true }),
	);
	await measured("journal_write_index_handoff", run, async () =>
		check(await original.writeIndexHandoff(), "handoff rejected"),
	);
	await original.close();
	const restored = await measured("journal_open_with_handoff", run, () =>
		SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true }),
	);
	await measured("journal_active_context", run, async () => {
		check(restored.getEntryCount() === ENTRIES, "entry count lost");
		check(restored.getLeafId() === `entry-${ENTRIES - 1}`, "leaf lost");
		check(restored.buildSessionContext().messages.length === 4, "active context lost");
	});
	check(restored.getEntry("entry-0")?.type === "custom", "lazy historical entry lost");
	await restored.close();
	await measured("four_worker_legacy_tar_gzip", run, () =>
		Promise.all(workers.map((item, index) => legacyTar(item, path.join(root, `legacy-${run}-${index}.tar.gz`)))),
	);
	await measured("four_worker_snapshot", run, () =>
		Promise.all(workers.map(item => snapshotRestartIsolation(item, path.join(root, "snapshots")))),
	);
	const held = workers.map(item => `${item.cwd}.held`);
	await Promise.all(workers.map((item, index) => fs.rename(item.cwd, held[index]!)));
	await measured("four_worker_restore_missing_repos", run, () =>
		Promise.all(workers.map(item => restoreRestartIsolation(item))),
	);
	for (let index = 0; index < workers.length; index++) {
		const item = workers[index]!;
		check((await fingerprint(item.cwd)) === expected[index], `worker ${index} bytes/index/history lost`);
		await fs.rm(held[index]!, { recursive: true });
	}
	console.log(JSON.stringify({ event: "run-complete", run }));
}
// A changed dirty file must fail the same recovery oracle used above.
await Bun.write(path.join(workers[0]!.cwd, "tracked"), "negative control corruption");
check((await fingerprint(workers[0]!.cwd)) !== expected[0], "recovery oracle missed corruption");
const baselinePath = path.resolve(import.meta.dir, "../../../../restart-stages-lag5.jsonl");
const baseline: unknown[] = [];
if (await Bun.file(baselinePath).exists()) {
	for (const row of Bun.JSONL.parse(await Bun.file(baselinePath).text()) as Array<{
		stage?: string;
		durationMs?: number;
	}>) {
		if (typeof row.durationMs === "number") baseline.push({ stage: row.stage, durationMs: row.durationMs });
	}
}
const report = {
	root,
	asOf: new Date().toISOString(),
	baselineSource: "cc94a8e8401",
	baselineScope:
		"Legacy tar payload algorithm only; journal before/after uses candidate SessionManager with sidecar removed/present, not two source checkouts. Historical stage log is one live request, not a comparable synthetic percentile sample.",
	baselinePath,
	baseline,
	fixture: {
		journalBytes: (await fs.stat(file)).size,
		entries: ENTRIES,
		transcripts: TRANSCRIPTS,
		workers: 4,
		filesPerWorker: WORKER_FILES + 4,
		unpushedCommitsPerWorker: 1,
	},
	measurement:
		"Warm filesystem component timings, milliseconds; 10 measured runs; nearest-rank percentiles. Fixture generation and verification excluded. No cache dropping. Four-worker stages are concurrent wall time.",
	execFloorScope:
		"Minimal Bun subprocess spawn+exit; not the installed OMP executable and not an exec replacement measurement.",
	stages: Object.fromEntries(
		Object.entries(samples).map(([stage, values]) => [
			stage,
			{ n: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samplesMs: values },
		]),
	),
	recovery:
		"40/40 snapshots restored after original repository rename; working bytes, symlinks, deleted files, mode, porcelain status, HEAD commit blob and staged index blob matched. Dirty-byte corruption negative control detected.",
	unproven: [
		"Restart controller no-clean-wait, deadlines and post-frame orchestration on this large fixture (component APIs exercised directly)",
		"Actual exec replacement and input-ready interactive first frame <=100ms above exec floor",
		"Actual worker runtime/input readiness <=100ms after interactive first frame",
		"1000 transcript discovery/rendering cost (fixtures present but SessionManager.open only opens the root journal)",
		"Legacy archive recovery of unpublished Git history (baseline omits .git)",
	],
};
await Bun.write(path.join(root, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
