import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TodoScheduleInput } from "@oh-my-pi/pi-tui/tools/todo-schedule";

// Measured from the original extension at this revision after fixing estimate.updatedAt in these 48 snapshots.
// Remeasure with DISPATCH_VOLUME_MEASURE_BASELINE=1 after any scenario change; never estimate or rescale this count.
const BASELINE = "3e7573ba38dfb98693d71d681f0d7205b7609cf8";
const BASELINE_CHARACTERS = 304325;
// SHA-256 of JSON.stringify(snapshots()), including schedule inputs, clocks, job states, compaction, and task-result events.
const BASELINE_SCENARIO_SHA256 = "3478fc35b033ce5f0d3c231b80bf798bd234ce857b4504e3cb85bd46f66422f3";
const ROOT = path.resolve(import.meta.dir, "../../..");
const EXTENSIONS = "packages/reemxy-extensions/extensions/";
const NOTE = "todo-dispatch-time-note";
const START = Date.UTC(2026, 10, 12, 9);
const STEPS = 48;
const COMPACT_AT = 24;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type NewEntry = SessionEntry extends infer E ? E extends SessionEntry ? Omit<E, "id" | "parentId" | "timestamp"> : never : never;
type Snapshot = { phases: TodoScheduleInput; changed: number[]; now: number; compact: boolean; taskResult: object | null; jobs: object };
type Delivery = { content: string; options: unknown };
type Replay = { deliveries: Delivery[][]; characters: number; retainedAtCompaction: string[][] };
type VolumeControl = "full-notes" | "drop-change" | "ignore-compaction" | "trust-retained-delta";

function snapshots(): Snapshot[] {
	const phases: TodoScheduleInput = [{
		name: "Neutral delivery",
		tasks: Array.from({ length: 18 }, (_, index) => ({
			content: `Deliver item ${String(index + 1).padStart(2, "0")}`,
			status: index < 2 ? "in_progress" as const : "blocked" as const,
			...(index < 2 ? {} : { blocker: `External approval ${index}, revision 0` }),
			schedule: {
				owner: index < 2 ? `Worker${index + 1}` : `GateOwner${index}`,
				dependencies: [],
				estimate: { optimisticSeconds: 3600, likelySeconds: 7200, pessimisticSeconds: 14400, confidence: "medium" as const, basis: "Independent fixture deliverable", updatedAt: START },
			},
		})),
	}];
	return Array.from({ length: STEPS }, (_, step) => {
		const changed: number[] = [];
		if (step > 0) {
			const index = step >= 35 && step <= 37 ? 2 : 2 + (step - 1) % 16;
			const row = phases[0]!.tasks[index]!;
			row.blocker = `External approval ${index}, revision ${step}`;
			changed.push(index);
			if (step % 3 === 0) {
				const other = 2 + step % 16;
				phases[0]!.tasks[other]!.schedule!.owner = `GateOwner${other}Revision${step}`;
				changed.push(other);
			}
			// A real NEXT ACTION appears and disappears, not only changed WAIT prose.
			if (step === 10 || step === 30) {
				row.status = "pending";
				delete row.blocker;
			}
			if (step === 11 || step === 31) {
				const previous = 2 + (step - 2) % 16;
				phases[0]!.tasks[previous]!.status = "blocked";
				phases[0]!.tasks[previous]!.blocker = `External approval ${previous}, revision ${step}`;
				changed.push(previous);
			}
			if (step >= 35 && step <= 37) {
				row.status = "pending";
				delete row.blocker;
				row.schedule!.owner = "ReturnedWorker";
				row.schedule!.executor = {
					workerId: "ReturnedWorker", agentProfile: "researcher", startedAt: START,
					...(step === 35 ? {} : { finishedAt: START + step * 1000, outcome: step === 36 ? "completed" as const : "failed" as const }),
				};
			}
		}
		return {
			phases: structuredClone(phases), changed: [...new Set(changed)], now: START + step * 1000, compact: step === COMPACT_AT,
			taskResult: step === 37 ? { toolName: "task", toolCallId: "refused-dispatch", input: { tasks: [{ name: "ContinueItem", task: "Deliver item 03" }] }, content: [{ type: "text", text: "Dispatch refused: assigned resource is unavailable." }], isError: true } : null,
			jobs: {
				running: [1, 2].map(index => ({ id: `Worker${index}`, agentId: `Worker${index}`, type: "task", status: "running", label: `Deliver item 0${index}`, startTime: START })),
				recent: step >= 36 ? [{ id: "ReturnedWorker", agentId: "ReturnedWorker", type: "task", status: step === 36 ? "completed" : "failed", label: "Deliver item 03", startTime: START, endTime: START + step * 1000 }] : [], nonJobAgents: [],
			},
		};
	});
}

