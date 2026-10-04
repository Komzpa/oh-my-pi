import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Agent, AfterToolCallContext, AfterToolCallResult, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import { setAssistantPublicationGate } from "@oh-my-pi/pi-agent-core/assistant-publication";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	formatOverdueClassifyRefusal,
	formatPublicationReplacement,
	getLatestRequirements,
	getOverdueRequirementCandidates,
	getPersistedRequirementAuditorAssignments,
	getPersistedRequirementAuditRejections,
	getRequirementAuditSources,
	isFreshRequirementVerdict,
	parseRequirementReceipt,
	requirementAuditSnapshot,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	type RequirementAuditAssignment,
	type RequirementLedgerItem,
} from "../tools/requirements-ledger";
import { ASYNC_RESULT_MESSAGE_TYPE } from "./async-job-delivery";
import type { SessionManager } from "./session-manager";
import { isFailedTaskSingleResult } from "../task/result-summary";
import { discoverAgents, getAgent } from "../task/discovery";
import {
	bindRequirementRowArtifact,
	getLatestTodoPhasesFromEntries,
	getRequirementRowArtifact,
	type RequirementRowArtifact,
} from "../tools/todo";
import { READ_ONLY_TOOL_NAMES } from "../task/read-only-policy";
import { BUNDLED_QA_AUDITOR_TEMPLATE } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";

/** The harness renames a worker whose requested name is taken by appending `-<n>`. */
function sameWorkerIdentity(a: string, b: string): boolean {
	if (a === b) return true;
	const [long, short] = a.length >= b.length ? [a, b] : [b, a];
	return long.startsWith(`${short}-`) && /^\d+$/.test(long.slice(short.length + 1));
}

