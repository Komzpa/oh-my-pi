import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext, type SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";
import { TempDir } from "@oh-my-pi/pi-utils";

const ACTION = "todo-dispatch-action-required";
const RECEIPT = "todo-dispatch-action-demand";
const NOW = Date.UTC(2026, 10, 12, 9);
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

type NewEntry = SessionEntry extends infer E ? E extends SessionEntry ? Omit<E, "id" | "parentId" | "timestamp"> : never : never;
type Delivery = { customType: string; content: unknown; options: unknown; display: boolean };
type CustomContextMessage = Extract<SessionContext["messages"][number], { role: "custom" }>;

async function harness() {
	spyOn(Date, "now").mockReturnValue(NOW);
	const cwd = TempDir.createSync("dispatch-action-dedup-");
	cleanups.push(() => cwd.removeSync());
	const loaded = await loadExtensions([path.join(import.meta.dir, "todo_dispatch.ts")], cwd.path());
	expect(loaded.errors).toEqual([]);
	const extension = loaded.extensions[0]!;
	const journal: SessionEntry[] = [];
	const deliveries: Delivery[] = [];
	const titles = ["Quartz", "Birch", "Cedar", "Dune", "Elm"];
	const phases: TodoScheduleInput = [{
		name: "Orchard",
		tasks: titles.map((content, index) => ({
			content,
			status: "pending",
			schedule: {
				dependencies: index ? [titles[index - 1]!] : [],
				cumulativeReestimateCount: index ? 0 : 4,
				estimate: {
					optimisticSeconds: 60, likelySeconds: 120, pessimisticSeconds: 180,
					confidence: "medium", basis: "bounded work", updatedAt: NOW,
				},
			},
		})),
	}];
	const add = (entry: NewEntry) => {
		const value = {
			...entry, id: `entry-${journal.length}`, parentId: journal.at(-1)?.id ?? null,
			timestamp: new Date(NOW).toISOString(),
		} as SessionEntry;
		journal.push(value);
		return value;
	};
	loaded.runtime.getActiveTools = () => ["todo", "task"];
	loaded.runtime.appendEntry = (customType, data) => {
		add({ type: "custom", customType, data: structuredClone(data) });
	};
	// Delivery is immediate: dedup must inspect a message in the real model context, not an unsent queue.
	loaded.runtime.sendMessage = (message, options) => {
		const normalized = normalizeCustomMessagePayload(message);
		add({ type: "custom_message", ...normalized });
		deliveries.push({ customType: normalized.customType, content: normalized.content, display: normalized.display, options });
	};
	const ctx = {
		cwd: cwd.path(),
		sessionManager: {
			getHeader: () => ({ id: "orchard" }),
			getBranch: () => journal,
			getBranchMatching: (predicate: (entry: SessionEntry) => boolean) => journal.filter(predicate),
			getLatestBranchMatching: (predicate: (entry: SessionEntry) => boolean) => journal.findLast(predicate),
			*iterateBranchMatchingNewestFirst(predicate: (entry: SessionEntry) => boolean) {
				for (let index = journal.length - 1; index >= 0; index--) if (predicate(journal[index]!)) yield journal[index]!;
			},
			buildSessionContext: () => buildSessionContext(journal),
			getSessionFile: () => undefined,
		},
		getTodoSnapshot: () => phases,
		getTodoPhases: () => phases,
		getAsyncJobSnapshot: () => ({ running: [], recent: [], nonJobAgents: [] }),
		getTaskMaxConcurrency: () => 6,
		getTodoPreviewConfig: () => ({ enabled: false, paths: [], openReviewPages: false }),
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}), clearTimer: () => {}, setInterval: () => ({}),
	} as unknown as ExtensionContext;
	const emit = async (name: string) => {
		for (const handler of extension.handlers.get(name) ?? []) {
			await (handler as (event: object, context: ExtensionContext) => unknown)({}, ctx);
		}
	};
	cleanups.push(() => emit("session_shutdown"));
	const actions = () => deliveries.filter(message => message.customType === ACTION);
	const receipt = () => {
		const entry = journal.findLast(entry => entry.type === "custom" && entry.customType === RECEIPT);
		expect(entry?.type).toBe("custom");
		return (entry as Extract<SessionEntry, { type: "custom" }>).data as {
			key: string; action: string; misses: number; noToolMisses: number; retryAt: number;
		};
	};
	const modelActions = (): CustomContextMessage[] =>
		buildSessionContext(journal).messages.filter(
			(message): message is CustomContextMessage => message.role === "custom" && message.customType === ACTION,
		);
	const renameHead = () => {
		phases[0]!.tasks[0]!.content = "Willow";
		phases[0]!.tasks[1]!.schedule!.dependencies = ["Willow"];
	};
	return { emit, add, actions, modelActions, receipt, deliveries, renameHead };
}

