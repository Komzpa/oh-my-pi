import { afterEach, expect, test } from "bun:test";
import type { AssistantMessage, AssistantRetryRecovery } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildSessionContext } from "../src/session/session-context";
import { parseSessionContent } from "../src/session/session-loader";
import { SessionManager } from "../src/session/session-manager";
const dirs: TempDir[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map(dir => dir.remove()));
});
function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		},
	};
}
test("discarding a retry turn appends a branch marker without replacing history or billing twice", async () => {
	const dir = TempDir.createSync("@pi-append-recovery-");
	dirs.push(dir);
	const manager = SessionManager.create(dir.path(), dir.path());
	manager.appendMessage({ role: "user", content: "Keep", timestamp: Date.now() });
	const discarded = manager.appendMessage(assistant());
	manager.appendServiceTierChange(null);
	const file = manager.getSessionFile()!;
	await manager.flush();
	const before = await Bun.file(file).text();
	const usage = manager.getUsageStatistics();
	await manager.discardEntryDurably(discarded);
	await manager.close();
	expect((await Bun.file(file).text()).startsWith(before)).toBe(true);
	const resumed = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
	expect(resumed.getBranch().some(entry => entry.id === discarded)).toBe(false);
	expect(resumed.getBranch().some(entry => entry.type === "service_tier_change")).toBe(true);
	expect(resumed.getUsageStatistics()).toEqual(usage);
	await resumed.close();
});
test("retry recovery annotation survives reload with an unchanged journal prefix", async () => {
	const dir = TempDir.createSync("@pi-append-annotation-");
	dirs.push(dir);
	const manager = SessionManager.create(dir.path(), dir.path());
	const id = manager.appendMessage(assistant());
	const file = manager.getSessionFile()!;
	await manager.flush();
	const before = await Bun.file(file).text();
	const recovery: AssistantRetryRecovery = {
		kind: "auto-retry",
		status: "superseded",
		attempt: 1,
		recovery: "plain",
		note: "Retry succeeded",
	};
	const append = (manager as { appendRetryRecovery?: (entryId: string, recovery: AssistantRetryRecovery) => void })
		.appendRetryRecovery;
	if (append) append.call(manager, id, recovery);
	else {
		const entry = manager.getEntry(id)!;
		if (entry.type !== "message" || entry.message.role !== "assistant") throw Error("assistant required");
		entry.message.retryRecovery = recovery;
		manager.updateEntry(entry);
		await manager.rewriteEntries();
	}
	await manager.close();
	expect((await Bun.file(file).text()).startsWith(before)).toBe(true);
	const resumed = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
	const entry = resumed.getEntry(id);
	expect(entry?.type === "message" && entry.message.role === "assistant" && entry.message.retryRecovery).toEqual(
		recovery,
	);
	expect(resumed.getUsageStatistics().cost).toBe(3);
	await resumed.close();
});

test("retry annotations follow the selected branch without changing retained archival messages", async () => {
	const dir = TempDir.createSync("@pi-annotation-branch-");
	dirs.push(dir);
	const manager = SessionManager.create(dir.path(), dir.path());
	const original = assistant();
	original.content = [{ type: "text", text: "Unrecovered response" }];
	const id = manager.appendMessage(original);
	const retained = manager.getEntry(id);
	const recovery: AssistantRetryRecovery = {
		kind: "auto-retry",
		status: "superseded",
		attempt: 1,
		recovery: "plain",
		note: "Retried",
	};
	manager.appendRetryRecovery(id, recovery);
	const annotationId = manager.getBranch().at(-1)!.id;
	expect(original.retryRecovery).toBeUndefined();
	expect(
		retained?.type === "message" && retained.message.role === "assistant" && retained.message.retryRecovery,
	).toBeUndefined();
	const file = manager.getSessionFile()!;
	await manager.flush();
	const raw = parseSessionContent(await Bun.file(file).text()).entries.filter(entry => entry.type !== "session");
	expect(buildSessionContext(raw, annotationId).messages.some(message => message.role === "assistant")).toBe(false);
	expect(buildSessionContext(raw, id).messages.some(message => message.role === "assistant")).toBe(true);
	manager.branch(id);
	expect(manager.buildSessionContext().messages.some(message => message.role === "assistant")).toBe(true);
	manager.appendCustomEntry("other-branch");
	await manager.close();
	const resumed = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
	const beforeAnnotation = resumed.getEntry(id);
	expect(
		beforeAnnotation?.type === "message" &&
			beforeAnnotation.message.role === "assistant" &&
			beforeAnnotation.message.retryRecovery,
	).toBeUndefined();
	resumed.branch(annotationId);
	expect(resumed.buildSessionContext().messages.some(message => message.role === "assistant")).toBe(false);
	const projected = resumed.getEntry(id);
	expect(
		projected?.type === "message" && projected.message.role === "assistant" && projected.message.retryRecovery,
	).toEqual(recovery);
	expect(
		beforeAnnotation?.type === "message" &&
			beforeAnnotation.message.role === "assistant" &&
			beforeAnnotation.message.retryRecovery,
	).toBeUndefined();
	resumed.branch(id);
	expect(resumed.buildSessionContext().messages.some(message => message.role === "assistant")).toBe(true);
	await resumed.close();
});