async function baselineSource(): Promise<string> {
	const dir = TempDir.createSync("dispatch-volume-baseline-");
	cleanups.push(() => dir.removeSync());
	const sourceRoot = path.resolve(dir.path());
	await fs.symlink(path.join(ROOT, "node_modules"), path.join(sourceRoot, "node_modules"), "dir");
	const repo = vcs.requireGit(ROOT);
	const files = await repo.lsTree(BASELINE, [EXTENSIONS]);
	for (const file of files) {
		if (!/\.(ts|md|json)$/.test(file) || file.endsWith(".test.ts") || file.includes("/fixtures/")) continue;
		const blob = await repo.showBlob(`${BASELINE}:${file}`, 4 * 1024 * 1024);
		if (blob.truncated) throw new Error(`Truncated baseline module: ${file}`);
		await Bun.write(path.join(sourceRoot, file), blob.data);
	}
	return path.join(sourceRoot, EXTENSIONS, "todo_dispatch.ts");
}

async function mutatedSource(control: VolumeControl): Promise<string> {
	const dir = TempDir.createSync("dispatch-volume-mutation-");
	cleanups.push(() => dir.removeSync());
	const sourceRoot = path.resolve(dir.path());
	await fs.symlink(path.join(ROOT, "node_modules"), path.join(sourceRoot, "node_modules"), "dir");
	const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(ROOT, EXTENSIONS), onlyFiles: true }));
	for (const relative of files) {
		const file = `${EXTENSIONS}${relative}`;
		if (!/\.(ts|md|json)$/.test(file) || file.endsWith(".test.ts") || file.includes("/fixtures/")) continue;
		let source = await Bun.file(path.join(ROOT, file)).text();
		if (file === `${EXTENSIONS}lead_time_notes.ts` && (control === "full-notes" || control === "drop-change")) {
			const original = "const changed = blocks.filter(block => previous?.rows[block.row] !== block.sig);";
			if (!source.includes(original)) throw new Error("Update the production mutation target after the delta implementation changes");
			source = source.replace(original, control === "full-notes" ? "const changed = blocks;" : "const changed = previous ? [] : blocks;");
		}
		if (file === `${EXTENSIONS}lead_time_notes.ts` && control === "trust-retained-delta") {
			const original = "details.contextBoundary !== noteContextBoundary(messages) || ";
			if (!source.includes(original)) throw new Error("Update the retained-delta mutation target after the boundary implementation changes");
			source = source.replace(original, "");
		}
		if (file === `${EXTENSIONS}todo_dispatch.ts` && control === "ignore-compaction") {
			const original = "const modelContext = ctx.sessionManager.buildSessionContext?.() ?? buildSessionContext(ctx.sessionManager.getBranch());";
			if (!source.includes(original)) throw new Error("Update the compaction mutation target after the context implementation changes");
			source = source.replace(original, 'const modelContext = buildSessionContext(ctx.sessionManager.getBranch().filter(entry => entry.type !== "compaction"));');
		}
		await Bun.write(path.join(sourceRoot, file), source);
	}
	return path.join(sourceRoot, EXTENSIONS, "todo_dispatch.ts");
}