function resultText(result: unknown): string | undefined {
	const content = isRecord(result) && "content" in result ? result.content : undefined;
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.flatMap(part => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
			.join("\n");
	return undefined;
}

async function isBundledQaAuditor(agent: AgentDefinition | undefined): Promise<boolean> {
	if (!agent) return false;
	if (agent.source === "bundled") return true;
	if (!agent.filePath) return false;
	try {
		const agentContent = await readFile(agent.filePath);
		return agentContent.equals(Buffer.from(BUNDLED_QA_AUDITOR_TEMPLATE, "utf8"));
	} catch {
		return false;
	}
}
/** Open todo rows only: completed/abandoned rows never unblock a classify call. */
function openTodoRowContents(entries: Parameters<typeof getLatestTodoPhasesFromEntries>[0]): string[] {
	return getLatestTodoPhasesFromEntries(entries).flatMap(phase =>
		phase.tasks
			.filter(task => task.status === "pending" || task.status === "in_progress" || task.status === "blocked")
			.map(task => task.content),
	);
}

export type RequirementPublicationGate = (
	message: AssistantMessage,
	signal: AbortSignal,
) => void | { replacementText: string; settled?: true } | Promise<void | { replacementText: string; settled?: true }>;

export interface RequirementsLedgerRuntimeHost {
	agent: Agent;
	agentKind(): "main" | "sub";
	cwd(): string;
	sessionManager: SessionManager;
	onSettledAssistantMessage(message: AssistantMessage): void;
	setPublicationGate?(gate: RequirementPublicationGate | undefined): void;
}

/** Owns main-session requirement capture, QA receipts, and completion gates. */
export class RequirementsLedgerRuntime {
	readonly #host: RequirementsLedgerRuntimeHost;
	readonly #auditCalls = new Map<string, RequirementAuditAssignment[]>();
	readonly #pendingAuditors = new Map<string, RequirementAuditAssignment>();
	readonly #auditorRefusals = new Map<string, { ids: string[]; source: string }>();
	#publicationGeneration = 0;
	#publicationState = "";

	constructor(host: RequirementsLedgerRuntimeHost) {
		this.#host = host;
		this.#restorePendingAuditors();
		this.syncPublicationGate();
	}

	captureCandidate(rawText: string): void {
		if (this.#host.agentKind() !== "main" || !rawText.trim() || rawText.trimStart().startsWith("/")) return;
		const requirements = getLatestRequirements(this.#host.sessionManager.getBranch());
		appendRequirementsSnapshot(this.#appender(), createRequirementCandidates(requirements, [rawText]));
		this.syncPublicationGate();
	}

	refuseOverdueCandidate(toolName: string): BeforeToolCallResult | undefined {
		if (this.#host.agentKind() !== "main" || toolName === "todo") return undefined;
		// The overdue-classify gate never blocks read-only tools: observation must
		// stay possible while a candidate awaits classification. `peers` is the
		// live-roster list (not in READ_ONLY_TOOL_NAMES); `ask` is already there.
		if (toolName === "peers" || READ_ONLY_TOOL_NAMES.has(toolName)) return undefined;
		const branch = this.#host.sessionManager.getBranch();
		const overdue = getOverdueRequirementCandidates(branch);
		if (overdue.length === 0) return undefined;
		const rows = openTodoRowContents(branch);
		return {
			block: true,
			reason: formatOverdueClassifyRefusal(toolName, overdue, rows),
		};
	}

	/** Adds the immutable audit inputs to qa-auditor tasks that cite linked Rn IDs. */
	async prepareAuditorTaskCall(
		toolName: string,
		toolCallId: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<Record<string, unknown> | undefined> {
		if (this.#host.agentKind() !== "main" || toolName !== "task" || !isRecord(input)) return undefined;
		const sessionId = this.#sessionId();
		if (!sessionId) return undefined;

		const branch = this.#host.sessionManager.getBranch();
		const requirements = getLatestRequirements(branch);
		const phases = getLatestTodoPhasesFromEntries(branch);
		const sharedContext = typeof input.context === "string" ? input.context : "";
		const multiple = Array.isArray(input.tasks);
		const items = multiple ? (input.tasks as unknown[]) : [input];
		const revised = [...items];
		const assignments: RequirementAuditAssignment[] = [];
		const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();

		const hasAuditorTask = items.some(item => isRecord(item) && item.agent === "qa-auditor");
		const resolvedAuditor = hasAuditorTask
			? getAgent((await discoverAgents(this.#host.cwd())).agents, "qa-auditor")
			: undefined;
		if (hasAuditorTask && !(await isBundledQaAuditor(resolvedAuditor))) {
			const citedIds = new Set(
				items.flatMap(item =>
					isRecord(item) && item.agent === "qa-auditor" && typeof item.task === "string"
						? (`${item.task}\n${sharedContext}`.match(/\bR[1-9]\d*\b/g) ?? [])
						: [],
				),
			);
			const ids = requirements
				.filter(requirement => requirement.classification === "linked" && citedIds.has(requirement.id))
				.map(requirement => requirement.id);
			if (ids.length > 0)
				this.#auditorRefusals.set(toolCallId, { ids, source: resolvedAuditor?.source ?? "unavailable" });
			// The audit input stays on the task even for a non-bundled profile: a
			// worker must never be dispatched without the immutable QA AUDIT INPUT
			// block. The refusal above still rejects any receipt it returns.
		}
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (!isRecord(item) || item.agent !== "qa-auditor" || typeof item.task !== "string") continue;
			const citedIds = new Set(`${item.task}\n${sharedContext}`.match(/\bR[1-9]\d*\b/g) ?? []);
			const ids = requirements
				.filter(requirement => requirement.classification === "linked" && citedIds.has(requirement.id))
				.map(requirement => requirement.id);
			if (ids.length === 0) continue;

			const sources = [
				...new Map(
					ids
						.flatMap(id => getRequirementAuditSources(requirements, id))
						.map(source => [source.id, source] as const),
				).values(),
			];
			const rowHeads: string[] = [];
			const boundHeads: Record<string, string> = {};
			for (const id of ids) {
				const requirement = requirements.find(candidate => candidate.id === id)!;
				for (const row of requirement.rows) {
					const artifact = await bindRequirementRowArtifact(
						{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager, signal },
						row,
						phases,
						this.#appender(),
						checkoutCache,
					);
					if (artifact.head && !artifact.dirty) boundHeads[row] = artifact.head;
					rowHeads.push(
						`${id} row ${JSON.stringify(row)} at ${artifact.cwd}: ${artifact.head ?? "HEAD unavailable"}${artifact.dirty ? " (dirty)" : ""}`,
					);
				}
			}

			const protocol = [
				"QA AUDIT INPUT (original user words; merged sources retain their own Rn):",
				...sources.map(source => `${source.id} (said at ${source.at}): ${source.rawText}`),
				"Current linked-row HEAD identities:",
				...rowHeads,
				"Return one complete Markdown table with columns id | raw words | verdict | evidence | artifact identity. One row per linked Rn above; verdict pass, fail or unverifiable. Each artifact identity must include the full current commit SHA from every corresponding linked row. Evidence must name what was actually exercised or observed; no partial table or truncated preview is accepted.",
			].join("\n");
			revised[index] = { ...item, task: `${item.task}\n\n${protocol}` };
			assignments.push({
				ids,
				snapshot: requirementAuditSnapshot(requirements, ids),
				sessionId,
				agent: "qa-auditor",
				index,
				boundHeads,
			});
		}

		if (assignments.length === 0) return undefined;
		this.#auditCalls.set(toolCallId, assignments);
		return multiple ? { ...input, tasks: revised } : { ...input, task: (revised[0] as Record<string, unknown>).task };
	}

	async afterToolCall(context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
		if (this.#host.agentKind() !== "main") return undefined;
		if (context.toolCall.name === "wait") {
			await this.#consumeWaitSnapshot(context.result);
			return undefined;
		}
		if (context.toolCall.name !== "task") return undefined;
		const refusal = this.#auditorRefusals.get(context.toolCall.id);
		if (refusal) {
			this.#auditorRefusals.delete(context.toolCall.id);
			this.#auditCalls.delete(context.toolCall.id);
			return {
				content: [
					...context.result.content,
					{
						type: "text",
						text: `Blocked: resolved qa-auditor profile is ${refusal.source}, not the bundled auditor. ${refusal.ids.map(id => `Call task with agent="qa-auditor", task="Audit ${id} at the current clean row HEAD". Then retry`).join("; ")}`,
					},
				],
			};
		}
		const assignments = this.#auditCalls.get(context.toolCall.id);
		if (!assignments) return undefined;
		this.#auditCalls.delete(context.toolCall.id);

		const rejected: string[] = [];
		const details = isRecord(context.result.details) ? context.result.details : {};
		const results = Array.isArray(details.results) ? details.results : [];
		const progress = Array.isArray(details.progress) ? details.progress : [];
		let pendingChanged = false;
		for (const assignment of assignments) {
			if (context.isError) {
				rejected.push(`${assignment.ids.join(", ")}: qa-auditor task failed`);
				continue;
			}
			const result = results.find(value => isRecord(value) && value.index === assignment.index);
			if (isRecord(result)) {
				const failed = isFailedTaskSingleResult(
					{ isError: context.isError },
					result as { aborted?: boolean; exitCode?: number; error?: unknown },
				);
				if (
					failed ||
					result.agent !== "qa-auditor" ||
					typeof result.id !== "string" ||
					!result.id ||
					typeof result.output !== "string" ||
					result.truncated === true
				) {
					rejected.push(`${assignment.ids.join(", ")}: not a complete qa-auditor result`);
					continue;
				}
				const issue = await this.#acceptReceipt(result.id, { ...assignment, workerId: result.id }, result.output);
				if (issue) rejected.push(issue);
				continue;
			}
			const worker = progress.find(value => isRecord(value) && value.index === assignment.index);
			if (isRecord(worker) && worker.agent === "qa-auditor" && typeof worker.id === "string" && worker.id) {
				this.#pendingAuditors.set(worker.id, { ...assignment, workerId: worker.id });
				pendingChanged = true;
			} else {
				rejected.push(`${assignment.ids.join(", ")}: task result did not identify its qa-auditor worker`);
			}
		}
		if (pendingChanged) this.#persistPendingAuditors();
		if (rejected.length === 0) return undefined;
		return {
			content: [
				...context.result.content,
				{
					type: "text",
					text: `Blocked: requirements receipt rejected: ${rejected.join("; ")}. Call task with agent="qa-auditor", task="Audit <Rn> at the current clean row HEAD" returning one complete Markdown table with columns id | raw words | verdict | evidence | artifact identity (one row per linked Rn; each artifact identity must include the full current commit SHA from every corresponding linked row). Then retry`,
				},
			],
		};
	}

	async consumeAsyncResult(message: unknown): Promise<void> {
		if (
			this.#host.agentKind() !== "main" ||
			!isRecord(message) ||
			message.role !== "custom" ||
			message.customType !== ASYNC_RESULT_MESSAGE_TYPE ||
			message.attribution !== "agent" ||
			!isRecord(message.details) ||
			!Array.isArray(message.details.jobs)
		) {
			return;
		}
		const content =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.flatMap(part =>
								isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
							)
							.join("\n")
					: undefined;
		if (content === undefined) return;
		this.#restorePendingAuditors();
		let pendingChanged = false;
		const acceptedIds: string[] = [];
		for (const job of message.details.jobs) {
			if (!isRecord(job) || job.type !== "task" || typeof job.jobId !== "string") continue;
			const workerId = typeof job.agentId === "string" && job.agentId ? job.agentId : job.jobId;
			const key = this.#resolvePendingAuditorKey(workerId);
			const assignment = key ? this.#pendingAuditors.get(key) : undefined;
			if (!key || !assignment) continue;
			const outcome = await this.#consumeTaskResultEnvelope(workerId, content);
			const rejection =
				outcome.status === "accepted"
					? undefined
					: outcome.status === "rejected"
						? outcome.reason
						: "async result was incomplete, truncated, or not from qa-auditor";
			if (rejection) this.#persistPendingAuditors({ workerId: key, ids: assignment.ids, reason: rejection });
			this.#pendingAuditors.delete(key);
			pendingChanged = true;
			if (!rejection) acceptedIds.push(...assignment.ids);
		}
		if (pendingChanged) this.#persistPendingAuditors(undefined, acceptedIds);
	}

	async #publicationGate(
		message: AssistantMessage,
		signal: AbortSignal,
	): Promise<{ replacementText: string; settled?: true } | void> {
		if (this.#host.agentKind() !== "main" || message.stopReason === "error" || message.stopReason === "aborted") {
			return;
		}
		let generation = this.#getPublicationGeneration();
		let freshness = await this.#refreshRequirementFreshness(signal);
		if (this.#getPublicationGeneration() !== generation) {
			generation = this.#getPublicationGeneration();
			freshness = await this.#refreshRequirementFreshness(signal);
			// Never erase the assistant's own text on a generation race: publish unchanged.
			if (this.#getPublicationGeneration() !== generation) return;
		}
		const decisionGeneration = this.#getPublicationGeneration();
		const { requirements, staleById } = freshness;
		const open = this.#openRequirements(requirements, staleById);
		this.syncPublicationGate();
		// Never erase the assistant's own text on a generation race: publish unchanged.
		if (this.#getPublicationGeneration() !== decisionGeneration) return;
		if (open.length === 0) return;
		// With tool calls the text stays as it is: the gate only appends to final text.
		if (message.content.some(block => block.type === "toolCall")) return;
		const rows = openTodoRowContents(this.#host.sessionManager.getBranch());
		this.#host.onSettledAssistantMessage(message);
		const notice = formatPublicationReplacement(open, rows);
		const original = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("")
			.trim();
		return {
			replacementText: original ? `${original}\n\n${notice}` : notice,
			settled: true,
		};
	}

	async #refreshRequirementFreshness(
		signal?: AbortSignal,
	): Promise<{ requirements: RequirementLedgerItem[]; staleById: Map<string, string[]> }> {
		const branch = this.#host.sessionManager.getBranch();
		const requirements = getLatestRequirements(branch);
		const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
		const staleById = new Map<string, string[]>();
		let updated: RequirementLedgerItem[] | undefined;
		const phases = getLatestTodoPhasesFromEntries(branch);
		for (let index = 0; index < requirements.length; index++) {
			if (signal?.aborted) return { requirements, staleById };
			const requirement = requirements[index]!;
			if (requirement.classification !== "linked" || requirement.verdict?.status !== "pass") continue;
			const verdict = requirement.verdict;
			const artifacts = await Promise.all(
				requirement.rows.map(async row => ({
					row,
					...(await getRequirementRowArtifact(
						{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager, signal },
						row,
						phases,
						checkoutCache,
					)),
				})),
			);
			const issues = artifacts.flatMap(current => {
				if (!current.head)
					return [
						`${requirement.id} current HEAD is unavailable for ${JSON.stringify(current.row)} at ${current.cwd}`,
					];
				if (current.dirty)
					return [
						`${requirement.id} pass is stale for ${JSON.stringify(current.row)}: worktree at ${current.cwd} is dirty; commit before QA`,
					];
				return [];
			});
			if (issues.length === 0 && !isFreshRequirementVerdict(requirement, artifacts)) {
				issues.push(
					`${requirement.id} pass is stale: artifact ${verdict.artifact}, current HEADs ${artifacts.map(({ row, head }) => `${JSON.stringify(row)}: ${head}`).join(", ")}`,
				);
			}
			if (issues.length === 0) continue;
			staleById.set(requirement.id, issues);
			updated ??= requirements.map(item => ({ ...item, rows: [...item.rows] }));
			delete updated[index]!.verdict;
		}
		if (!updated || signal?.aborted) return { requirements, staleById };
		if (
			JSON.stringify(getLatestRequirements(this.#host.sessionManager.getBranch())) !== JSON.stringify(requirements)
		) {
			return { requirements: getLatestRequirements(this.#host.sessionManager.getBranch()), staleById: new Map() };
		}
		appendRequirementsSnapshot(this.#appender(), updated);
		return { requirements: updated, staleById };
	}

	#openRequirements(
		requirements: readonly RequirementLedgerItem[],
		staleById: Map<string, string[]>,
	): Array<{ requirement: RequirementLedgerItem; issues: string[] }> {
		const open: Array<{ requirement: RequirementLedgerItem; issues: string[] }> = [];
		for (const requirement of requirements) {
			if (requirement.classification === "candidate") {
				open.push({ requirement, issues: [`${requirement.id} awaits todo classify`] });
				continue;
			}
			if (requirement.classification !== "linked") continue;
			const stale = staleById.get(requirement.id);
			if (stale) {
				open.push({ requirement, issues: stale });
				continue;
			}
			const verdict = requirement.verdict;
			if (!verdict) {
				const rejection = getPersistedRequirementAuditRejections(
					this.#host.sessionManager.getBranch(),
					this.#sessionId(),
				).get(requirement.id);
				open.push({
					requirement,
					issues: [
						`${requirement.id} needs a fresh qa-auditor pass${rejection ? `; rejected receipt: ${rejection}` : ""}`,
					],
				});
			} else if (verdict.status === "fail")
				open.push({ requirement, issues: [`${requirement.id} failed: ${verdict.evidence}`] });
			else if (verdict.status === "unverifiable")
				open.push({ requirement, issues: [`${requirement.id} unverifiable: ${verdict.evidence}`] });
			else if (!verdict.workerId.trim() || verdict.auditor !== "qa-auditor") {
				open.push({
					requirement,
					issues: [`${requirement.id} has no authenticated qa-auditor identity on its receipt`],
				});
			}
		}
		return open;
	}

	async #acceptReceipt(
		workerId: string,
		assignment: RequirementAuditAssignment,
		output: string,
	): Promise<string | null> {
		const expectedIds = assignment.ids;
		const sessionId = this.#sessionId();
		if (
			!sessionId ||
			assignment.sessionId !== sessionId ||
			assignment.agent !== "qa-auditor" ||
			(assignment.workerId !== undefined && !sameWorkerIdentity(assignment.workerId, workerId))
		) {
			return `${expectedIds.join(", ")}: auditor assignment session or worker identity did not match`;
		}
		const receipts = parseRequirementReceipt(output, expectedIds);
		if (!receipts) {
			const covered = new Set([...output.matchAll(/\|\s*(R[1-9]\d*)\s*\|/g)].map(match => match[1]!));
			const missing = expectedIds.filter(id => !covered.has(id));
			return `${expectedIds.join(", ")}: malformed or partial verdict table (expected id, verdict, evidence, artifact)${missing.length > 0 ? `; missing rows for ${missing.join(", ")}` : ""}`;
		}
		const branch = this.#host.sessionManager.getBranch();
		const requirements = getLatestRequirements(branch);
		const expected = expectedIds.map(id => requirements.find(requirement => requirement.id === id));
		if (expected.some(requirement => !requirement || requirement.classification !== "linked")) {
			return `${expectedIds.join(", ")}: requirements were relinked or removed after audit dispatch`;
		}
		if (requirementAuditSnapshot(requirements, expectedIds) !== assignment.snapshot) {
			return `${expectedIds.join(", ")}: requirement raw sources or linked rows changed after audit dispatch`;
		}
		const phases = getLatestTodoPhasesFromEntries(branch);
		const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
		const acceptedBoundHeads: Record<string, string> = {};
		for (const receipt of receipts) {
			const requirement = expected.find(entry => entry?.id === receipt.id)!;
			const artifacts: Array<{ row: string } & RequirementRowArtifact> = [];
			for (const row of requirement.rows) {
				artifacts.push({
					row,
					...(await bindRequirementRowArtifact(
						{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager },
						row,
						phases,
						this.#appender(),
						checkoutCache,
					)),
				});
			}
			for (const artifact of artifacts) {
				const boundHead = assignment.boundHeads?.[artifact.row];
				if (artifact.head && boundHead && artifact.head.toLowerCase() !== boundHead.toLowerCase()) {
					acceptedBoundHeads[artifact.row] = boundHead;
				}
			}
			if (
				!isFreshRequirementVerdict(
					{
						...requirement,
						verdict: {
							...receipt,
							status: "pass",
							workerId,
							auditor: "qa-auditor",
							boundHeads: assignment.boundHeads,
						},
					},
					artifacts,
				)
			) {
				return `${receipt.id}: artifact identity ${receipt.artifact} is not the current clean HEAD of every linked row; commit dirty work before QA`;
			}
		}
		const currentRequirements = getLatestRequirements(this.#host.sessionManager.getBranch());
		if (
			expectedIds.some(
				id => currentRequirements.find(requirement => requirement.id === id)?.classification !== "linked",
			) ||
			requirementAuditSnapshot(currentRequirements, expectedIds) !== assignment.snapshot
		) {
			return `${expectedIds.join(", ")}: requirement raw sources or linked rows changed during artifact resolution`;
		}
		appendRequirementsSnapshot(
			this.#appender(),
			currentRequirements.map(requirement => {
				const receipt = receipts.find(item => item.id === requirement.id);
				return receipt
					? {
							...requirement,
							verdict: {
								...receipt,
								workerId,
								auditor: "qa-auditor" as const,
								...(Object.keys(acceptedBoundHeads).length > 0 ? { boundHeads: acceptedBoundHeads } : {}),
							},
						}
					: requirement;
			}),
		);
		this.syncPublicationGate();
		return null;
	}

	/**
	 * Records or rejects one delivered `<task-result>` envelope for a pending
	 * auditor, whichever channel carried it (async batch or `wait` snapshot).
	 */
	async #consumeTaskResultEnvelope(
		workerId: string,
		content: string,
	): Promise<{ status: "accepted" } | { status: "rejected"; reason: string } | { status: "absent" }> {
		const key = this.#resolvePendingAuditorKey(workerId);
		const assignment = key ? this.#pendingAuditors.get(key) : undefined;
		if (!key || !assignment) return { status: "absent" };
		const envelope = (content.match(/<task-result id="[^"]+"[\s\S]*?<\/task-result>/g) ?? []).find(candidate => {
			const id = candidate.match(/^<task-result id="([^"]+)"/)?.[1];
			return typeof id === "string" && sameWorkerIdentity(id, workerId);
		});
		if (!envelope) return { status: "absent" };
		const sessionId = this.#sessionId();
		if (
			!sessionId ||
			assignment.sessionId !== sessionId ||
			assignment.agent !== "qa-auditor" ||
			(assignment.workerId !== undefined && !sameWorkerIdentity(assignment.workerId, workerId))
		) {
			return { status: "rejected", reason: "session or worker identity did not match" };
		}
		const header = envelope.match(/^<task-result id="([^"]+)" agent="([^"]+)" status="([^"]+)"[^>]*>/);
		if (!header || header[2] !== "qa-auditor" || header[3] !== "completed") {
			return { status: "rejected", reason: "result was incomplete, truncated, or not from qa-auditor" };
		}
		const preview = envelope.match(/<preview(?:\s[^>]*)?>([\s\S]*?)<\/preview>/)?.[1];
		const output = envelope.match(/<output>\s*([\s\S]*?)\s*<\/output>/)?.[1];
		let fullOutput: string | undefined;
		if (preview !== undefined) {
			for (const directory of artifactsDirsFromRegistry()) {
				try {
					fullOutput = await readFile(join(directory, `${header[1]}.md`), "utf8");
					break;
				} catch {}
			}
		}
		const receiptOutput = fullOutput ?? output ?? preview;
		if (receiptOutput === undefined) return { status: "rejected", reason: "result did not contain auditor output" };
		const issue = await this.#acceptReceipt(header[1]!, assignment, receiptOutput);
		return issue ? { status: "rejected", reason: issue } : { status: "accepted" };
	}

	/** A `wait` snapshot can recover a result the delivery path never auto-delivered. */
	async #consumeWaitSnapshot(result: unknown): Promise<void> {
		const content = resultText(result);
		if (!content || !content.includes("<task-result ")) return;
		this.#restorePendingAuditors();
		let pendingChanged = false;
		const acceptedIds: string[] = [];
		const deliveredIds = (content.match(/<task-result id="([^"]+)"/g) ?? []).map(tag =>
			tag.slice('<task-result id="'.length, -1),
		);
		for (const [key, assignment] of this.#pendingAuditors) {
			if (!deliveredIds.some(id => sameWorkerIdentity(id, key))) continue;
			const outcome = await this.#consumeTaskResultEnvelope(key, content);
			if (outcome.status === "absent") continue;
			if (outcome.status === "accepted") acceptedIds.push(...assignment.ids);
			else this.#persistPendingAuditors({ workerId: key, ids: assignment.ids, reason: outcome.reason });
			this.#pendingAuditors.delete(key);
			pendingChanged = true;
		}
		if (pendingChanged) this.#persistPendingAuditors(undefined, acceptedIds);
	}

	#resolvePendingAuditorKey(workerId: string): string | undefined {
		if (this.#pendingAuditors.has(workerId)) return workerId;
		for (const key of this.#pendingAuditors.keys()) if (sameWorkerIdentity(key, workerId)) return key;
		return undefined;
	}

	#restorePendingAuditors(): void {
		const restored = getPersistedRequirementAuditorAssignments(
			this.#host.sessionManager.getBranch(),
			this.#sessionId(),
			getLatestRequirements(this.#host.sessionManager.getBranch()),
		);
		this.#pendingAuditors.clear();
		for (const [workerId, assignment] of restored) this.#pendingAuditors.set(workerId, assignment);
	}

	#persistPendingAuditors(
		rejected?: { workerId: string; ids: string[]; reason: string },
		acceptedIds: readonly string[] = [],
	): void {
		const sessionId = this.#sessionId();
		if (!sessionId) return;
		const rejections = getPersistedRequirementAuditRejections(this.#host.sessionManager.getBranch(), sessionId);
		for (const id of acceptedIds) rejections.delete(id);
		if (rejected) {
			for (const id of rejected.ids) rejections.set(id, rejected.reason);
		}
		this.#host.sessionManager.appendCustomEntry(REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE, {
			version: 1,
			sessionId,
			jobs: [...this.#pendingAuditors.values()]
				.filter(
					assignment =>
						assignment.sessionId === sessionId &&
						assignment.workerId &&
						assignment.workerId !== rejected?.workerId,
				)
				.map(assignment => ({
					workerId: assignment.workerId,
					agent: assignment.agent,
					ids: assignment.ids,
					snapshot: assignment.snapshot,
					boundHeads: assignment.boundHeads,
				})),
			rejected: [...rejections].map(([id, reason]) => ({ workerId: "", ids: [id], reason })),
		});
	}

	#sessionId(): string | null {
		const id = this.#host.sessionManager.getHeader()?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	}

	#appender() {
		return {
			appendEntry: (customType: string, data?: unknown) =>
				this.#host.sessionManager.appendCustomEntry(customType, data),
		};
	}

	#getPublicationGeneration(): number {
		const branch = this.#host.sessionManager.getBranch();
		const state = JSON.stringify([getLatestRequirements(branch), getLatestTodoPhasesFromEntries(branch)]);
		if (state !== this.#publicationState) {
			this.#publicationState = state;
			this.#publicationGeneration++;
		}
		return this.#publicationGeneration;
	}
	syncPublicationGate(): void {
		const requirements = getLatestRequirements(this.#host.sessionManager.getBranch());
		const active =
			this.#host.agentKind() === "main" &&
			requirements.some(
				requirement => requirement.classification === "candidate" || requirement.classification === "linked",
			);
		const gate = active
			? (message: AssistantMessage, signal: AbortSignal) => this.#publicationGate(message, signal)
			: undefined;
		if (this.#host.setPublicationGate) this.#host.setPublicationGate(gate);
		else setAssistantPublicationGate(this.#host.agent, gate);
	}
}
