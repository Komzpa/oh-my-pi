/**
 * Behavioral contract for reasoned requirement relink (PR #41 amendment path).
 *
 * These tests deliberately exercise the externally observable contract only:
 * classifyRequirement and TodoTool classify with `relink: true`, persisted ledger
 * readback, and the todo view history. They fail until the canonical writer
 * (requirements-ledger.ts / todo.ts) lands the relink amendment implementation.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	RequirementsLedgerRuntime,
	type RequirementPublicationGate,
} from "@oh-my-pi/pi-coding-agent/session/requirements-ledger-runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	appendRequirementsSnapshot,
	getLatestRequirements,
	getRequirementRowVerdict,
	parseRequirementsLedger,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import type { RequirementLedgerItem, RequirementVerdict } from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { TodoTool, observeLatestTodoPhases } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { classifyTodoSchema } from "../../src/tools/todo-classify-schema";

const AT = "2026-10-12T09:00:00.000Z";
const RECEIVED_AT = "2026-10-12T10:00:00.000Z";
const REASON = "R3 covers mail, Drive and Photos import, not the Gmail API credential lookup";
const ROW_A = "Find Gmail API import credential";
const ROW_B = "Import mail history";
const ROW_C = "Import Drive and Photos media";

interface RequirementRelinkAmendment {
	at: string;
	oldRows: string[];
	newRows: string[];
	reason: string;
}
type AmendedRequirement = RequirementLedgerItem & { amendments?: RequirementRelinkAmendment[] };

function receipt(rowChangeId: string): RequirementVerdict {
	return {
		status: "pass",
		evidence: "qa-auditor verified the row artifact",
		artifact: "b".repeat(40),
		workerId: "qa-auditor",
		auditor: "qa-auditor",
		receivedAt: RECEIVED_AT,
		rowChangeId,
	};
}

function linkedItem(
	id: string,
	rawText: string,
	rows: string[],
	rowVerdicts?: Record<string, RequirementVerdict>,
): RequirementLedgerItem {
	return {
		id,
		at: AT,
		rawText,
		classification: "linked",
		rows: [...rows],
		...(rowVerdicts ? { rowVerdicts } : {}),
	};
}

function seedMislinked(manager: SessionManager): void {
	appendRequirementsSnapshot({ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) }, [
		linkedItem("R1", "credential lookup ask", [ROW_A], { [ROW_A]: receipt("1") }),
		{ id: "R2", at: AT, rawText: "unrelated candidate ask", classification: "candidate", rows: [] },
		linkedItem("R3", "mail+Drive+Photos", [ROW_A, ROW_B], {
			[ROW_A]: receipt("2"),
			[ROW_B]: receipt("3"),
		}),
	]);
}

function harness() {
	const manager = SessionManager.inMemory();
	let phases: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: ROW_A, status: "pending" },
				{ content: ROW_B, status: "pending" },
				{ content: ROW_C, status: "pending" },
			],
		},
	];
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		getSessionSpawns: () => "*",
		sessionManager: manager,
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
	// The tests' cast boundary: classify payloads keep their real shape here.
	const rawTool = new TodoTool(session);
	const tool = {
		execute: (name: string, params: Record<string, unknown>) => rawTool.execute(name, params as never),
	};
	const snapshots = () =>
		manager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE).length;
	return { manager, tool, snapshots };
}

function textOf(result: { content: unknown }): string {
	return (result.content as Array<{ type: string; text?: string }>)
		.map(part => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
}

function r3Of(manager: SessionManager): AmendedRequirement {
	const item = getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === "R3");
	if (!item) throw new Error("R3 missing from persisted ledger");
	return item as AmendedRequirement;
}

describe("reasoned requirement relink", () => {
	it("relinks a linked requirement to new rows and records the amendment with old rows and reason", async () => {
		const { manager, tool } = harness();
		seedMislinked(manager);
		const result = await tool.execute("relink", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B, ROW_C],
			reason: REASON,
			relink: true,
		});
		expect(result.isError).toBeUndefined();
		const r3 = r3Of(manager);
		expect(r3.rows).toEqual([ROW_B, ROW_C]);
		expect(r3.amendments).toHaveLength(1);
		const amendment = r3.amendments![0]!;
		expect(amendment.oldRows).toEqual([ROW_A, ROW_B]);
		expect(amendment.newRows).toEqual([ROW_B, ROW_C]);
		expect(amendment.reason).toBe(REASON);
		expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(amendment.at)).toBe(true);
		// Immutable identity survives the relink.
		expect([r3.id, r3.rawText, r3.at]).toEqual(["R3", "mail+Drive+Photos", AT]);
		expect(
			parseRequirementsLedger({ version: 1, requirements: getLatestRequirements(manager.getBranch()) }),
		).toBeDefined();
	});

	it("keeps intersection and other-requirement receipts usable while invalidating affected rows", async () => {
		const { manager, tool } = harness();
		seedMislinked(manager);
		const relinked = await tool.execute("relink", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B, ROW_C],
			reason: REASON,
			relink: true,
		});
		expect(relinked.isError).toBeUndefined();
		const r3 = r3Of(manager);
		// Retained row keeps its receipt.
		expect(getRequirementRowVerdict(r3, ROW_B)?.receivedAt).toBe(RECEIVED_AT);
		// Dropped row's receipt is invalidated; the added row gets no receipt.
		expect(getRequirementRowVerdict(r3, ROW_A)).toBeUndefined();
		expect(getRequirementRowVerdict(r3, ROW_C)).toBeUndefined();
		// The untouched other requirement's receipt stays usable.
		const r1 = getLatestRequirements(manager.getBranch()).find(requirement => requirement.id === "R1")!;
		expect(getRequirementRowVerdict(r1, ROW_A)?.receivedAt).toBe(RECEIVED_AT);
	});

	it("refuses a relink without a reason and persists nothing", async () => {
		const { manager, tool, snapshots } = harness();
		seedMislinked(manager);
		const before = snapshots();
		for (const params of [
			{ op: "classify", id: "R3", classification: "linked", rows: [ROW_C], relink: true },
			{ op: "classify", id: "R3", classification: "linked", rows: [ROW_C], relink: true, reason: "   " },
		]) {
			const result = await tool.execute("no-reason", params as never);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("reason");
			expect(snapshots()).toBe(before);
			expect(r3Of(manager).rows).toEqual([ROW_A, ROW_B]);
			expect(r3Of(manager).amendments).toBeUndefined();
		}
	});

	it("refuses a relink to empty rows so it cannot unlink to zero rows", async () => {
		const { manager, tool, snapshots } = harness();
		seedMislinked(manager);
		const before = snapshots();
		const result = await tool.execute("empty-rows", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [],
			reason: REASON,
			relink: true,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("row");
		expect(snapshots()).toBe(before);
		expect(r3Of(manager).rows).toEqual([ROW_A, ROW_B]);
		expect(r3Of(manager).amendments).toBeUndefined();
	});

	it("keeps ordinary classification write-once for a linked requirement", async () => {
		const { manager, tool } = harness();
		seedMislinked(manager);
		// Negative control: without relink, a linked requirement stays write-once.
		const ordinary = await tool.execute("reclassify", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_C],
		});
		expect(ordinary.isError).toBe(true);
		expect(textOf(ordinary)).toContain("already been classified");
		expect(r3Of(manager).rows).toEqual([ROW_A, ROW_B]);
	});

	it("keeps previous rows and reason in the persisted ledger and the todo view history", async () => {
		const { manager, tool } = harness();
		seedMislinked(manager);
		const relinked = await tool.execute("relink", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B, ROW_C],
			reason: REASON,
			relink: true,
		});
		expect(relinked.isError).toBeUndefined();
		// Persisted readback keeps the full amendment history.
		const r3 = r3Of(manager);
		expect(r3.amendments).toHaveLength(1);
		expect(r3.amendments![0]!.oldRows).toEqual([ROW_A, ROW_B]);
		expect(r3.amendments![0]!.reason).toBe(REASON);
		// The todo view surfaces the same history: the reason and the previous rows.
		const view = await tool.execute("view", { op: "view" });
		const viewText = textOf(view);
		expect(viewText).toContain("R3");
		expect(viewText).toContain(REASON);
		expect(viewText).toContain(JSON.stringify(ROW_A));
	});

	it("keeps relink history isolated between concurrent TodoTool instances", async () => {
		const amended = harness();
		const untouched = harness();
		seedMislinked(amended.manager);
		seedMislinked(untouched.manager);
		const relinked = await amended.tool.execute("relink", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B, ROW_C],
			reason: REASON,
			relink: true,
		});
		expect(relinked.isError).toBeUndefined();
		const amendedSnapshots = amended.snapshots();
		const untouchedSnapshots = untouched.snapshots();
		// Both calls start before either settles; exercise both session orderings.
		const [plainFirst, amendedSecond] = await Promise.all([
			untouched.tool.execute("plain-first", { op: "view" }),
			amended.tool.execute("amended-second", { op: "view" }),
		]);
		const [amendedFirst, plainSecond] = await Promise.all([
			amended.tool.execute("amended-first", { op: "view" }),
			untouched.tool.execute("plain-second", { op: "view" }),
		]);
		for (const view of [plainFirst, plainSecond]) {
			expect(view.isError).toBeUndefined();
			expect(textOf(view)).not.toContain("relinked at");
			expect(textOf(view)).not.toContain(REASON);
		}
		for (const view of [amendedFirst, amendedSecond]) {
			expect(view.isError).toBeUndefined();
			expect(textOf(view)).toContain("R3 relinked at");
			expect(textOf(view)).toContain(REASON);
		}
		expect(r3Of(untouched.manager).amendments).toBeUndefined();
		expect(amended.snapshots()).toBe(amendedSnapshots);
		expect(untouched.snapshots()).toBe(untouchedSnapshots);
	});

	it("materializes retained-row receipts from a legacy all-row verdict before dropping it", async () => {
		const { manager, tool } = harness();
		appendRequirementsSnapshot({ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) }, [
			linkedItem("R1", "credential lookup ask", [ROW_A], { [ROW_A]: receipt("1") }),
			{
				id: "R3",
				at: AT,
				rawText: "mail+Drive+Photos",
				classification: "linked",
				rows: [ROW_A, ROW_B],
				verdict: { ...receipt("7"), artifact: `${ROW_A} @ ${"b".repeat(40)}; ${ROW_B} @ ${"b".repeat(40)}` },
			},
		]);
		const relinked = await tool.execute("relink", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B, ROW_C],
			reason: REASON,
			relink: true,
		});
		expect(relinked.isError).toBeUndefined();
		const r3 = r3Of(manager);
		// The all-row legacy receipt is removed after retained rows are materialized.
		expect(r3.verdict).toBeUndefined();
		expect(getRequirementRowVerdict(r3, ROW_B)?.receivedAt).toBe(RECEIVED_AT);
		// A legacy receipt cannot carry to a newly linked row.
		expect(getRequirementRowVerdict(r3, ROW_C)).toBeUndefined();
	});
});

describe("classify todo schema relink flag", () => {
	it("accepts a boolean relink flag with a reason and rejects a non-boolean relink", () => {
		const accepted = classifyTodoSchema({
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B],
			reason: REASON,
			relink: true,
		});
		expect(accepted instanceof type.errors).toBe(false);
		const rejected = classifyTodoSchema({
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [ROW_B],
			reason: REASON,
			relink: "true",
		});
		expect(rejected instanceof type.errors).toBe(true);
	});
});

describe("owner-backed requirement supersession", () => {
	const foldRow = "Fold cancelled branch rows";
	const cancellation = "Cancel the fold rows; the owner reset the scope";
	const resetAt = "2026-10-12T09:01:00.000Z";

	async function scopeReset() {
		const fixture = harness();
		await fixture.tool.execute("fold-plan", { op: "init", items: [foldRow] });
		appendRequirementsSnapshot(
			{ appendEntry: (customType, data) => fixture.manager.appendCustomEntry(customType, data) },
			[
				linkedItem("R5", "Fold the branch rows", [foldRow]),
				{
					id: "R14",
					at: resetAt,
					rawText: cancellation,
					classification: "not-a-requirement",
					rows: [],
					reason: "Owner cancellation",
				},
			],
		);
		return fixture;
	}

	it("reclassifies cancelled R5 by R14, retaining history and removing its publication gate", async () => {
		const { manager, tool, snapshots } = await scopeReset();
		let gate: RequirementPublicationGate | undefined;
		const notices: string[] = [];
		const runtime = new RequirementsLedgerRuntime({
			agent: {} as never,
			agentKind: () => "main",
			cwd: () => "/tmp",
			sessionManager: manager,
			onSettledAssistantMessage: () => {},
			queueModelNotice: notice => {
				notices.push(notice);
			},
			setPublicationGate: next => {
				gate = next;
			},
		});
		const message = { content: [{ type: "text", text: "Scope reset applied" }], stopReason: "stop" } as never;
		const publication = gate!;
		expect((await publication(message, new AbortController().signal))?.replacementText).toContain(
			"Not audit-verified",
		);
		expect(notices.join("\n")).toContain("R5");
		expect((await tool.execute("blocked-fold", { op: "done", task: foldRow })).isError).toBe(true);
		const before = snapshots();
		const result = await tool.execute("cancel-fold", {
			op: "classify",
			id: "R5",
			classification: "not-a-requirement",
			supersededBy: "R14",
			reason: cancellation,
		});
		expect(result.isError).toBeUndefined();
		const current = getLatestRequirements(manager.getBranch()).find(item => item.id === "R5")!;
		expect([current.classification, current.rows, current.rawText, current.at]).toEqual([
			"not-a-requirement",
			[],
			"Fold the branch rows",
			AT,
		]);
		expect(current.amendments).toEqual([
			expect.objectContaining({
				supersededBy: "R14",
				oldClassification: "linked",
				newClassification: "not-a-requirement",
				oldRows: [foldRow],
				newRows: [],
				reason: cancellation,
			}),
		]);
		expect(snapshots()).toBe(before + 1);
		const history = manager.getBranch().flatMap(entry => {
			if (entry.type !== "custom" || entry.customType !== REQUIREMENTS_LEDGER_CUSTOM_TYPE) return [];
			return parseRequirementsLedger(entry.data)?.requirements.filter(item => item.id === "R5") ?? [];
		});
		expect(history.map(item => item.classification)).toEqual(["linked", "not-a-requirement"]);
		runtime.syncPublicationGate();
		expect(await publication(message, new AbortController().signal)).toBeUndefined();
		expect((await tool.execute("retired-fold", { op: "done", task: foldRow })).isError).toBeUndefined();
		const view = await tool.execute("history", { op: "view" });
		expect(textOf(view)).toContain("R14");
		expect(textOf(view)).toContain(cancellation);
	});

	it("refuses a classification change without a newer owner statement and a reason", async () => {
		const { manager, tool, snapshots } = await scopeReset();
		appendRequirementsSnapshot({ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) }, [
			...getLatestRequirements(manager.getBranch()),
			{
				id: "R4",
				at: AT,
				rawText: "Earlier scope",
				classification: "not-a-requirement",
				rows: [],
				reason: "Earlier statement",
			},
		]);
		const before = snapshots();
		for (const options of [
			{ reason: cancellation },
			{ supersededBy: "R99", reason: cancellation },
			{ supersededBy: "R5", reason: cancellation },
			{ supersededBy: "R4", reason: cancellation },
			{ supersededBy: "R14", reason: " " },
		]) {
			const result = await tool.execute("unauthorised-reset", {
				op: "classify",
				id: "R5",
				classification: "not-a-requirement",
				...options,
			});
			expect(result.isError).toBe(true);
			expect(snapshots()).toBe(before);
			expect(getLatestRequirements(manager.getBranch()).find(item => item.id === "R5")?.classification).toBe(
				"linked",
			);
		}
	});

	it("requires fresh owner authority for reactivation and keeps both amendments", async () => {
		const { manager, tool, snapshots } = await scopeReset();
		expect(
			(
				await tool.execute("cancel", {
					op: "classify",
					id: "R5",
					classification: "not-a-requirement",
					supersededBy: "R14",
					reason: cancellation,
				})
			).isError,
		).toBeUndefined();
		const before = snapshots();
		expect(
			(
				await tool.execute("reuse-owner", {
					op: "classify",
					id: "R5",
					classification: "linked",
					rows: [foldRow],
					supersededBy: "R14",
					reason: "Undo cancellation",
				})
			).isError,
		).toBe(true);
		expect(snapshots()).toBe(before);
		appendRequirementsSnapshot({ appendEntry: (customType, data) => manager.appendCustomEntry(customType, data) }, [
			...getLatestRequirements(manager.getBranch()),
			{
				id: "R16",
				at: "2026-10-12T09:02:00.000Z",
				rawText: "Resume folding R5",
				classification: "not-a-requirement",
				rows: [],
				reason: "Owner scope change",
			},
		]);
		expect(
			(
				await tool.execute("restore", {
					op: "classify",
					id: "R5",
					classification: "linked",
					rows: [foldRow],
					supersededBy: "R16",
					reason: "Owner resumed fold work",
				})
			).isError,
		).toBeUndefined();
		const current = getLatestRequirements(manager.getBranch()).find(item => item.id === "R5")!;
		expect(current.amendments?.map(amendment => amendment.supersededBy)).toEqual(["R14", "R16"]);
		expect(current.classification).toBe("linked");
		expect(current.rowVerdicts).toBeUndefined();
		expect((await tool.execute("no-old-pass", { op: "done", task: foldRow })).isError).toBe(true);
	});
});

it("relinks a requirement to an archived completed row without reviving it", async () => {
	const { manager, tool } = harness();
	seedMislinked(manager);
	const archivedRow = "Previously verified implementation";
	manager.appendCustomEntry("user_todo_edit", {
		edit: {
			v: 1,
			kind: "archive",
			at: Date.now(),
			archivedPhases: [{ name: "Previous", tasks: [{ content: archivedRow, status: "completed" }] }],
		},
	});
	const result = await tool.execute("relink-archived", {
		op: "classify",
		id: "R3",
		classification: "linked",
		rows: [archivedRow],
		relink: true,
		reason: "Correct stale linkage to the archived implementation",
	});
	expect(result.isError, textOf(result)).toBeUndefined();
	expect(r3Of(manager).rows).toEqual([archivedRow]);
	expect(getRequirementRowVerdict(r3Of(manager), archivedRow)).toBeUndefined();
	const view = await tool.execute("view-live", { op: "view" });
	expect(
		(view as { details: { phases: TodoPhase[] } }).details.phases.flatMap(p => p.tasks).map(t => t.content),
	).not.toContain(archivedRow);
});

for (const binding of [
	{ resources: ["/tmp/new-artifact"] },
	{ deployment: "deploy:https://example.test/version@v2 field=version" },
]) {
	it(`persists archived binding replacement: ${Object.keys(binding)[0]}`, async () => {
		const { manager, tool } = harness();
		seedMislinked(manager);
		const archivedRow = "Archived implementation with artifact";
		manager.appendCustomEntry("user_todo_edit", {
			edit: {
				v: 1,
				kind: "archive",
				at: Date.now(),
				archivedPhases: [
					{
						name: "Previous",
						tasks: [
							{ content: archivedRow, status: "completed", schedule: { resources: ["/tmp/old-artifact"] } },
						],
					},
				],
			},
		});
		const result = await tool.execute("relink-binding", {
			op: "classify",
			id: "R3",
			classification: "linked",
			rows: [archivedRow],
			relink: true,
			reason: "Bind the corrected artifact",
			...binding,
		});
		expect(result.isError, textOf(result)).toBeUndefined();
		let archived: (TodoPhase["tasks"][number] & { schedule?: { resources?: string[] } }) | undefined;
		observeLatestTodoPhases(manager.getBranch(), phases => {
			for (const phase of phases) for (const task of phase.tasks) if (task.content === archivedRow) archived = task;
		});
		if (!archived) throw new Error("archived binding missing");
		if (binding.resources) {
			expect(archived.schedule?.resources).toEqual(binding.resources);
			expect(archived.deployment).toBeUndefined();
		} else {
			expect(archived.deployment).toBe(binding.deployment);
			expect(archived.schedule?.resources).toBeUndefined();
		}
		expect(archived.status).toBe("completed");
		const view = await tool.execute("view-live", { op: "view" });
		expect(
			(view as { details: { phases: TodoPhase[] } }).details.phases.flatMap(p => p.tasks).map(t => t.content),
		).not.toContain(archivedRow);
	});
}
