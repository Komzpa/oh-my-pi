import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import { probeRequirementDeployment } from "../src/utils/requirement-deployment";
const oldTrusted = process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
afterEach(() => {
	if (oldTrusted === undefined) delete process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
	else process.env.OMP_TRUSTED_DEPLOYMENT_URLS = oldTrusted;
});
describe("deployment probe target authorization", () => {
	it("compares a running service value without revealing a mismatched secret", async () => {
		const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "omp-deploy-policy-"));
		const spawn = ptree.spawn;
		const systemctl = spyOn(ptree, "spawn").mockImplementation((args, options) =>
			spawn([path.join(fixture, "systemctl"), ...args.slice(1)], options),
		);
		const secret = "fixture-secret-never-export";
		const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			env: { ...process.env, REQ_VERSION: secret },
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			await fs.writeFile(
				path.join(fixture, "systemctl"),
				`#!/bin/sh
printf 'ActiveState=active\nMainPID=${child.pid}\nInvocationID=fixture-invocation\n'
`,
				{ mode: 0o755 },
			);

			const identity = {
				kind: "deploy" as const,
				target: "fixture.service",
				value: "declared-v1",
				scope: "user" as const,
				env: "REQ_VERSION",
			};
			const mismatch = await probeRequirementDeployment(identity);
			expect(mismatch).toHaveProperty("error");
			expect(JSON.stringify(mismatch)).not.toContain(secret);
			expect(await probeRequirementDeployment({ ...identity, value: secret })).toEqual({ value: secret });
		} finally {
			systemctl.mockRestore();
			child.kill();
			await child.exited;
			await fs.rm(fixture, { recursive: true, force: true });
		}
	});
	it("makes no request to an untrusted endpoint and allows the exact operator-declared URL", async () => {
		let hits = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				hits++;
				return Response.json({ version: "v5" });
			},
		});
		try {
			const target = `http://127.0.0.1:${server.port}/release`;
			delete process.env.OMP_TRUSTED_DEPLOYMENT_URLS;
			const identity = { kind: "deploy" as const, target, value: "v5", field: "version" };
			expect(await probeRequirementDeployment(identity)).toHaveProperty("error");
			expect(hits).toBe(0);
			process.env.OMP_TRUSTED_DEPLOYMENT_URLS = JSON.stringify([target]);
			expect(await probeRequirementDeployment(identity)).toEqual({ value: "v5" });
			expect(hits).toBe(1);
			expect(await probeRequirementDeployment({ ...identity, target: target + "/other" })).toHaveProperty("error");
			expect(hits).toBe(1);
		} finally {
			server.stop(true);
		}
	});
});