async function replay(extensionPath: string, input: Snapshot[], retainLatestNoteAtCompaction = false): Promise<Replay> {
	const cwd = TempDir.createSync("dispatch-volume-replay-");
	cleanups.push(() => cwd.removeSync());
	const replayCwd = path.resolve(cwd.path());
	const loaded = await loadExtensions([extensionPath], replayCwd);
	expect(loaded.errors).toEqual([]);
	const extension = loaded.extensions[0]!;
	const journal: SessionEntry[] = [];
	let now = START;
	let step = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const deliveries: Delivery[][] = input.map(() => []);
	const retainedAtCompaction: string[][] = [];
	const add = (entry: NewEntry) => {
		const value = { ...entry, id: `entry-${journal.length}`, parentId: journal.at(-1)?.id ?? null, timestamp: new Date(now).toISOString() } as SessionEntry;
		journal.push(value);
		return value;
	};
	loaded.runtime.getActiveTools = () => ["todo", "task"];
	loaded.runtime.appendEntry = (customType, data) => { add({ type: "custom", customType, data: structuredClone(data) }); };
	loaded.runtime.sendMessage = (message, options) => {
		const normalized = normalizeCustomMessagePayload(message);
		add({ type: "custom_message", ...normalized });
		if (normalized.customType === NOTE) {
			expect(typeof normalized.content).toBe("string");
			deliveries[step]!.push({ content: normalized.content as string, options });
		}
	};
	const ctx = {
		cwd: replayCwd,
		sessionManager: {
			getHeader: () => ({ id: "volume-replay" }),
			getBranch: () => journal,
			getBranchMatching: (predicate: (entry: SessionEntry) => boolean) => journal.filter(predicate),
			getLatestBranchMatching: (predicate: (entry: SessionEntry) => boolean) => journal.findLast(predicate),
			*iterateBranchMatchingNewestFirst(predicate: (entry: SessionEntry) => boolean) {
				for (let index = journal.length - 1; index >= 0; index--) if (predicate(journal[index]!)) yield journal[index]!;
			},
			buildSessionContext: () => buildSessionContext(journal),
			getSessionFile: () => undefined,
		},
		getTodoSnapshot: () => input[step]!.phases,
		getTodoPhases: () => input[step]!.phases,
		getAsyncJobSnapshot: () => input[step]!.jobs,
		getTaskMaxConcurrency: () => 3,
		getTodoPreviewConfig: () => ({ enabled: false, openReviewPages: false }),
		isIdle: () => false,
		hasPendingMessages: () => false,
		setTimeout: () => ({}), clearTimer: () => {},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: object = {}) => {
		for (const handler of extension.handlers.get(name) ?? []) {
			await (handler as (event: object, context: ExtensionContext) => unknown)(event, ctx);
		}
	};
	try {
		for (step = 0; step < input.length; step++) {
			now = input[step]!.now;
			const kept = add({ type: "message", message: { role: "toolResult", toolName: "todo", toolCallId: `snapshot-${step}`, content: [], isError: false, details: { phases: input[step]!.phases }, timestamp: now } });
			if (input[step]!.compact) {
				const retained = retainLatestNoteAtCompaction ? journal.findLast(entry => entry.type === "custom_message" && entry.customType === NOTE) : undefined;
				add({ type: "compaction", summary: "Earlier delivery state was compacted.", firstKeptEntryId: retained?.id ?? kept.id, tokensBefore: 20000 });
				retainedAtCompaction.push(buildSessionContext(journal).messages.flatMap(message => message.role === "custom" && message.customType === NOTE ? [message.content as string] : []));
				await emit("session_compact");
			}
			if (input[step]!.taskResult) await emit("tool_result", input[step]!.taskResult!);
			await emit("turn_end");
			const modelContext = buildSessionContext(journal).messages;
			for (const delivery of deliveries[step]!) {
				expect(modelContext.some(message => message.role === "custom" && message.customType === NOTE && message.content === delivery.content)).toBe(true);
				expect(delivery.options).toMatchObject({ triggerTurn: false, interruptWait: false });
			}
		}
	} finally {
		step = input.length - 1;
		await emit("session_shutdown");
		clock.mockRestore();
	}
	return { deliveries, characters: deliveries.flat().reduce((sum, delivery) => sum + delivery.content.length, 0), retainedAtCompaction };
}