test("delivered action advice stays silent on unchanged turns without skipping the ignored-turn ladder", async () => {
	const h = await harness();
	await h.emit("turn_start");
	expect(h.actions()).toHaveLength(1);
	expect(h.modelActions()).toHaveLength(1);
	expect(h.modelActions()[0]!.content as string).toEqual(h.actions()[0]!.content as string);
	await h.emit("turn_start");
	expect(h.actions()).toHaveLength(1);

	for (const [index, delay] of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000].entries()) {
		const before = h.actions().length;
		await h.emit("turn_start");
		expect(h.actions()).toHaveLength(before);
		await h.emit("turn_end");
		const misses = index + 1;
		expect(h.receipt()).toMatchObject({ misses, noToolMisses: misses, retryAt: NOW + delay });
		expect(h.actions()).toHaveLength(before + (misses === 2 || misses === 5 ? 1 : 0));
	}
	expect(h.deliveries.filter(message => message.customType === "todo-dispatch-ignored")).toHaveLength(1);
	for (const message of h.actions()) {
		expect(message).toMatchObject({ display: false, options: { deliverAs: "aside", triggerTurn: false, interruptWait: false, supersedes: ACTION } });
		expect(h.modelActions().some(delivered => delivered.content === message.content)).toBe(true);
	}
});

test("turn-start delivers a changed action even when earlier advice survived in the model context", async () => {
	const h = await harness();
	await h.emit("turn_start");
	await h.emit("turn_end");
	const before = h.actions().length;
	const oldKey = h.receipt().key;
	h.renameHead();
	await h.emit("turn_start");
	expect(h.actions()).toHaveLength(before + 1);
	expect(h.actions().at(-1)!.content).toContain("Willow");
	expect(h.actions().at(-1)!.content).not.toEqual(h.actions()[0]!.content);
	expect(h.receipt().key).not.toBe(oldKey);
	expect(h.modelActions().at(-1)!.content as string).toEqual(h.actions().at(-1)!.content as string);
});

test("turn-end delivers an action changed during the turn and rearms its miss counter", async () => {
	const h = await harness();
	await h.emit("turn_start");
	const before = h.actions().length;
	h.renameHead();
	await h.emit("turn_end");
	expect(h.actions()).toHaveLength(before + 1);
	expect(h.actions().at(-1)!.content).toContain("Willow");
	expect(h.receipt()).toMatchObject({ misses: 1, noToolMisses: 1, retryAt: NOW + 60_000 });
	expect(h.modelActions().at(-1)!.content as string).toEqual(h.actions().at(-1)!.content as string);
	await h.emit("turn_start");
	expect(h.actions()).toHaveLength(before + 1);
});

test("compaction rearms dropped advice without resetting the durable ignored-turn ladder", async () => {
	const h = await harness();
	for (let turn = 0; turn < 3; turn++) {
		await h.emit("turn_start");
		await h.emit("turn_end");
	}
	const before = h.actions().length;
	const kept = h.add({ type: "message", message: { role: "user", content: "Continue orchard work.", timestamp: NOW } });
	h.add({ type: "compaction", summary: "Earlier orchard advice was compacted.", firstKeptEntryId: kept.id, tokensBefore: 20_000 });
	await h.emit("session_compact");
	expect(h.modelActions()).toHaveLength(0);
	await h.emit("turn_start");
	expect(h.actions()).toHaveLength(before + 1);
	expect(h.modelActions()).toHaveLength(1);
	expect(h.receipt().misses).toBe(3);
	await h.emit("turn_end");
	expect(h.receipt()).toMatchObject({ misses: 4, noToolMisses: 4, retryAt: NOW + 480_000 });
	expect(h.actions()).toHaveLength(before + 1);
	await h.emit("turn_start");
	await h.emit("turn_end");
	expect(h.receipt()).toMatchObject({ misses: 5, noToolMisses: 5, retryAt: NOW + 900_000 });
	expect(h.actions()).toHaveLength(before + 2);
	expect(h.deliveries.filter(message => message.customType === "todo-dispatch-ignored")).toHaveLength(1);
});
