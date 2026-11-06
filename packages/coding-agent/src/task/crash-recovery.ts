import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncJobError } from "../async";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import type { AgentSession } from "../session/agent-session";
import { hasRestorableTurn, isInterruptedTurnAbort } from "../session/exit-diagnostics";
import { extractSessionInit, SessionManager } from "../session/session-manager";
import { collectSubSessions } from "../session/sub-sessions";
import { applyTodoExecutorObservation } from "../tools/todo-executor";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "./executor";
import type { SpawnPermit } from "./spawn-run";
import { AgentOutputManager } from "./output-manager";
import { persistedAgentDefinition } from "./persisted-revive";
import { formatTaskResultSummary } from "./result-summary";
import { cfgTaskMaxRuntimeMs } from "./settings";
import type { RestoreOptions, RestoreOutcome } from "./restore";

/** Resume only open rows interrupted by process death, before the lead gets its first turn. */
export async function recoverCrashedRows(session: AgentSession, options: RestoreOptions = {}): Promise<RestoreOutcome> {
	const mainFile = session.sessionManager.getSessionFile();
	const manager = session.asyncJobManager;
	const taskTool = session.getToolByName("task");
	const permit = taskTool && "recoveryPermit" in taskTool ? (taskTool.recoveryPermit as SpawnPermit) : undefined;
	if (!mainFile || !manager || !permit) return { turn: false, subagents: [] };
	const registry = AgentRegistry.global();
	await ensurePersistedRoster(registry, mainFile);
	const children = await collectSubSessions(mainFile);
	const restored: string[] = [];
	const dir = mainFile.slice(0, -6);
	const outputs = new AgentOutputManager(() => dir);
	for (const sub of Object.values(children)) {
		if (
			sub.parent ||
			sub.aborted ||
			!hasRestorableTurn(sub.entries) ||
			manager.getRunningJobs().some(job => job.id === sub.agentId || job.agentId === sub.agentId)
		)
			continue;
		const tail = sub.entries.findLast(entry => entry.type === "message");
		if (
			tail?.type === "message" &&
			tail.message.role === "assistant" &&
			["error", "aborted"].includes(tail.message.stopReason) &&
			!isInterruptedTurnAbort(tail.message)
		)
			continue;
		// A successful yield is a real terminal result even if the process died before writing a final assistant.
		const assistant = sub.entries.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
		if (
			assistant?.type === "message" &&
			assistant.message.role === "assistant" &&
			assistant.message.content.some(
				part =>
					part.type === "toolCall" &&
					part.name === "yield" &&
					sub.entries.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === part.id &&
							!entry.message.isError,
					),
			)
		)
			continue;
		const rows = session
			.getTodoSnapshot()
			.flatMap(phase => phase.tasks)
			.filter(
				row =>
					row.status !== "completed" &&
					row.status !== "abandoned" &&
					row.status !== "blocked" &&
					(row.schedule?.executor?.workerId ?? row.schedule?.owner) === sub.agentId &&
					!["completed", "failed"].includes(row.schedule?.executor?.outcome ?? ""),
			);
		const ref = registry.get(sub.agentId);
		const init = extractSessionInit(sub.entries);
		if (!rows.length || !ref?.sessionFile || ref.session || !init || !sub.header) continue;
		try {
			if (!(await fs.stat(sub.header.cwd)).isDirectory()) continue;
		} catch {
			continue;
		}
		const id = await outputs.allocate(sub.agentId);
		const file = path.join(dir, `${id}.jsonl`);
		const fork = await SessionManager.forkFrom(ref.sessionFile, sub.header.cwd, dir, undefined, {
			sessionFile: file,
			suppressBreadcrumb: true,
			copyArtifacts: false,
		});
		await fork.close();
		const isolationMarker = path.join(dir, `${id}.restart-isolation.json`);
		if (init.isolated) await Bun.write(isolationMarker, JSON.stringify({ id, cwd: sub.header.cwd }));
		registry.register({
			id,
			displayName: ref.displayName,
			kind: "sub",
			parentId: ref.parentId,
			session: null,
			sessionFile: file,
			status: "parked",
		});
		const startedAt = Date.now();
		const titles = new Set(rows.map(row => row.content));
		session.commitTodoPhases(
			session.getTodoSnapshot().map(phase => ({
				...phase,
				tasks: phase.tasks.map(row =>
					titles.has(row.content)
						? {
								...row,
								status: "in_progress",
								schedule: {
									...row.schedule,
									owner: id,
									workerIds: [...new Set([...(row.schedule?.workerIds ?? []), id])],
									executor: { workerId: id, agentProfile: init.agent, startedAt, resumedAfterCrash: true },
								},
							}
						: row,
				),
			})),
		);
		manager.register(
			"task",
			id,
			async ({ signal, markRunning }) => {
				let acquired = false;
				let outcome: "completed" | "failed" | "aborted" = "failed";
				try {
					await permit.acquire(signal);
					acquired = true;
					markRunning();
					const result = await runSubagentFollowUpTurn({
						id,
						agent: persistedAgentDefinition(ref.displayName, init),
						message: init.task,
						restore: true,
						structured: init.tools.includes("yield"),
						workPoolYieldItems: init.workPoolYieldItems,
						outputSchema: init.outputSchema,
						outputSchemaMode: init.outputSchemaMode,
						signal,
						eventBus: options.eventBus,
						subagentEventBus: options.subagentEventBus,
						artifactsDir: dir,
						maxRuntimeMs: cfgTaskMaxRuntimeMs.get(session.settings),
						...softRequestBudgetFor(ref.displayName, session.settings),
					});
					outcome = result.aborted ? "aborted" : result.exitCode !== 0 || result.error ? "failed" : "completed";
					const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
					if (outcome !== "completed") throw new AsyncJobError(text, result.structuredOutput);
					return result.structuredOutput ? { text, structured: result.structuredOutput } : text;
				} finally {
					if (acquired) permit.release();
					if (init.isolated) await fs.rm(isolationMarker, { force: true });
					for (const row of titles) {
						const updated = applyTodoExecutorObservation(session.getTodoSnapshot(), {
							row,
							workerId: id,
							startedAt,
							finishedAt: Date.now(),
							outcome: signal.aborted ? "aborted" : outcome,
							runningWorkerIds: new Set(manager.getRunningJobs().map(job => job.agentId ?? job.id)),
						});
						if (updated) session.commitTodoPhases(updated);
					}
				}
			},
			{ id, agentId: id, ownerId: ref.parentId, queued: true },
		);
		restored.push(id);
	}
	return { turn: false, subagents: restored };
}
