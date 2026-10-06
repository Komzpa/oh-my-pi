import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { sessionSliceName } from "@oh-my-pi/pi-natives";
import { getDaemonRuntimeRoot } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { SessionSliceLifecycle, formatHogUserLine, reapOrphanSessionSlices } from "../src/exec/session-slice-lifecycle";
import { toolSessionEnvironment } from "../src/exec/session-slice";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { ISOLATION_OWNER_FILE, writeIsolationOwner } from "../src/task/isolation-ownership";
import cpuNoticeTemplate from "../src/prompts/session/owned-cpu.md" with { type: "text" };
import { prompt } from "@oh-my-pi/pi-utils";

const live = process.platform === "linux" && process.env.OMP_SLICE_LIVE_TEST === "1";
const prefix = `qa-slice-${process.pid}-`;
const managerEnv = { ...process.env, XDG_RUNTIME_DIR: "/run/user/1000" };
// Live CPU proof deliberately uses the platform clock: fake timers cannot advance kernel cpu.stat.

function run(args: string[], env: NodeJS.ProcessEnv = managerEnv): string {
	const child = Bun.spawnSync(args, { env, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`${args.join(" ")}: ${child.stderr.toString()}`);
	return child.stdout.toString().trim();
}

it.skipIf(!live)(
	"AgentSession notices sustained CPU once, disposes its slice, and preserves its kept fixture",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		const sessionId = crypto.randomUUID();
		const slice = sessionSliceName(sessionId);
		const owned = `${prefix}busy.service`;
		const keep = `${prefix}keep.service`;
		const outside = `${prefix}outside.service`;
		const auth = await AuthStorage.create(path.join(root, "auth.db"));
		const manager = SessionManager.inMemory(root);
		const id = spyOn(manager, "getSessionId").mockReturnValue(sessionId);
		const model = createMockModel({ provider: "openai", id: "slice-fixture" }).model;
		let lifecycle: SessionSliceLifecycle | undefined;
		const originalPoll = SessionSliceLifecycle.prototype.poll;
		const poll = spyOn(SessionSliceLifecycle.prototype, "poll").mockImplementation(function (
			this: SessionSliceLifecycle,
			now?: number,
		) {
			if (this.slice === slice) lifecycle = this;
			return originalPoll.call(this, now);
		});
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Fixture"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
			toolRegistry: new Map(),
		});
		const notice = spyOn(session, "sendCustomMessage");
		try {
			const env = await toolSessionEnvironment(
				sessionId,
				managerEnv as Record<string, string>,
				path.join(root, "bin"),
			);
			const shim = path.join(root, "bin", "systemd-run");
			run([shim, "--user", "--collect", `--unit=${owned}`, "/bin/sh", "-c", "while :; do :; done"], env);
			run([shim, "--user", "--collect", `--unit=${keep}`, "--slice=omp-keep.slice", "/bin/sleep", "120"], env);
			run(["systemd-run", "--user", "--collect", `--unit=${outside}`, "--slice=app.slice", "/bin/sleep", "120"]);
			for (let attempt = 0; !lifecycle && attempt < 50; attempt++) await Bun.sleep(100);
			expect(lifecycle).toBeDefined();
			await lifecycle!.ready;
			await lifecycle!.poll();
			const ownedPid = Number(run(["systemctl", "--user", "show", owned, "-p", "MainPID", "--value"]));
			const keepPid = Number(run(["systemctl", "--user", "show", keep, "-p", "MainPID", "--value"]));
			const outsidePid = Number(run(["systemctl", "--user", "show", outside, "-p", "MainPID", "--value"]));
			await Bun.sleep(48_000);
			const notices = notice.mock.calls.filter(
				call => typeof call[0] !== "string" && call[0].customType === "session-owned-cpu",
			);
			expect(notices).toHaveLength(1);
			const payload = notices[0]![0];
			if (typeof payload === "string") throw new Error("CPU notice must use a hidden custom payload");
			expect(payload.display).toBe(false);
			expect(notices[0]![1]?.deliverAs).toBe("nextTurn");
			expect(payload.content).toContain(owned);
			expect(payload.content).toContain(keep);
			expect(session.isStreaming).toBe(false);
			const text = String(payload.content);
			await session.dispose();
			expect(await Bun.file(`/proc/${ownedPid}/stat`).exists()).toBe(false);
			expect(run(["systemctl", "--user", "show", slice, "-p", "ActiveState", "--value"])).toBe("inactive");
			const controlGroup = run(["systemctl", "--user", "show", slice, "-p", "ControlGroup", "--value"]);
			expect(controlGroup).toBe("");
			expect(run(["systemctl", "--user", "show", keep, "-p", "MainPID", "--value"])).toBe(String(keepPid));
			expect(run(["systemctl", "--user", "show", outside, "-p", "MainPID", "--value"])).toBe(String(outsidePid));
			console.log(
				JSON.stringify({
					notice: text,
					noticeBytes: Buffer.byteLength(text),
					notices: notices.length,
					slice,
					ownedPid,
					keepPid,
					outsidePid,
					readbacks: { slice: "inactive", controlGroup, owned: "gone", keep: "survives", outside: "survives" },
				}),
			);
		} finally {
			await session.dispose();
			for (const unit of [owned, keep, outside])
				Bun.spawnSync(["systemctl", "--user", "stop", unit], { env: managerEnv });
			poll.mockRestore();
			notice.mockRestore();
			id.mockRestore();
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	75_000,
);
it("hog poll emits one hidden notice plus one visible user line with shared debounce", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const sessionId = crypto.randomUUID();
	const hidden: string[] = [];
	const visible: string[] = [];
	// One reading per poll call: the constructor's initial poll plus four driven windows.
	const usage = [1_000_000, 16_000_000, 31_000_000, 46_000_000, 61_000_000];
	let call = 0;
	const lifecycle = new SessionSliceLifecycle(
		{
			sessionId,
			isIdleOrWaiting: () => true,
			sendNotice: async content => {
				hidden.push(content);
			},
			sendUserLine: line => {
				visible.push(line);
			},
		},
		root,
		{
			groups: async (slice: string) => {
				if (slice === "omp-keep.slice") return [];
				const u = usage[Math.min(call++, usage.length - 1)] ?? 0;
				return [{ name: lifecycle.slice, usage: u, pids: [4242] }];
			},
		},
	);
	try {
		await lifecycle.ready;
		const base = Date.now();
		await lifecycle.poll(base + 15_000);
		expect(hidden).toHaveLength(0);
		expect(visible).toHaveLength(0);
		await lifecycle.poll(base + 30_000);
		expect(hidden).toHaveLength(1);
		expect(visible).toHaveLength(1);
		expect(visible[0]).toContain(lifecycle.slice);
		expect(visible[0]).toMatch(/^sustained CPU in session slice: \S+ \d+% — agent notified$/);
		expect(visible[0]).toBe(formatHogUserLine(lifecycle.slice, 1));
		const expectedHidden = prompt.render(cpuNoticeTemplate, {
			slice: lifecycle.slice,
			top: lifecycle.slice,
			pid: 4242,
			seconds: (31_000_000 / 1_000_000).toFixed(1),
			kept: "none",
		});
		expect(hidden[0]).toBe(expectedHidden);
		// Same picture: no resend of either line.
		await lifecycle.poll(base + 45_000);
		await lifecycle.poll(base + 60_000);
		expect(hidden).toHaveLength(1);
		expect(visible).toHaveLength(1);
	} finally {
		await lifecycle.stop().catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

it.skipIf(!live)("startup reaps a proven dead owner but leaves live and unproven fixture slices alone", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const deadSid = crypto.randomUUID();
	const liveSid = crypto.randomUUID();
	const deadSlice = sessionSliceName(deadSid);
	const liveSlice = sessionSliceName(liveSid);
	const unknownSlice = sessionSliceName(crypto.randomUUID());
	const units = ["dead", "live", "unknown"].map(name => `${prefix}${name}.service`);
	try {
		for (const [index, slice] of [deadSlice, liveSlice, unknownSlice].entries()) {
			run(["systemd-run", "--user", "--collect", `--unit=${units[index]}`, `--slice=${slice}`, "/bin/sleep", "120"]);
			await fs.mkdir(path.join(root, slice));
		}
		const boot = await Bun.file("/proc/sys/kernel/random/boot_id").text();
		await Bun.write(
			path.join(root, deadSlice, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: 99_999_999, id: deadSid, startToken: "1" }),
		);
		await Bun.write(path.join(root, deadSlice, "boot-id"), boot);
		await writeIsolationOwner(path.join(root, liveSlice), liveSid);
		await Bun.write(path.join(root, liveSlice, "boot-id"), boot);
		expect(await reapOrphanSessionSlices(root)).toEqual([deadSlice]);
		const readbacks = [deadSlice, liveSlice, unknownSlice].map(slice =>
			run(["systemctl", "--user", "show", slice, "-p", "ActiveState", "--value"]),
		);
		expect(readbacks).toEqual(["inactive", "active", "active"]);
		console.log(JSON.stringify({ deadSlice, liveSlice, unknownSlice, readbacks }));
	} finally {
		for (const unit of units) Bun.spawnSync(["systemctl", "--user", "stop", unit], { env: managerEnv });
		await fs.rm(root, { recursive: true, force: true });
	}
});

