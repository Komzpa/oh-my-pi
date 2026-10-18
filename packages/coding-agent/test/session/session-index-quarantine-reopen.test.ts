import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { recordSessionTitle, closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getHistoryDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Quarantining a corrupt history.db unlinks the file and its sidecars, then
 * recreates a store at the very same path. A session-index connection that is
 * cached on the path alone stays attached to the unlinked inode, so a title
 * written after the recovery lands nowhere a later reader can see.
 */
describe.skipIf(process.platform === "win32")("session index across a store quarantine", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-index-quarantine-"));
		setAgentDir(testAgentDir);
		closeSessionIndex();
	});

	afterEach(() => {
		HistoryStorage.close();
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("writes a title visible to a fresh reader after history.db is quarantined and recreated", () => {
		const dbPath = getHistoryDbPath();
		recordSessionTitle("session-a", "before quarantine");
		expect(fs.existsSync(dbPath)).toBe(true);

		// Healthy neighbors: recovery must quarantine the corrupt store only.
		const neighborTextPath = path.join(path.dirname(dbPath), "notes.txt");
		const neighborText = "not a database at all";
		fs.writeFileSync(neighborTextPath, neighborText);
		const neighborDbPath = path.join(path.dirname(dbPath), "other.db");
		const neighborDb = new Database(neighborDbPath);
		neighborDb.run("CREATE TABLE t (v TEXT)");
		neighborDb.run("INSERT INTO t VALUES ('healthy')");
		neighborDb.close();
		const neighborDbBytes = fs.readFileSync(neighborDbPath).toString("base64");

		// Corrupt the store by replacing it with garbage at a fresh inode, then
		// let the recovering opener preserve and replace it at the same path.
		// The fresh inode is what keeps the corruption real for the opener:
		// the still-open index connection owns the old, now unlinked inode, so
		// closing it first writes its retained frames back there instead of
		// healing this file into a healthy database again.
		const garbageBytes = "definitely not a sqlite database";
		fs.rmSync(dbPath);
		fs.writeFileSync(dbPath, garbageBytes);
		for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
		HistoryStorage.open(dbPath);
		expect(fs.readdirSync(path.dirname(dbPath)).some(name => name.startsWith("history.db.corrupt-"))).toBe(true);

		// The quarantine moved the replaced inode aside with its garbage intact.
		const namesAfterRecovery = fs.readdirSync(path.dirname(dbPath));
		expect(
			namesAfterRecovery
				.filter(name => name.startsWith("history.db.corrupt-") && !name.endsWith("-wal") && !name.endsWith("-shm"))
				.some(name => fs.readFileSync(path.join(path.dirname(dbPath), name), "utf8") === garbageBytes),
		).toBe(true);
		// ... and left the healthy neighbors byte-identical and unquarantined.
		expect(
			namesAfterRecovery.some(name => name.startsWith("notes.txt.corrupt-") || name.startsWith("other.db.corrupt-")),
		).toBe(false);
		expect(fs.readFileSync(neighborTextPath, "utf8")).toBe(neighborText);
		expect(fs.readFileSync(neighborDbPath).toString("base64")).toBe(neighborDbBytes);

		// This write is the one that used to disappear into the unlinked inode.
		recordSessionTitle("session-b", "after quarantine");

		// A plain connection, like any other process opening the store: the
		// cached index handle cannot vouch for itself here.
		const reader = new Database(dbPath);
		try {
			const row = reader
				.query<{ title: string }, [string]>("SELECT title FROM session_titles WHERE session_id = ?")
				.get("session-b");
			expect(row?.title).toBe("after quarantine");
		} finally {
			reader.close();
		}
	});
});