// Controls mutate production selection or compaction handling inside a disposable source tree; assertions stay unchanged.
// DISPATCH_VOLUME_CONTROL=full-notes bun test packages/reemxy-extensions/extensions/dispatch-volume-replay.test.ts
// DISPATCH_VOLUME_CONTROL=drop-change bun test packages/reemxy-extensions/extensions/dispatch-volume-replay.test.ts
// DISPATCH_VOLUME_CONTROL=ignore-compaction bun test packages/reemxy-extensions/extensions/dispatch-volume-replay.test.ts
test("48 delivered note snapshots retain changed-row instructions within one quarter of the measured old volume", async () => {
	const input = snapshots();
	const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex");
	if (process.env.DISPATCH_VOLUME_MEASURE_BASELINE === "1") {
		// Optional provenance check requires the historical Git object; ordinary CI needs no Git history.
		const baseline = await replay(await baselineSource(), input);
		console.info(`Measured original dispatch notes: characters=${baseline.characters}, scenarioSha256=${fingerprint}, revision=${BASELINE}`);
		expect(baseline.deliveries.every(batch => batch.length > 0)).toBe(true);
		expect(baseline.characters).toBe(BASELINE_CHARACTERS);
	}
	expect(fingerprint, "Replay scenario changed: remeasure the original extension and update both baseline fixture values").toBe(BASELINE_SCENARIO_SHA256);
	const control = process.env.DISPATCH_VOLUME_CONTROL;
	if (control && control !== "full-notes" && control !== "drop-change" && control !== "ignore-compaction" && control !== "trust-retained-delta") throw new Error(`Unknown volume control: ${control}`);
	const candidatePath = control ? await mutatedSource(control as VolumeControl) : path.join(import.meta.dir, "todo_dispatch.ts");
	const candidate = await replay(candidatePath, input);
	const sharedParagraph = "Change a running worker’s scope with todo schedule resources; its next write uses the current row, so never kill or redispatch it to change scope.";
	const occurrences = (content: string) => content.split(sharedParagraph).length - 1;
	for (const [step, batch] of candidate.deliveries.entries()) {
		for (const delivery of batch) expect(occurrences(delivery.content), `step ${step}: shared paragraph repeated in one note`).toBeLessThanOrEqual(1);
	}
	for (const [start, end] of [[0, COMPACT_AT], [COMPACT_AT, input.length]] as const) {
		const notes = candidate.deliveries.slice(start, end).flat();
		expect(notes.reduce((count, note) => count + occurrences(note.content), 0), `window starting at ${start}: shared paragraph`).toBe(1);
		expect(occurrences(candidate.deliveries[start]!.map(note => note.content).join("\n")), `first note at ${start}: shared paragraph`).toBe(1);
	}
	for (let step = 0; step < input.length; step++) {
		const snapshot = input[step]!;
		const required = step === 0 || snapshot.compact ? snapshot.phases[0]!.tasks.map((_, index) => index) : snapshot.changed;
		const content = candidate.deliveries[step]!.map(delivery => delivery.content).join("\n");
		for (const index of required) {
			const row = snapshot.phases[0]!.tasks[index]!;
			const marker = `Row ${JSON.stringify(row.content)} [`;
			expect(content, `step ${step}, ${row.content}: changed rows need full instructions`).toContain(marker);
			const start = content.indexOf(marker);
			const next = content.indexOf("\nRow ", start + marker.length);
			const instruction = content.slice(start, next < 0 ? undefined : next);
			if (row.status === "blocked") {
				expect(instruction).toContain(`WAIT: external gate ${row.blocker} still holds.`);
				expect(instruction).toContain('todo {op:"unblock",task:');
			} else if (row.status === "pending") {
				expect(instruction).toContain(`task:${JSON.stringify(row.content)},name:`);
				expect(instruction).toContain("NEXT ACTION:");
			} else {
				expect(instruction).toContain("its worker is running. Results arrive automatically.");
			}
		}
		if (step >= 35 && step <= 37) {
			expect(content).toContain(`Reason: ${step === 35 ? "lost" : step === 36 ? "findings" : "failed"}.`);
			expect(content).toContain("agent://ReturnedWorker");
		}
		if (step === 37) expect(content).toContain("The last task dispatch was refused; bounded work is open to you");
	}
	console.info(`Dispatch note replay: ${candidate.characters} candidate characters / ${BASELINE_CHARACTERS} measured baseline characters (${BASELINE}); control=${control ?? "none"}`);
	expect(candidate.characters, `delivered characters: candidate=${candidate.characters}, measured baseline=${BASELINE_CHARACTERS}, baseline revision=${BASELINE}`).toBeLessThanOrEqual(BASELINE_CHARACTERS * 0.25);
}, 60_000);

// DISPATCH_VOLUME_CONTROL=trust-retained-delta bun test packages/reemxy-extensions/extensions/dispatch-volume-replay.test.ts
test("first note after compaction restores full instructions when only a cumulative delta survives", async () => {
	const input = snapshots().slice(0, 4);
	for (let step = 0; step < input.length; step++) {
		input[step]!.compact = step === 2;
		if (step >= 2) input[step]!.phases = structuredClone(input[1]!.phases);
	}
	// Compaction must force delivery despite an unchanged semantic key and the five-minute timer.
	input[3]!.now = input[2]!.now + 5 * 60_000;
	const control = process.env.DISPATCH_VOLUME_CONTROL;
	const candidatePath = control === "trust-retained-delta" ? await mutatedSource(control) : path.join(import.meta.dir, "todo_dispatch.ts");
	const candidate = await replay(candidatePath, input, true);
	const content = (step: number) => candidate.deliveries[step]!.map(note => note.content).join("\n");
	const sharedParagraph = "Change a running worker’s scope with todo schedule resources; its next write uses the current row, so never kill or redispatch it to change scope.";
	expect(content(0)).toContain(sharedParagraph);
	expect(content(1)).not.toContain(sharedParagraph);
	expect(content(1)).not.toContain('Row "Deliver item 01" [');
	// The real context builder retained the delta, not its original full source note.
	expect(candidate.retainedAtCompaction).toEqual([[content(1)]]);
	for (const row of input[2]!.phases[0]!.tasks) {
		expect(content(2), `${row.content}: first post-compaction note must restore full instructions`).toContain(`Row ${JSON.stringify(row.content)} [`);
		if (row.status === "blocked") expect(content(2)).toContain(`WAIT: external gate ${row.blocker} still holds.`);
	}
	expect(content(2)).toContain(sharedParagraph);
	// The reset happens once; a later note in the same canonical window deduplicates again.
	expect(candidate.deliveries[3]!.length).toBeGreaterThan(0);
	expect(content(3)).not.toContain(sharedParagraph);
	expect(content(3)).not.toContain('Row "Deliver item 01" [');
}, 60_000);
