import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getAssistantPublicationGate } from "@oh-my-pi/pi-agent-core/assistant-publication";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	getLatestRequirements,
} from "@oh-my-pi/pi-coding-agent/tools/requirements-ledger";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { createAssistantMessage } from "../helpers/agent-session-setup";

test("production AgentSession keeps a freshness-reopened row live through edits and disk reload", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "requirements-live-reopen-"));
	const sessionDir = path.join(cwd, "sessions");
	const auth = await AuthStorage.create(path.join(cwd, "auth.db"));
	let firstSession: AgentSession | undefined;
	let resumedSession: AgentSession | undefined;
	try {
		const file = path.join(cwd, "artifact.txt");
		const original = "audited\n";
		const row = "Deliver artifact";
		const otherRow = "Other follow-up";
		await Bun.write(file, original);
		const hash = new Bun.CryptoHasher("sha256").update(original).digest("hex");
		const manager = SessionManager.create(cwd, sessionDir);
		await manager.ensureOnDisk();
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [
				{
					name: "Work",
					tasks: [
						{ content: row, status: "completed", schedule: { owner: "main", resources: [file] } },
						{ content: otherRow, status: "pending" },
					],
				},
			],
		});
		appendRequirementsSnapshot(
			{ appendEntry: (type, data) => manager.appendCustomEntry(type, data) },
			createRequirementCandidates([], ["audit artifact"], "2026-11-10T20:00:00Z").map(requirement => ({
				...requirement,
				classification: "linked",
				rows: [row],
				rowVerdicts: {
					[row]: {
						status: "pass",
						evidence: "checked original bytes",
						artifact: `row ${JSON.stringify(row)} @ file:${file}@sha256=${hash}`,
						workerId: "qa-old",
						auditor: "qa-auditor",
						receivedAt: "2026-11-10T20:01:00Z",
						rawWords: requirement.rawText,
					},
				},
			})),
		);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled test model");
		const makeAgent = () =>
			new Agent({
				getApiKey: () => undefined,
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: () => {
					throw new Error("provider calls are not part of this regression");
				},
			});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": true,
			"todo.reminders": false,
			"title.refreshOnReplan": false,
		});
		const modelRegistry = new ModelRegistry(auth, path.join(cwd, "models.yml"));
		const agent = makeAgent();
		firstSession = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry });
		const gate = getAssistantPublicationGate(agent)!;
		const signal = new AbortController().signal;
		await gate(createAssistantMessage("Initial status"), signal);
		await Bun.write(file, "REGRESSED\n");
		await gate(createAssistantMessage("After artifact mutation"), signal);
		const persistedAfterReopen = getLatestTodoPhasesFromEntries(manager.getBranch())[0]!.tasks[0]!.status;
		const liveAfterReopen = firstSession.getTodoPhases()[0]!.tasks[0]!.status;
		expect(persistedAfterReopen).toBe("pending");
		expect(liveAfterReopen).toBe("pending");
		expect(getLatestRequirements(manager.getBranch())[0]!.rowVerdicts?.[row]?.status).toBe("unverifiable");

		const edited = firstSession.getTodoPhases();
		edited[0]!.tasks[1]!.status = "completed";
		firstSession.commitTodoPhases(edited);
		const persistedAfterOtherRowEdit = getLatestTodoPhasesFromEntries(manager.getBranch())[0]!.tasks[0]!.status;
		expect(persistedAfterOtherRowEdit).toBe("pending");
		await gate(createAssistantMessage("After unrelated row edit"), signal);
		expect(getLatestTodoPhasesFromEntries(manager.getBranch())[0]!.tasks[0]!.status).toBe("pending");

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		await firstSession.dispose();
		firstSession = undefined;
		const resumedManager = await SessionManager.open(sessionFile, sessionDir);
		const resumedAgent = makeAgent();
		resumedSession = new AgentSession({
			agent: resumedAgent,
			sessionManager: resumedManager,
			settings,
			modelRegistry,
		});
		expect(resumedSession.getTodoPhases()[0]!.tasks[0]!.status).toBe("pending");
		await getAssistantPublicationGate(resumedAgent)!(createAssistantMessage("After reload"), signal);
		expect(getLatestTodoPhasesFromEntries(resumedManager.getBranch())[0]!.tasks[0]!.status).toBe("pending");
	} finally {
		await firstSession?.dispose();
		await resumedSession?.dispose();
		auth.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
