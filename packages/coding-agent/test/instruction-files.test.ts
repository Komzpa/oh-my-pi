import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { $ } from "bun";
import { InstructionFiles } from "../src/session/instruction-files";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("loaded instruction refresh", () => {
	it("delivers each changed body once, including a second change, and ignores timestamp-only changes", async () => {
		using dir = TempDir.createSync("@instruction-refresh-");
		const file = dir.join("SKILL.md");
		await Bun.write(file, "old rule\n");
		const tracker = new InstructionFiles(SessionManager.inMemory(dir.path()));
		await tracker.loadedInstruction(file);
		expect(await tracker.refresh(16384)).toEqual([]);
		await Bun.write(file, "new rule\n");
		await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
		const updates = await tracker.refresh(16384);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toContain("new rule\n");
		expect(await tracker.refresh(16384)).toEqual([]);
		await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
		expect(await tracker.refresh(16384)).toEqual([]);
		await Bun.write(file, "third rule\n");
		expect((await tracker.refresh(16384))[0]).toContain("third rule\n");
		expect(await tracker.refresh(16384)).toEqual([]);
	});

	it("bounds successive oversized changes to one re-read notice across reopen", async () => {
		using dir = TempDir.createSync("@instruction-diff-");
		const file = dir.join("AGENTS.md");
		const manager = SessionManager.create(dir.path(), dir.join("sessions"));
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		const tracker = new InstructionFiles(manager);
		await Bun.write(file, "old".repeat(200000));
		await tracker.loadedInstruction(file);
		let tick = 2000;
		for (const word of ["new", "third"]) {
			await Bun.write(file, word.repeat(200000));
			await fs.utimes(file, new Date(), new Date(Date.now() + tick));
			tick += 2000;
			expect((await tracker.refresh(1000))[0]).toContain("Read the complete file");
			expect(tracker.systemNotices()).toHaveLength(1);
			expect(Buffer.byteLength(tracker.systemNotices()[0])).toBeLessThan(1000);
		}
		manager.appendMessage(createAssistantMessage("ready"));
		await manager.flush();
		const restored = new InstructionFiles(await SessionManager.open(manager.getSessionFile()!));
		expect(restored.systemNotices()).toEqual(tracker.systemNotices());
		await Bun.write(file, "small current rule");
		expect((await restored.refresh(1000))[0]).toContain("small current rule");
		expect(restored.systemNotices()).toHaveLength(1);
	});

	it("read updates supersede previous notices and imported instructions stay tracked", async () => {
		using dir = TempDir.createSync("@instruction-import-");
		const file = dir.join("AGENTS.md");
		const imported = dir.join("rules.md");
		await Bun.write(file, "old");
		await Bun.write(imported, "imported rule");
		const tracker = new InstructionFiles(SessionManager.inMemory(dir.path()));
		await tracker.loaded(file);
		await Bun.write(file, "@./rules.md");
		await tracker.loaded(file, "@./rules.md");
		expect(tracker.systemNotices()[0]).toContain("imported rule");
		await Bun.write(imported, "changed imported rule");
		expect((await tracker.refresh(16384))[0]).toContain("changed imported rule");
	});

	it("restores the loaded version from the journal rather than accepting changed disk bytes on resume", async () => {
		using dir = TempDir.createSync("@instruction-resume-");
		const file = dir.join("SKILL.md");
		await Bun.write(file, "original\n");
		const manager = SessionManager.create(dir.path(), dir.join("sessions"));
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		await new InstructionFiles(manager).loadedInstruction(file);
		manager.appendMessage(createAssistantMessage("ready"));
		await manager.flush();
		const sessionFile = manager.getSessionFile()!;
		await Bun.write(file, "changed while stopped\n");
		const resumed = await SessionManager.open(sessionFile);
		const tracker = new InstructionFiles(resumed);
		await tracker.loaded(file, undefined, true);
		expect((await tracker.refresh(16384))[0]).toContain("changed while stopped\n");
		expect(await tracker.refresh(16384)).toEqual([]);
		await resumed.flush();
		const reopened = new InstructionFiles(await SessionManager.open(sessionFile));
		expect(await reopened.refresh(16384)).toEqual([]);
		expect(reopened.systemNotices()[0]).toContain("changed while stopped\n");
	});

	it("drops abandoned branch notices and persists only obfuscated notices without raw bodies", async () => {
		using dir = TempDir.createSync("@instruction-branch-");
		const file = dir.join("AGENTS.md");
		await Bun.write(file, "initial secret-value");
		const manager = SessionManager.inMemory(dir.path());
		const tracker = new InstructionFiles(manager, text => text.replaceAll("secret-value", () => "$$MASK$$"));
		await tracker.loaded(file);
		const originalLeaf = manager.getLeafId()!;
		await Bun.write(file, "updated secret-value");
		await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
		await tracker.refresh(16384);
		expect(tracker.systemNotices()[0]).toContain("updated secret-value");
		const persisted = JSON.stringify(manager.getBranch());
		expect(persisted).not.toContain("secret-value");
		expect(persisted).toContain("$$MASK$$");
		manager.branch(originalLeaf);
		expect(tracker.systemNotices()).toEqual([]);
		expect((await tracker.refresh(16384))[0]).toContain("updated secret-value");
	});

	it("refreshes appended turns without replaying historical instruction state", async () => {
		using dir = TempDir.createSync("@instruction-incremental-");
		const file = dir.join("AGENTS.md");
		await Bun.write(file, "initial");
		const manager = SessionManager.inMemory(dir.path());
		const tracker = new InstructionFiles(manager);
		await tracker.loaded(file);
		const branch = spyOn(manager, "getBranch");
		const read = spyOn(manager, "getEntry");
		try {
			for (let i = 0; i < 10; i++) {
				manager.appendMessage({ role: "user", content: "next turn", timestamp: i });
				expect(await tracker.refresh(16384)).toEqual([]);
			}
			expect(branch).not.toHaveBeenCalled();
			expect(read).toHaveBeenCalledTimes(10);
			await Bun.write(file, "changed instruction");
			await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
			expect((await tracker.refresh(16384))[0]).toContain("changed instruction");
		} finally {
			branch.mockRestore();
			read.mockRestore();
		}
	});

	it.skipIf(process.platform === "win32")(
		"ignores an instruction replaced by a FIFO without blocking the request",
		async () => {
			using dir = TempDir.createSync("@instruction-fifo-");
			const file = dir.join("AGENTS.md");
			await Bun.write(file, "original rule");
			const tracker = new InstructionFiles(SessionManager.inMemory(dir.path()));
			await tracker.loaded(file);
			await fs.unlink(file);
			await $`mkfifo ${file}`.quiet();
			expect(await tracker.refresh(16384)).toEqual([]);
			expect(tracker.systemNotices()).toEqual([]);
		},
		2000,
	);

	it("ignores unrelated tool reads and retains explicit custom context files", async () => {
		using dir = TempDir.createSync("@instruction-selection-");
		const unrelated = dir.join("notes.md");
		const context = dir.join("RULES.md");
		await Bun.write(unrelated, "old");
		await Bun.write(context, "old");
		const tracker = new InstructionFiles(SessionManager.inMemory(dir.path()));
		await tracker.loadedInstruction(unrelated);
		await tracker.loaded(context);
		await Bun.write(unrelated, "new unrelated");
		await Bun.write(context, "new context");
		const updates = await tracker.refresh(16384);
		expect(updates).toHaveLength(1);
		expect(updates[0]).toContain("new context");
	});
});
