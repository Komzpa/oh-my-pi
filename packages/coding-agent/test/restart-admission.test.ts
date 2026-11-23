import { describe, expect, it } from "bun:test";
import { fork, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../src/session/session-manager";
import { RESTART_PREPARE_ENV, prepareRestartSuccessor } from "../src/restart-admission";

interface Frame {
	type: string;
	text?: string;
	entries?: unknown[];
}

function launch(file: string, sessionId: string) {
	const identity = { requestId: "test-request", sessionId, sessionFile: file, requestedAt: Date.now() };
	const child: ChildProcess = fork(path.join(import.meta.dir, "fixtures/restart-admission-child.ts"), [file], {
		execPath: process.execPath,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
		env: { ...process.env, [RESTART_PREPARE_ENV]: JSON.stringify(identity) },
	});
	const frames: Frame[] = [];
	const listeners = new Set<() => void>();
	child.on("message", frame => {
		frames.push(frame as Frame);
		for (const listener of listeners) listener();
	});
	const exit = Promise.withResolvers<number | null>();
	child.once("exit", exit.resolve);
	const exited = exit.promise;
	const next = async (type: string): Promise<Frame> => {
		const found = frames.find(frame => frame.type === type);
		if (found) return found;
		const ready = Promise.withResolvers<Frame>();
		const listener = () => {
			const frame = frames.find(frame => frame.type === type);
			if (frame) ready.resolve(frame);
		};
		listeners.add(listener);
		const deadline = setTimeout(() => ready.reject(new Error(`Missing IPC frame ${type}`)), 10_000);
		try {
			return await ready.promise;
		} finally {
			clearTimeout(deadline);
			listeners.delete(listener);
		}
	};
	return { child, identity, frames, next, exited };
}

describe("prepared restart admission", () => {
	it("parent commits only after the final writer closes and repeat commit cannot replay startup", async () => {
		using temp = TempDir.createSync("@pi-restart-parent-");
		const manager = SessionManager.create(temp.path(), temp.path());
		manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.saveDraft("не отправлено\n🐈  ");
		const file = manager.getSessionFile()!;
		const report = path.join(temp.path(), "successor.json");
		const prepared = await prepareRestartSuccessor(
			[process.execPath, path.join(import.meta.dir, "fixtures/restart-admission-child.ts"), file, report],
			{ requestId: "parent-handoff", sessionId: manager.getSessionId(), sessionFile: file, requestedAt: Date.now() },
		);
		const release = Promise.withResolvers<void>();
		let closes = 0;
		const committed = prepared.commit(async () => {
			closes++;
			await release.promise;
			await manager.close();
		});
		const repeated = prepared.commit(async () => {
			throw new Error("duplicate commit");
		});
		try {
			await Bun.sleep(30);
			expect(
				await fs.stat(report).then(
					() => true,
					() => false,
				),
			).toBe(false);
			manager.appendMessage({ role: "user", content: "final admitted input", timestamp: 2 });
			await manager.flush();
			const entries = manager.getEntries();
			release.resolve();
			expect(await committed).toBe(0);
			expect(await repeated).toBe(0);
			expect(closes).toBe(1);
			const result = await Bun.file(report).json();
			expect(result.text).toBe("не отправлено\n🐈  ");
			expect(result.entries).toEqual(entries);
		} finally {
			release.resolve();
			await committed;
			await manager.close();
		}
	});

	it("failed parent checkpoint aborts only its prepared candidate and retains the active draft", async () => {
		using temp = TempDir.createSync("@pi-restart-parent-failure-");
		const manager = SessionManager.create(temp.path(), temp.path());
		manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.saveDraft("keep this draft");
		const file = manager.getSessionFile()!;
		const candidate = await prepareRestartSuccessor(
			[process.execPath, path.join(import.meta.dir, "fixtures/restart-admission-child.ts"), file],
			{
				requestId: "failed-checkpoint",
				sessionId: manager.getSessionId(),
				sessionFile: file,
				requestedAt: Date.now(),
			},
		);
		try {
			await expect(
				candidate.commit(async () => {
					throw new Error("checkpoint failed");
				}),
			).rejects.toThrow("checkpoint failed");
			expect(await manager.consumeDraft()).toBe("keep this draft");
		} finally {
			await candidate.abort();
			await manager.close();
		}
	});

	it("leaves the active writer and Unicode draft untouched until exact commit, then reads the final checkpoint", async () => {
		using temp = TempDir.createSync("@pi-restart-admission-");
		const manager = SessionManager.create(temp.path(), temp.path());
		manager.appendMessage({ role: "user", content: "original work", timestamp: 1 });
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		const draft = "частично введено\nUnicode 🐈  ";
		await manager.saveDraft(draft);
		const candidate = launch(file, manager.getSessionId());
		try {
			await candidate.next("restart-prepared");
			candidate.child.send({ ...candidate.identity, requestId: "stale-request", type: "restart-commit" });
			await Bun.sleep(30); // Observe the separate process receiving the rejected commit.
			expect(candidate.frames.some(frame => frame.type === "admitted")).toBe(false);
			manager.appendMessage({ role: "user", content: "input admitted during preparation", timestamp: 2 });
			await manager.flush();
			const checkpoint = manager.getEntries();
			await manager.close();
			candidate.child.send({ ...candidate.identity, type: "restart-commit" });
			const recovered = await candidate.next("draft");
			expect(recovered.text).toBe(draft);
			expect(recovered.entries).toEqual(checkpoint);
			expect(await candidate.exited).toBe(0);
		} finally {
			candidate.child.kill();
			await candidate.exited;
			await manager.close();
		}
	});

	it.each(["abort", "disconnect"])("does not admit or consume input after %s", async operation => {
		using temp = TempDir.createSync("@pi-restart-admission-reject-");
		const manager = SessionManager.create(temp.path(), temp.path());
		manager.appendMessage({ role: "user", content: "unfinished work", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.saveDraft("unsent");
		const candidate = launch(manager.getSessionFile()!, manager.getSessionId());
		try {
			await candidate.next("restart-prepared");
			if (operation === "abort") candidate.child.send({ ...candidate.identity, type: "restart-abort" });
			else candidate.child.disconnect();
			expect(await candidate.exited).toBe(1);
			expect(candidate.frames.some(frame => frame.type === "admitted")).toBe(false);
			expect(await manager.consumeDraft()).toBe("unsent");
		} finally {
			candidate.child.kill();
			await candidate.exited;
			await manager.close();
		}
	});
});
