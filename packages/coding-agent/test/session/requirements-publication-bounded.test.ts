import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import {
	RequirementsLedgerRuntime,
	type RequirementPublicationGate,
} from "../../src/session/requirements-ledger-runtime";
import { SessionManager } from "../../src/session/session-manager";
import { createRequirementCandidates, REQUIREMENTS_LEDGER_CUSTOM_TYPE } from "../../src/tools/requirements-ledger";
import type { RequirementEntryMetadata } from "../../src/session/requirements-branch-selection";
import { createAssistantMessage } from "../helpers/agent-session-setup";

test("publishing without requirements never decodes 300k obsolete todo snapshots, and new requirements still gate", async () => {
	const manager = SessionManager.inMemory();
	for (let i = 0; i < 300_000; i++) manager.appendCustomEntry("user_todo_edit", { phases: [] });
	const entries = manager.getBranchView();
	let decoded = 0;
	Object.assign(manager, {
		getBranchMatching: (predicate: (entry: RequirementEntryMetadata) => boolean) =>
			entries.filter(entry => {
				if (!predicate(entry)) return false;
				decoded++;
				return true;
			}),
		*iterateBranchMatchingNewestFirst(predicate: (entry: RequirementEntryMetadata) => boolean) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i]!;
				if (predicate(entry)) {
					decoded++;
					yield entry;
				}
			}
		},
	});
	let gate: RequirementPublicationGate | undefined;
	const statuses: Array<string | undefined> = [];
	new RequirementsLedgerRuntime({
		agent: new Agent(),
		agentKind: () => "main",
		cwd: () => process.cwd(),
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		setAuditStatus: status => statuses.push(status),
		setPublicationGate: next => {
			gate = next;
		},
	});
	if (!gate) throw new Error("Missing publication gate");
	decoded = 0;
	try {
		for (let turn = 0; turn < 10; turn++) {
			expect(await gate(createAssistantMessage("finished"), new AbortController().signal)).toBeUndefined();
			manager.appendCustomEntry("unrelated", { turn });
		}
		expect(decoded).toBe(0);
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], ["deliver the fix"], new Date().toISOString()),
		});
		decoded = 0;
		for (let turn = 0; turn < 10; turn++)
			await gate(createAssistantMessage("finished"), new AbortController().signal);
		expect(decoded).toBeLessThan(200);
		expect(statuses.at(-1)).toBe("requirement audits: 1 of 1 need verification");
		manager.appendCustomEntry("user_todo_edit", {
			phases: [
				{
					name: "Live",
					tasks: [
						{ content: "current", status: "pending", schedule: { resources: ["/missing-publication-fixture"] } },
					],
				},
			],
		});
		manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
			version: 1,
			requirements: createRequirementCandidates([], ["deliver the fix"], new Date().toISOString()).map(
				requirement => ({ ...requirement, classification: "linked", rows: ["current"] }),
			),
		});
		decoded = 0;
		for (let turn = 0; turn < 10; turn++)
			await gate(createAssistantMessage("finished"), new AbortController().signal);
		expect(decoded).toBeLessThan(300);
		expect(statuses.at(-1)).toBe("requirement audits: 1 of 1 need verification");
	} finally {
		await manager.close();
	}
}, 60_000);

test("resumed archived requirement rows use an incremental index during publication", async () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("user_todo_edit", {
		phases: [
			{
				name: "Old",
				tasks: [
					{ content: "archived", status: "completed", schedule: { resources: ["/missing-publication-fixture"] } },
				],
			},
		],
	});
	for (let i = 0; i < 300_000; i++) manager.appendCustomEntry("user_todo_edit", { phases: [] });
	manager.appendCustomEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, {
		version: 1,
		requirements: createRequirementCandidates([], ["deliver archived fix"], new Date().toISOString()).map(
			requirement => ({ ...requirement, classification: "linked", rows: ["archived"] }),
		),
	});
	const entries = manager.getBranchView();
	let decoded = 0;
	Object.assign(manager, {
		getBranchMatching: (predicate: (entry: RequirementEntryMetadata) => boolean) =>
			entries.filter(entry => {
				if (!predicate(entry)) return false;
				decoded++;
				return true;
			}),
		*iterateBranchMatchingNewestFirst(predicate: (entry: RequirementEntryMetadata) => boolean) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i]!;
				if (predicate(entry)) {
					decoded++;
					yield entry;
				}
			}
		},
	});
	let gate: RequirementPublicationGate | undefined;
	const statuses: Array<string | undefined> = [];
	const runtime = new RequirementsLedgerRuntime({
		agent: new Agent(),
		agentKind: () => "main",
		cwd: () => process.cwd(),
		sessionManager: manager,
		onSettledAssistantMessage: () => {},
		setAuditStatus: status => statuses.push(status),
		setPublicationGate: next => {
			gate = next;
		},
	});
	if (!gate) throw new Error("Missing publication gate");
	decoded = 0;
	try {
		for (let turn = 0; turn < 10; turn++) {
			manager.appendCustomEntry("unrelated", { turn });
			await gate(createAssistantMessage("finished"), new AbortController().signal);
		}
		expect(decoded).toBeLessThan(300);
		expect(statuses.at(-1)).toBe("requirement audits: 0 of 1 need verification");
		decoded = 0;
		for (let turn = 0; turn < 10; turn++) {
			expect(
				runtime.commitCandidate({ sessionId: manager.getSessionId(), sourceText: `new ask ${turn}`, images: [] })
					.committed,
			).toBe(true);
			runtime.remindUnclassifiedCandidates("task", { agent: "executor", task: "fix" });
			await runtime.prepareAuditorTaskCall("task", `dispatch-${turn}`, { agent: "executor", task: "fix" });
		}
		expect(decoded).toBeLessThan(500);
	} finally {
		await manager.close();
	}
}, 60_000);
