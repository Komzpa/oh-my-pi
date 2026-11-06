import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as loader from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const temporary: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function journal(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-index-handoff-"));
	temporary.push(directory);
	const file = path.join(directory, "session.jsonl");
	const timestamp = "2026-11-06T00:00:00.000Z";
	await Bun.write(
		file,
		[
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "session", cwd: directory, timestamp },
			{
				type: "custom",
				id: "history",
				parentId: null,
				timestamp,
				customType: "history",
				data: "x".repeat(1024 * 1024),
			},
			{ type: "label", id: "label", parentId: "history", timestamp, targetId: "history", label: "bookmark" },
			{ type: "reset_boundary", id: "reset", parentId: "label", timestamp },
			{
				type: "message",
				id: "tail",
				parentId: "reset",
				timestamp,
				message: { role: "user", content: "current", timestamp: 1 },
			},
		]
			.map(row => JSON.stringify(row))
			.join("\n") + "\n",
	);
	return file;
}

async function open(file: string): Promise<SessionManager> {
	const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
	managers.push(manager);
	return manager;
}

test("replacement restores context, bookmarks and lazy history without parsing the journal", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const parse = spyOn(loader, "visitSessionFileForResume").mockImplementation(async () => {
		throw new Error("replacement reparsed the journal");
	});
	try {
		const restored = await open(file);
		expect(restored.getEntryCount()).toBe(4);
		expect(restored.getLeafId()).toBe("tail");
		expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
		expect(restored.getEntry("history")).toEqual(original.getEntry("history"));
		expect(restored.getLabel("history")).toBe("bookmark");
		expect(restored.getChildren("history").map(entry => entry.id)).toEqual(["label"]);
		const appended = restored.appendCustomEntry("checkpoint", { revision: 2 });
		expect(restored.getChildren("tail").map(entry => entry.id)).toEqual([appended]);
		expect(parse).not.toHaveBeenCalled();
	} finally {
		parse.mockRestore();
	}
});

test("an appended journal invalidates the handoff and resumes the new tail", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	await fs.appendFile(
		file,
		JSON.stringify({
			type: "custom",
			id: "new",
			parentId: "tail",
			timestamp: "2026-11-06T01:00:00Z",
			customType: "checkpoint",
			data: 2,
		}) + "\n",
	);
	const parse = spyOn(loader, "visitSessionFileForResume");
	try {
		const restored = await open(file);
		expect(restored.getLeafId()).toBe("new");
		expect(restored.getEntryCount()).toBe(5);
		expect(parse).toHaveBeenCalledTimes(1);
	} finally {
		parse.mockRestore();
	}
});

test("same-length journal edits invalidate the handoff even when mtime is preserved", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const before = await fs.stat(file);
	await Bun.write(file, (await Bun.file(file).text()).replace('"id":"tail"', '"id":"edit"'));
	await fs.utimes(file, before.atime, before.mtime);
	const restored = await open(file);
	expect(restored.getLeafId()).toBe("edit");
	expect(restored.getEntry("tail")).toBeUndefined();
});

test("an invalid handoff range falls back without duplicating partially restored entries", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const cache = Bun.file(`${file}.index-handoff`);
	const snapshot = await cache.json();
	snapshot.ordered[1].length = -1;
	await Bun.write(cache, JSON.stringify(snapshot));
	const restored = await open(file);
	expect(restored.getEntryCount()).toBe(4);
	expect(restored.getLeafId()).toBe("tail");
	expect(restored.getLabel("history")).toBe("bookmark");
});

