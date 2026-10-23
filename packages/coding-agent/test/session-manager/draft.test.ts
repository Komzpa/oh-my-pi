import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

describe("SessionManager draft", () => {
	it("round-trips text through saveDraft + consumeDraft", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-roundtrip-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("unsent text");

		// consumeDraft is single-shot: returns the text and removes the sidecar.
		expect(await session.consumeDraft()).toBe("unsent text");
		expect(await session.consumeDraft()).toBeNull();
	});

	it("places the draft inside the artifacts directory so dropSession cleans it", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-location-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("inside artifacts");

		const artifactsDir = session.getArtifactsDir();
		expect(artifactsDir).not.toBeNull();
		const draftPath = path.join(artifactsDir!, "draft.txt");
		expect(await fileExists(draftPath)).toBe(true);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await session.dropSession(sessionFile);

		expect(await fileExists(draftPath)).toBe(false);
	});

	it("removes any stale draft when saving an empty string", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();

		await session.saveDraft("first attempt");
		await session.saveDraft("");

		expect(await session.consumeDraft()).toBeNull();
	});

	it("forces the session header onto disk so resume can find the draft owner", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-ensure-on-disk-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		// No assistant reply yet: without ensureOnDisk the session file would not
		// exist, leaving an orphan draft sidecar that --resume can never reach.
		session.appendMessage({ role: "user", content: "draft only", timestamp: 1 });

		await session.saveDraft("queued for next time");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("is a no-op for in-memory sessions", async () => {
		const session = SessionManager.inMemory();

		await session.saveDraft("ignored");
		expect(await session.consumeDraft()).toBeNull();
	});

	it("returns editor state only for the draft text it was saved with, once", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-state-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.flush();
		const state = {
			cursor: { line: 0, col: 3 },
			pastes: [[1, "payload"]] as [number, string][],
			atoms: [],
			pasteCounter: 1,
		};

		await session.saveDraft("abc [Paste #1, 7 chars]", state);
		expect(await session.consumeDraft()).toBe("abc [Paste #1, 7 chars]");
		expect(await session.consumeDraftState("abc [Paste #1, 7 chars]")).toEqual(state);
		expect(await session.consumeDraftState("abc [Paste #1, 7 chars]")).toBeNull();

		// A text-only save drops the earlier state; mismatched text never receives stale state.
		await session.saveDraft("first", state);
		await session.saveDraft("second");
		expect(await session.consumeDraftState("second")).toBeNull();
		await session.saveDraft("third", state);
		expect(await session.consumeDraftState("different")).toBeNull();
		await session.saveDraft("");
		expect(await session.consumeDraft()).toBeNull();
	});
});