it.skipIf(!live)("raw process exit stops a fixture session slice without stopping the keep slice", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const sid = crypto.randomUUID();
	const slice = sessionSliceName(sid);
	const unit = `${prefix}raw-exit.service`;
	try {
		run(["systemd-run", "--user", "--collect", `--unit=${unit}`, `--slice=${slice}`, "/bin/sleep", "120"]);
		const code = `import {SessionSliceLifecycle} from ${JSON.stringify(path.resolve(import.meta.dir, "../src/exec/session-slice-lifecycle.ts"))}; const owner = new SessionSliceLifecycle({sessionId:${JSON.stringify(sid)},isIdleOrWaiting:()=>false,sendNotice:async()=>{}},${JSON.stringify(root)}); await owner.ready; process.exit(0);`;
		run(["bun", "-e", code]);
		expect(run(["systemctl", "--user", "show", slice, "-p", "ActiveState", "--value"])).toBe("inactive");
		console.log(
			JSON.stringify({
				rawExitSlice: slice,
				state: "inactive",
				keepSliceNeverStopped: true,
				registryRoot: path.join(path.dirname(getDaemonRuntimeRoot()), "session-slices"),
			}),
		);
	} finally {
		Bun.spawnSync(["systemctl", "--user", "stop", unit], { env: managerEnv });
		await fs.rm(root, { recursive: true, force: true });
	}
});