test.skipIf(!process.env.OMP_HANDOFF_BENCH)(
	"500 MB / 200k entries resume from the handoff without journal parsing",
	async () => {
		const file = await journal();
		const directory = path.dirname(file);
		const timestamp = "2026-11-06T00:00:00.000Z";
		const writer = Bun.file(file).writer();
		writer.write(
			JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "large", cwd: directory, timestamp }) +
				"\n",
		);
		for (let i = 0; i < 199998; i++) {
			writer.write(
				JSON.stringify({
					type: "custom",
					id: `row-${i}`,
					parentId: i ? `row-${i - 1}` : null,
					timestamp,
					customType: "history",
					data: "x".repeat(2500),
				}) + "\n",
			);
			if (i % 1024 === 0) await writer.flush();
		}
		writer.write(JSON.stringify({ type: "reset_boundary", id: "reset", parentId: "row-199997", timestamp }) + "\n");
		writer.write(
			JSON.stringify({
				type: "message",
				id: "tail",
				parentId: "reset",
				timestamp,
				message: { role: "user", content: "current", timestamp: 1 },
			}) + "\n",
		);
		await writer.end();
		const original = await open(file);
		const writeStart = performance.now();
		expect(await original.writeIndexHandoff()).toBe(true);
		const writeMs = performance.now() - writeStart;
		const parse = spyOn(loader, "visitSessionFileForResume").mockImplementation(async () => {
			throw new Error("replacement reparsed large journal");
		});
		try {
			const times: number[] = [];
			for (let i = 0; i < 3; i++) {
				const start = performance.now();
				const restored = await open(file);
				times.push(performance.now() - start);
				expect(restored.getEntryCount()).toBe(200000);
				expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
			}
			expect(parse).not.toHaveBeenCalled();
			console.info(
				JSON.stringify({
					journalBytes: (await fs.stat(file)).size,
					handoffBytes: (await fs.stat(`${file}.index-handoff`)).size,
					entries: 200000,
					writeMs,
					openMs: times,
				}),
			);
		} finally {
			parse.mockRestore();
		}
	},
	60000,
);

test("prepared index stays current across appends without replacing its base", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await original.writeIndexHandoff()).toBe(true);
	const base = await Bun.file(`${file}.index-handoff`).text();
	const id = original.appendCustomEntry("restart-checkpoint", { value: 42 });
	await original.flush();
	expect(await Bun.file(`${file}.index-handoff`).text()).toBe(base);
	const parse = spyOn(loader, "visitSessionFileForResume").mockImplementation(async () => {
		throw new Error("incremental handoff reparsed journal");
	});
	try {
		const restored = await open(file);
		expect(restored.getLeafId()).toBe(id);
		expect(restored.getEntry(id)).toMatchObject({ customType: "restart-checkpoint", data: { value: 42 } });
		expect(restored.getEntryCount()).toBe(5);
		expect(restored.getLabel("history")).toBe("bookmark");
	} finally {
		parse.mockRestore();
	}
});

test("overlapping index preparation calls publish one usable handoff", async () => {
	const file = await journal();
	const original = await open(file);
	expect(await Promise.all([original.writeIndexHandoff(), original.writeIndexHandoff()])).toEqual([true, true]);
	const restored = await open(file);
	expect(restored.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
});

test("an external same-size edit cannot be recertified by repeated handoff requests", async () => {
	const file = await journal();
	const original = await open(file);
	await original.writeIndexHandoff();
	await Bun.write(file, (await Bun.file(file).text()).replace('"id":"history"', '"id":"changed"'));
	expect(await original.writeIndexHandoff()).toBe(false);
	expect(await original.writeIndexHandoff()).toBe(false);
	const restored = await open(file);
	expect(restored.getEntry("changed")).toMatchObject({ customType: "history" });
	expect(restored.getEntry("history")).toBeUndefined();
});

test("switching journals starts a fresh incremental handoff after appending", async () => {
	const original = await open(await journal());
	await original.writeIndexHandoff();
	const next = await journal();
	await original.setSessionFile(next);
	const id = original.appendCustomEntry("after-switch", { value: 1 });
	expect(await original.writeIndexHandoff()).toBe(true);
	const restored = await open(next);
	expect(restored.getLeafId()).toBe(id);
	expect(restored.getEntry(id)).toMatchObject({ customType: "after-switch", data: { value: 1 } });
});
