import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext, type BuildSessionContextOptions } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOW = Date.UTC(2026, 10, 12, 9);
type NewEntry = SessionEntry extends infer E ? E extends SessionEntry ? Omit<E, "id" | "parentId" | "timestamp"> : never : never;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
	finally { vi.restoreAllMocks(); }
});

for (const fallback of [false, true]) {
	test(`unchanged dispatch notes and actions skip archive image contents (${fallback ? "branch fallback" : "session manager"})`, async () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		const cwd = TempDir.createSync("dispatch-note-archive-");
		cleanups.push(() => cwd.removeSync());
		const loaded = await loadExtensions([path.join(import.meta.dir, "todo_dispatch.ts")], cwd.path());
		expect(loaded.errors).toEqual([]);
		const extension = loaded.extensions[0]!;
		const journal: SessionEntry[] = [];
		const deliveries: Array<{ customType: string; content: unknown }> = [];
		const add = (entry: NewEntry) => {
			const value = { ...entry, id: `entry-${journal.length}`, parentId: journal.at(-1)?.id ?? null, timestamp: new Date(NOW).toISOString() } as SessionEntry;
			journal.push(value);
			return value;
		};
		const kept = add({ type: "message", message: { role: "user", content: "Continue the plan", timestamp: NOW } });
		add({ type: "compaction", summary: "Earlier work", firstKeptEntryId: kept.id, tokensBefore: 1000,
			preserveData: { snapcompact: { frames: [{ data: "blob:sha256:fixture", mimeType: "image/png", cols: 64, rows: 40, chars: 4, font: "8x13", variant: "bw" }], totalChars: 4, truncatedChars: 0 } } });
		let reads = 0;
		const resolveFrameData = () => ({ bytes: 8, read: () => { reads++; return "ZmFrZQ=="; } });
		const titles = ["Quartz", "Birch", "Cedar", "Dune", "Elm"];
		const phases: TodoScheduleInput = [{ name: "Orchard", tasks: titles.map((content, index) => ({
			content, status: "pending", schedule: { dependencies: index ? [titles[index - 1]!] : [], cumulativeReestimateCount: index ? 0 : 4,
				estimate: { optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180, confidence: "medium", basis: "bounded work", updatedAt: NOW } },
		})) }];
		loaded.runtime.getActiveTools = () => ["todo", "task"];
		loaded.runtime.appendEntry = (customType, data) => { add({ type: "custom", customType, data: structuredClone(data) }); };
		loaded.runtime.sendMessage = message => {
			const normalized = normalizeCustomMessagePayload(message);
			add({ type: "custom_message", ...normalized });
			deliveries.push({ customType: normalized.customType, content: normalized.content });
		};
		const ctx = {
			cwd: cwd.path(),
			sessionManager: {
				getHeader: () => ({ id: "archive-dedup" }), getBranch: () => journal,
				getBranchMatching: (predicate: (entry: SessionEntry) => boolean) => journal.filter(predicate),
				getLatestBranchMatching: (predicate: (entry: SessionEntry) => boolean) => journal.findLast(predicate),
				*iterateBranchMatchingNewestFirst(predicate: (entry: SessionEntry) => boolean) {
					for (let i = journal.length - 1; i >= 0; i--) if (predicate(journal[i]!)) yield journal[i]!;
				},
				...(fallback ? {} : { buildSessionContext: (options?: BuildSessionContextOptions) => buildSessionContext(journal, undefined, undefined, { resolveFrameData, ...options }) }),
				getSessionFile: () => undefined,
			},
			getTodoSnapshot: () => phases, getTodoPhases: () => phases,
			getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
			getTaskMaxConcurrency: () => 6, getTodoPreviewConfig: () => ({ enabled: false, paths: [], openReviewPages: false }),
			isIdle: () => false, hasPendingMessages: () => false,
			setTimeout: () => ({}), clearTimer: () => {}, setInterval: () => ({}),
		} as unknown as ExtensionContext;
		const emit = async (name: string) => {
			for (const handler of extension.handlers.get(name) ?? []) await (handler as (event: object, context: ExtensionContext) => unknown)({}, ctx);
		};
		cleanups.push(() => emit("session_shutdown"));
		await emit("turn_start");
		await emit("turn_end");
		const selected = (type: string) => deliveries.filter(message => message.customType === type);
		expect(selected("todo-dispatch-action-required")).toHaveLength(1);
		expect(selected("todo-dispatch-time-note")).toHaveLength(1);
		for (let i = 0; i < 3; i++) await emit("turn_start");
		expect(selected("todo-dispatch-action-required")).toHaveLength(1);
		expect(selected("todo-dispatch-time-note")).toHaveLength(1);
		expect(reads).toBe(0);
		const messages = buildSessionContext(journal, undefined, undefined, { maxFrameDataBytes: 0 }).messages;
		for (const type of ["todo-dispatch-action-required", "todo-dispatch-time-note"]) {
			expect(messages.some(message => message.role === "custom" && message.customType === type && message.content === selected(type)[0]!.content)).toBe(true);
		}
		// Negative control: a normal model projection needs the archive frame.
		buildSessionContext(journal, undefined, undefined, { resolveFrameData });
		expect(reads).toBeGreaterThan(0);
	});
}
