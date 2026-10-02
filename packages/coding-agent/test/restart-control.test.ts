import * as net from "node:net";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	listRestartControls,
	publishRestartControl,
	RESTART_CONTROL_PROTOCOL_VERSION,
	sendRestartControl,
	type RestartControlSource,
} from "../src/restart-control";
import type { RestartControlIdentity, RestartControlSnapshot } from "../src/task/restart-queue";

const tempDirs: string[] = [];
const publications: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
	for (const publication of publications.splice(0).reverse()) await publication.dispose();
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setupDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "restart-control-test-"));
	tempDirs.push(dir);
	return dir;
}

function fixture(identity: RestartControlIdentity): { source: RestartControlSource; requests: string[] } {
	const requests: string[] = [];
	const source: RestartControlSource = {
		snapshot: () => ({ identity, pid: process.pid, cwd: "/workspace", request: null }),
		async handle(request) {
			requests.push(request.op);
			return { identity, pid: process.pid, cwd: "/workspace", request: null } satisfies RestartControlSnapshot;
		},
	};
	return { source, requests };
}

describe("restart-control local IPC", () => {
	it("routes valid cancellation only to its endpoint and rejects a neighboring stale generation", async () => {
		const runtimeDir = await setupDir();
		const firstIdentity: RestartControlIdentity = {
			instanceId: "instance-one-1234",
			sessionId: "session-one",
			generation: 7,
		};
		const neighborIdentity: RestartControlIdentity = {
			instanceId: "instance-two-1234",
			sessionId: "session-two",
			generation: 9,
		};
		const first = fixture(firstIdentity);
		const neighbor = fixture(neighborIdentity);
		publications.push(await publishRestartControl(first.source, { runtimeDir }));
		publications.push(await publishRestartControl(neighbor.source, { runtimeDir }));

		const listed = await listRestartControls({ runtimeDir });
		expect(listed.map(item => item.identity.instanceId).sort()).toEqual(["instance-one-1234", "instance-two-1234"]);

		await expect(
			sendRestartControl(
				{ identity: { ...neighborIdentity, generation: 10 }, op: "cancel", requestId: "request-neighbor" },
				{ runtimeDir },
			),
		).rejects.toMatchObject({ name: "RestartControlError", code: "stale_identity" });
		expect(first.requests).toEqual([]);
		expect(neighbor.requests).toEqual([]);

		const cancelled = await sendRestartControl(
			{ identity: firstIdentity, op: "cancel", requestId: "request-1" },
			{ runtimeDir },
		);
		expect(cancelled.identity).toEqual(firstIdentity);
		expect(first.requests).toEqual(["cancel"]);
		expect(neighbor.requests).toEqual([]);
	});

	it("does not fall back to another endpoint when the exact instance metadata is missing", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-live-1234",
			sessionId: "session-live",
			generation: 2,
		};
		const live = fixture(identity);
		publications.push(await publishRestartControl(live.source, { runtimeDir }));

		await expect(
			sendRestartControl(
				{
					identity: { instanceId: "instance-missing-1234", sessionId: "session-live", generation: 2 },
					op: "status",
				},
				{ runtimeDir },
			),
		).rejects.toMatchObject({ name: "RestartControlError", code: "target_not_found" });
		expect(live.requests).toEqual([]);
	});

	it("reports a generation change rather than dispatching against a stale identity", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-stale-1234",
			sessionId: "session-stale",
			generation: 3,
		};
		const current: RestartControlIdentity = { ...identity, generation: 4 };
		const live = fixture(current);
		publications.push(await publishRestartControl(live.source, { runtimeDir }));

		await expect(sendRestartControl({ identity, op: "request" }, { runtimeDir })).rejects.toMatchObject({
			name: "RestartControlError",
			code: "stale_identity",
		});
		expect(live.requests).toEqual([]);
	});

	it("returns a bounded handler rejection reason to the control caller", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-reason-1234",
			sessionId: "session-reason",
			generation: 5,
		};
		const reason = "Restart blocked: checkpoint already started";
		const source: RestartControlSource = {
			snapshot: () => ({ identity, pid: process.pid, cwd: "/workspace", request: null }),
			async handle() {
				throw new Error(reason);
			},
		};
		publications.push(await publishRestartControl(source, { runtimeDir }));

		await expect(
			sendRestartControl({ identity, op: "cancel", requestId: "reason-request" }, { runtimeDir }),
		).rejects.toMatchObject({
			name: "RestartControlError",
			code: "handler_failed",
			message: reason,
		});
	});

	it("consumes one complete frame before async dispatch so later chunks cannot duplicate it", async () => {
		const runtimeDir = await setupDir();
		const identity: RestartControlIdentity = {
			instanceId: "instance-frame-1234",
			sessionId: "session-frame",
			generation: 1,
		};
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let calls = 0;
		const source: RestartControlSource = {
			snapshot: () => ({ identity, pid: process.pid, cwd: "/workspace", request: null }),
			async handle() {
				calls++;
				entered.resolve();
				await resume.promise;
				return { identity, pid: process.pid, cwd: "/workspace", request: null };
			},
		};
		publications.push(await publishRestartControl(source, { runtimeDir }));
		const metadata = JSON.parse(await Bun.file(path.join(runtimeDir, `${identity.instanceId}.json`)).text()) as {
			endpoint: string;
			token: string;
		};
		const socket = net.createConnection({ path: metadata.endpoint });
		const connected = Promise.withResolvers<void>();
		const response = Promise.withResolvers<string>();
		let responseText = "";
		socket.setEncoding("utf8");
		socket.once("connect", connected.resolve);
		socket.on("data", chunk => {
			responseText += chunk;
			if (responseText.includes("\n")) response.resolve(responseText);
		});
		await connected.promise;
		socket.write(
			`${JSON.stringify({
				v: RESTART_CONTROL_PROTOCOL_VERSION,
				token: metadata.token,
				op: "cancel",
				request: { identity, op: "cancel", requestId: "frame-request" },
			})}\n`,
		);
		await entered.promise;
		socket.write("\n");
		// This integration probe needs a real peer event-loop turn to deliver the second frame chunk while handle() is suspended.
		await Bun.sleep(25);
		expect(calls).toBe(1);
		resume.resolve();
		const payload = await response.promise;
		expect(JSON.parse(payload).ok).toBe(true);
		socket.destroy();
	});
});
