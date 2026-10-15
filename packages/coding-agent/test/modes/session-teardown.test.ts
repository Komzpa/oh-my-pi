import { describe, expect, it } from "bun:test";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../../src/session/session-manager";
import { createSessionTeardown } from "../../src/modes/session-teardown";

/**
 * Signal-safe session teardown contract (issue #4080). The callback body
 * registered on `postmortem` for `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException`
 * must persist the in-progress editor draft and emit the extension
 * `session_shutdown` event (via `session.dispose()`) — the same steps the TUI
 * Ctrl+C keypress path performs. Both paths funnel through
 * `createSessionTeardown`, so exercising it directly proves the acceptance
 * criteria hold regardless of the trigger.
 */
describe("createSessionTeardown", () => {
	it.each(["half typed\nещё не отправлено  ", ""])(
		"preserves restart draft before close and late UI teardown: %j",
		async text => {
			using temp = TempDir.createSync("@omp-restart-draft-");
			const manager = SessionManager.create(temp.path(), temp.path());
			manager.appendMessage({ role: "user", content: "already submitted", timestamp: 1 });
			manager.appendCustomEntry("omp:restart-pending-queues", {
				steering: [],
				followUp: [{ role: "user", content: "queued input", timestamp: 2 }],
				pendingNextTurn: [],
			});
			const entries = manager.getEntries();
			await manager.ensureOnDisk();
			await manager.saveDraft("obsolete draft");
			let editorText = text;
			const teardown = createSessionTeardown({
				getDraftText: () => editorText,
				beginDispose: () => {},
				saveDraft: value => manager.saveDraft(value),
				disposeSession: () => manager.close(),
			});
			// #executeRestart must persist while its original editor/session still owns input.
			await teardown.saveDraft();
			await manager.close();
			manager.seal();
			editorText = ""; // UI controller teardown can clear or replace the active editor.
			await teardown();
			const reopened = await SessionManager.open(manager.getSessionFile()!);
			try {
				expect(await reopened.consumeDraft()).toBe(text || null);
				expect(await reopened.consumeDraft()).toBeNull();
				expect(reopened.getEntries()).toEqual(entries);
			} finally {
				await reopened.close();
			}
		},
	);

	it("keeps a failed restart draft save retryable without disposing the active editor", async () => {
		let editorText = "partial";
		let attempts = 0;
		let disposed = false;
		const saved: string[] = [];
		const teardown = createSessionTeardown({
			getDraftText: () => editorText,
			beginDispose: () => {
				disposed = true;
			},
			saveDraft: async text => {
				if (++attempts === 1) throw new Error("disk full");
				saved.push(text);
			},
			disposeSession: async () => {
				disposed = true;
			},
		});
		await expect(teardown.saveDraft()).rejects.toThrow("disk full");
		expect(disposed).toBe(false);
		editorText = "partial\nдописано";
		await teardown.saveDraft();
		editorText = "";
		await teardown();
		expect(saved).toEqual(["partial\nдописано"]);
		expect(attempts).toBe(2);
	});

	it("marks the session disposing before awaiting draft persistence", async () => {
		const order: string[] = [];
		const release = Promise.withResolvers<void>();

		const teardown = createSessionTeardown({
			getDraftText: () => {
				order.push("snapshot");
				return "draft";
			},
			beginDispose: () => {
				order.push("beginDispose");
			},
			saveDraft: async () => {
				order.push("saveDraft:start");
				await release.promise;
				order.push("saveDraft:done");
			},
			disposeSession: async () => {
				order.push("disposeSession");
			},
		});

		const running = teardown();
		expect(order).toEqual(["snapshot", "beginDispose", "saveDraft:start"]);
		release.resolve();
		await running;

		expect(order).toEqual(["snapshot", "beginDispose", "saveDraft:start", "saveDraft:done", "disposeSession"]);
	});

	it("still disposes when saveDraft rejects — never leaves session_shutdown unemitted", async () => {
		let disposed = false;

		const teardown = createSessionTeardown({
			getDraftText: () => "draft",
			beginDispose: () => {},
			saveDraft: async () => {
				throw new Error("disk full");
			},
			disposeSession: async () => {
				disposed = true;
			},
		});

		await teardown();

		expect(disposed).toBe(true);
	});

	it("passes the empty snapshot through so a stale sidecar is cleared on clean exit", async () => {
		const seen: string[] = [];
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => {},
			saveDraft: async text => {
				seen.push(text);
			},
			disposeSession: async () => {},
		});

		await teardown();

		expect(seen).toEqual([""]);
	});

	it("memoizes: concurrent and repeat calls run the teardown exactly once", async () => {
		let getDraftCalls = 0;
		let saveDraftCalls = 0;
		let disposeCalls = 0;
		const release = Promise.withResolvers<void>();

		const teardown = createSessionTeardown({
			getDraftText: () => {
				getDraftCalls++;
				return `draft-${getDraftCalls}`;
			},
			beginDispose: () => {},
			saveDraft: async () => {
				saveDraftCalls++;
			},
			disposeSession: async () => {
				disposeCalls++;
				await release.promise;
			},
		});

		// Kick off two concurrent invocations while the first is still awaiting
		// disposeSession — this is exactly what happens if a SIGTERM arrives
		// mid-`InteractiveMode.shutdown()`.
		const first = teardown();
		const second = teardown();
		release.resolve();
		await Promise.all([first, second]);

		// A third call after settlement must still be a no-op.
		await teardown();

		expect(getDraftCalls).toBe(1);
		expect(saveDraftCalls).toBe(1);
		expect(disposeCalls).toBe(1);
	});

	it("snapshots the draft text at first call — later editor mutations do not leak in", async () => {
		let editorText = "before";
		let captured: string | undefined;

		const teardown = createSessionTeardown({
			getDraftText: () => editorText,
			beginDispose: () => {},
			saveDraft: async text => {
				captured = text;
			},
			disposeSession: async () => {},
		});

		const running = teardown();
		editorText = "after"; // A late edit must not overwrite the persisted draft.
		await running;

		expect(captured).toBe("before");
	});

	it("forwards the postmortem reason into disposeSession so signal exits record the real trigger", async () => {
		const received: Array<postmortem.Reason | undefined> = [];

		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => {},
			saveDraft: async () => {},
			disposeSession: async reason => {
				received.push(reason);
			},
		});

		await teardown(postmortem.Reason.SIGTERM);

		expect(received).toEqual([postmortem.Reason.SIGTERM]);
	});

	it("keypress path passes no reason — dispose falls back to a normal exit record", async () => {
		const received: Array<postmortem.Reason | undefined> = [];

		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => {},
			saveDraft: async () => {},
			disposeSession: async reason => {
				received.push(reason);
			},
		});

		await teardown();

		expect(received).toEqual([undefined]);
	});

	it("first call's reason wins: a later caller with a different reason awaits the same promise", async () => {
		const received: Array<postmortem.Reason | undefined> = [];
		const release = Promise.withResolvers<void>();

		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => {},
			saveDraft: async () => {},
			disposeSession: async reason => {
				received.push(reason);
				await release.promise;
			},
		});

		// SIGTERM lands first; postmortem.quit(0)'s MANUAL pass arrives while the
		// teardown is still draining — it must not restart the run or mutate the
		// recorded reason.
		const first = teardown(postmortem.Reason.SIGTERM);
		const second = teardown(postmortem.Reason.MANUAL);
		release.resolve();
		await Promise.all([first, second]);

		expect(received).toEqual([postmortem.Reason.SIGTERM]);
	});
});
