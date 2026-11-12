import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { RESTART_SNAPSHOT_WORKER_ARG } from "../cli/worker-selectors";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { preserveRestartIsolation, snapshotRestartIsolation, type RestartIsolation } from "./restart-isolation";

const JOB_ENV = "OMP_RESTART_SNAPSHOT_JOB";

export interface RestartSnapshotCapture {
	stop(): Promise<void>;
}

interface SnapshotJob {
	items: RestartIsolation[];
	requestId: string;
	deadlineAt: number;
	destination: string;
}

/** A separate process owns the copies: exec must not discard pending filesystem callbacks. */
export async function launchRestartSnapshots(
	items: RestartIsolation[],
	requestId: string,
	deadlineAt: number,
): Promise<RestartSnapshotCapture | undefined> {
	if (!items.length) return undefined;
	const destination = path.join(path.dirname(items[0].marker), ".restart-snapshots");
	const jobFile = path.join(destination, `${crypto.randomUUID()}.json`);
	for (const item of items) {
		item.captureDeadlineAt = deadlineAt;
		delete item.captureError;
		delete item.snapshotPath;
	}
	await Promise.all(items.map(preserveRestartIsolation));
	await Bun.write(jobFile, JSON.stringify({ items, requestId, deadlineAt, destination } satisfies SnapshotJob));
	const spawn = resolveWorkerSpawnCmd(RESTART_SNAPSHOT_WORKER_ARG);
	const child = Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({ [JOB_ENV]: jobFile }),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	child.unref();
	// Return after launch, not capture. The successor waits on each worker's own marker.
	return {
		stop: async () => {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		},
	};
}

export async function runRestartSnapshotWorker(): Promise<void> {
	const file = process.env[JOB_ENV];
	if (!file) throw new Error("Restart snapshot worker has no job");
	const job = (await Bun.file(file).json()) as SnapshotJob;
	logger.setTransports({ file: path.join(job.destination, "logs"), console: false });
	const startedAt = performance.now();
	await Promise.all(
		job.items.map(async item => {
			const start = performance.now();
			try {
				if (Date.now() >= job.deadlineAt) throw new Error("Restart snapshot deadline expired before capture");
				delete item.captureDeadlineAt;
				await snapshotRestartIsolation(item, job.destination);
			} catch (error) {
				delete item.captureDeadlineAt;
				item.captureError = String(error);
				await preserveRestartIsolation(item);
			} finally {
				logger.info("Restart isolation capture finished", {
					requestId: job.requestId,
					workerId: item.id,
					stage: "snapshot_isolation_capture",
					durationMs: performance.now() - start,
					deadlineAt: job.deadlineAt,
					remainingReserveMs: job.deadlineAt - Date.now(),
					outcome: item.captureError ? "failed" : "settled",
				});
			}
		}),
	);
	logger.info("Restart isolation batch captured", {
		requestId: job.requestId,
		durationMs: performance.now() - startedAt,
	});
	await fs.rm(file, { force: true });
	logger.flush();
}

/** Runs the actual worker entry graph, including compiled-binary re-entry, without a repository. */
export async function smokeTestRestartSnapshotWorker(): Promise<void> {
	const temp = TempDir.createSync("@omp-restart-snapshot-smoke-");
	try {
		const file = path.join(temp.path(), "job.json");
		await Bun.write(
			file,
			JSON.stringify({
				items: [],
				requestId: "smoke",
				deadlineAt: Date.now() + 30_000,
				destination: temp.path(),
			} satisfies SnapshotJob),
		);
		const spawn = resolveWorkerSpawnCmd(RESTART_SNAPSHOT_WORKER_ARG);
		const child = Bun.spawn(spawn.cmd, {
			cwd: spawn.cwd,
			env: workerEnvFromParent({ [JOB_ENV]: file }),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const timer = setTimeout(() => child.kill(), 30_000);
		try {
			if ((await child.exited) !== 0)
				throw new Error(`Restart snapshot worker failed: ${await new Response(child.stderr).text()}`);
			if (await Bun.file(file).exists()) throw new Error("Restart snapshot worker did not finish its job");
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await temp.remove();
	}
}
