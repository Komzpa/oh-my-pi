import { expect, test } from "bun:test";

import { AsyncJobManager } from "../src/async/job-manager";

test("owner pending work can include foreground-backed jobs before auto-background promotion", async () => {
	const gate = Promise.withResolvers<string>();
	const manager = new AsyncJobManager({ onJobComplete: () => {} });

	const jobId = manager.register("bash", "git commit --no-edit", async () => gate.promise, {
		id: "bg_1",
		ownerId: "worker",
		foreground: true,
	});

	expect(manager.getRunningJobs({ ownerId: "worker" }).map(job => job.id)).toEqual([]);
	expect(manager.getRunningJobs({ ownerId: "worker" }, { includeForeground: true }).map(job => job.id)).toEqual([
		"bg_1",
	]);

	gate.resolve("commit finished");
	await manager.getJob(jobId)?.promise;
});