it.skipIf(!live)(
	"AgentSession disposal awaits ownership startup and stops a fixture even without CPU notices",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
		const sid = crypto.randomUUID();
		const slice = sessionSliceName(sid);
		const unit = `${prefix}dispose-only.service`;
		const auth = await AuthStorage.create(path.join(root, "auth.db"));
		const manager = SessionManager.inMemory(root);
		const id = spyOn(manager, "getSessionId").mockReturnValue(sid);
		const model = createMockModel({ provider: "openai", id: "slice-dispose-fixture" }).model;
		run(["systemd-run", "--user", "--collect", `--unit=${unit}`, `--slice=${slice}`, "/bin/sleep", "120"]);
		const pid = Number(run(["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"]));
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Fixture"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(auth),
			toolRegistry: new Map(),
		});
		try {
			await session.dispose();
			expect(await Bun.file(`/proc/${pid}/stat`).exists()).toBe(false);
			expect(run(["systemctl", "--user", "show", slice, "-p", "ActiveState", "--value"])).toBe("inactive");
			console.log(JSON.stringify({ disposeOnlySlice: slice, pid, state: "inactive" }));
		} finally {
			await session.dispose();
			Bun.spawnSync(["systemctl", "--user", "stop", unit], { env: managerEnv });
			id.mockRestore();
			auth.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
