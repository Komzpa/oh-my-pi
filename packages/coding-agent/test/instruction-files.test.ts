import { describe, expect, it } from "bun:test";
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

	it("sends a usable unified diff for an oversized file against the loaded bytes", async () => {
		using dir = TempDir.createSync("@instruction-diff-");
		const file = dir.join("AGENTS.md");
		const before = "unchanged\n".repeat(4000) + "old rule\n";
		const after = "unchanged\n".repeat(4000) + "new rule\n";
		await Bun.write(file, before);
		const tracker = new InstructionFiles(SessionManager.inMemory(dir.path()));
		await tracker.loadedInstruction(file);
		await Bun.write(file, after);
		await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
		const updates = await tracker.refresh(16384);
		expect(updates).toHaveLength(1);
		const patch = updates[0].slice(updates[0].indexOf("--- "));
		await Bun.write(file, before);
		await $`patch ${file} < ${new Blob([patch])}`.quiet();
		expect(await Bun.file(file).text()).toBe(after);
		expect(updates[0]).toContain(file);
		expect(updates[0]).not.toContain(after);
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
