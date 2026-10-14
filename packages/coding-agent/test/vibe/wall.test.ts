import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";
import { AsyncJobManager } from "../../src/async/job-manager";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { VibeListTool, VibeWaitTool } from "../../src/tools/vibe";
import { type VibeParentSession, VibeSessionRegistry } from "../../src/vibe/runtime";

const OWNER = "test-owner";

let manager: AsyncJobManager;
let session: ToolSession;

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map(part => part.text ?? "").join("\n");

beforeEach(() => {
	VibeSessionRegistry.resetGlobalForTests();
	manager = new AsyncJobManager({});
	session = {
		getAgentId: () => OWNER,
		getSessionId: () => "test-parent-session",
		getSessionFile: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
});

afterEach(async () => {
	await manager.dispose({ timeoutMs: 100 });
	VibeSessionRegistry.resetGlobalForTests();
});

function register(id: string, state: "idle" | "running" | "dead", killed = false, jobId?: string): void {
	VibeSessionRegistry.global().registerRecordForTests({ id, ownerId: OWNER, state, killed, jobId });
}

describe("vibe wall hides director-killed sessions", () => {
	it("vibe_list keeps live and self-terminated workers, collapsing killed ones to a trailing line", async () => {
		register("Killed1", "dead", true);
		register("Live", "idle");
		register("Crashed", "dead");
		register("Killed2", "dead", true);

		const result = await new VibeListTool(session).execute();
		const text = textOf(result);

		expect(result.details?.screens.map(screen => screen.id)).toEqual(["Live", "Crashed"]);
		expect(result.details?.hiddenKilled).toEqual(["Killed1", "Killed2"]);
		expect(text).toContain("- `Crashed` [fast] dead");
		expect(text).not.toContain("- `Killed1`");
		expect(text).toContain("Killed (2, transcripts at history://<id>): `Killed1`, `Killed2`");
	});

	it("vibe_list with only killed sessions says so instead of offering a first spawn", async () => {
		register("Killed1", "dead", true);

		const result = await new VibeListTool(session).execute();

		expect(result.details?.screens).toEqual([]);
		expect(textOf(result)).toStartWith("No live vibe sessions.");
	});

	it("vibe_list names only the most recent killed sessions", async () => {
		for (let i = 1; i <= 11; i++) register(`K${i}`, "dead", true);

		const text = textOf(await new VibeListTool(session).execute());

		expect(text).toContain("Killed (11, transcripts at history://<id>): `K4`, ");
		expect(text).toEndWith("`K11`, +3 more");
		expect(text).not.toContain("`K3`");
	});

	it("vibe_wait shows a killed session the director names explicitly", async () => {
		register("Killed1", "dead", true);

		const result = await new VibeWaitTool(session).execute("call", { sessions: ["Killed1"], timeout: 1 });

		expect(result.details?.screens.map(screen => screen.id)).toEqual(["Killed1"]);
		expect(result.details?.hiddenKilled).toBeUndefined();
	});

	it("vibe_wait keeps a card on the wall when its worker is killed mid-wait", async () => {
		const turn = Promise.withResolvers<string>();
		const jobId = manager.register("task", "worker turn", async () => turn.promise, { ownerId: OWNER });
		register("Worker", "running", false, jobId);
		// Teardown outlasts one 500ms progress tick, so a frame lands while the worker is killed but unsettled.
		VibeSessionRegistry.global().setTeardownGraceForTesting(700);
		const frames: VibeToolDetails[] = [];

		const pending = new VibeWaitTool(session).execute("call", { timeout: 3 }, undefined, update => {
			if (update.details) frames.push(update.details);
		});
		await VibeSessionRegistry.global().kill(session, "Worker");
		turn.resolve("done");
		const result = await pending;

		for (const frame of [...frames, result.details!]) {
			expect(frame.screens.map(screen => screen.id)).toEqual(["Worker"]);
		}
	});
});

describe("vibe optional journal capabilities", () => {
	for (const selective of [false, true]) {
		it(`rehydrates and recognizes an exited mode with ${selective ? "selective" : "legacy"} journal access`, async () => {
			const journal = SessionManager.inMemory();
			journal.appendModeChange("none");
			const fullBranch = spyOn(journal, "getBranch");
			if (selective)
				fullBranch.mockImplementation(() => {
					throw new Error("full branch read");
				});
			const matching = spyOn(journal, "getBranchMatching");
			const latest = spyOn(journal, "getLatestBranchMatching");
			const parent: VibeParentSession = {
				...session,
				getSessionFile: () => "/tmp/vibe-capability-parent.jsonl",
				sessionManager: {
					appendCustomEntry: journal.appendCustomEntry.bind(journal),
					ensureOnDisk: journal.ensureOnDisk.bind(journal),
					flush: journal.flush.bind(journal),
					getEntries: journal.getEntries.bind(journal),
					getBranch: journal.getBranch.bind(journal),
					...(selective
						? {
								getBranchMatching: journal.getBranchMatching.bind(journal),
								getLatestBranchMatching: journal.getLatestBranchMatching.bind(journal),
							}
						: {}),
				},
			};
			try {
				expect(await VibeSessionRegistry.global().rehydrate(parent)).toBe(0);
				expect(await VibeSessionRegistry.global().killAll(parent)).toBe(0);
				expect(fullBranch.mock.calls.length).toBe(selective ? 0 : 2);
				expect(matching.mock.calls.length).toBe(selective ? 1 : 0);
				expect(latest.mock.calls.length).toBe(selective ? 1 : 0);
			} finally {
				fullBranch.mockRestore();
				matching.mockRestore();
				latest.mockRestore();
				await journal.close();
			}
		});
	}
});
