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
	getRequirementAuditSources,
	isFreshRequirementVerdict,
	parseRequirementReceipt,
	requirementAuditSnapshot,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	type RequirementAuditAssignment,
	type RequirementLedgerItem,
} from "../tools/requirements-ledger";
import {
	bindRequirementRowArtifact,
	getLatestTodoPhasesFromEntries,
	getRequirementRowArtifact,
	type RequirementRowArtifact,
} from "../tools/todo";
import { ASYNC_RESULT_MESSAGE_TYPE } from "./async-job-delivery";
import type { SessionManager } from "./session-manager";
import { isFailedTaskSingleResult } from "../task/result-summary";
import { discoverAgents, getAgent } from "../task/discovery";

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
		const branch = this.#host.sessionManager.getBranch();
		const overdue = getOverdueRequirementCandidates(branch);
		if (overdue.length === 0) return undefined;
		const rows = getLatestTodoPhasesFromEntries(branch).flatMap(phase => phase.tasks.map(task => task.content));
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
		if (hasAuditorTask && resolvedAuditor?.source !== "bundled") {
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
			return undefined;
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
			});
		}

		if (assignments.length === 0) return undefined;
		this.#auditCalls.set(toolCallId, assignments);
		return multiple ? { ...input, tasks: revised } : { ...input, task: (revised[0] as Record<string, unknown>).task };
	}

	async afterToolCall(context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
		if (this.#host.agentKind() !== "main" || context.toolCall.name !== "task") return undefined;
		const refusal = this.#auditorRefusals.get(context.toolCall.id);
		if (refusal) {
			this.#auditorRefusals.delete(context.toolCall.id);
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
		const sessionId = this.#sessionId();
		let pendingChanged = false;
		for (const job of message.details.jobs) {
			if (!isRecord(job) || job.type !== "task" || typeof job.jobId !== "string") continue;
			const workerId = typeof job.agentId === "string" && job.agentId ? job.agentId : job.jobId;
			const assignment = this.#pendingAuditors.get(workerId);
			if (!assignment) continue;
			let rejection: string | undefined;
			if (
				!sessionId ||
				assignment.sessionId !== sessionId ||
				assignment.agent !== "qa-auditor" ||
				assignment.workerId !== workerId
			) {
				rejection = "async result session or worker identity did not match";
			} else {
				const envelope = (content.match(/<task-result id="[^"]+"[\s\S]*?<\/task-result>/g) ?? []).find(candidate =>
					candidate.startsWith(`<task-result id="${workerId}" `),
				);
				const match = envelope?.match(
					/^<task-result id="([^"]+)" agent="([^"]+)" status="([^"]+)"[^>]*>[\s\S]*?<output>\s*([\s\S]*?)\s*<\/output>[\s\S]*?<\/task-result>$/,
				);
				if (
					!match ||
					match[1] !== workerId ||
					match[2] !== "qa-auditor" ||
					match[3] !== "completed" ||
					envelope?.includes("<preview")
				) {
					rejection = "async result was incomplete, truncated, or not from qa-auditor";
				} else {
					rejection = (await this.#acceptReceipt(workerId, assignment, match[4]!)) ?? undefined;
				}
			}
			if (rejection) this.#persistPendingAuditors({ workerId, ids: assignment.ids, reason: rejection });
			this.#pendingAuditors.delete(workerId);
			pendingChanged = true;
		}
		if (pendingChanged) this.#persistPendingAuditors();
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
			if (this.#getPublicationGeneration() !== generation) return { replacementText: "" };
		}
		const decisionGeneration = this.#getPublicationGeneration();
		const { requirements, staleById } = freshness;
		const open = this.#openRequirements(requirements, staleById);
		this.syncPublicationGate();
		if (this.#getPublicationGeneration() !== decisionGeneration) return { replacementText: "" };
		if (open.length === 0) return;
		if (message.content.some(block => block.type === "toolCall")) return { replacementText: "" };
		const rows = getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranch()).flatMap(phase =>
			phase.tasks.map(task => task.content),
		);
		this.#host.onSettledAssistantMessage(message);
		return {
			replacementText: formatPublicationReplacement(open, rows),
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
			if (!verdict) open.push({ requirement, issues: [`${requirement.id} needs a fresh qa-auditor pass`] });
			else if (verdict.status === "fail")
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
			(assignment.workerId !== undefined && assignment.workerId !== workerId)
		) {
			return `${expectedIds.join(", ")}: auditor assignment session or worker identity did not match`;
		}
		const receipts = parseRequirementReceipt(output, expectedIds);
		if (!receipts)
			return `${expectedIds.join(", ")}: malformed or partial verdict table (expected id, verdict, evidence, artifact)`;
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
			if (
				!isFreshRequirementVerdict(
					{
						...requirement,
						verdict: { ...receipt, status: "pass", workerId, auditor: "qa-auditor" },
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
					? { ...requirement, verdict: { ...receipt, workerId, auditor: "qa-auditor" as const } }
					: requirement;
			}),
		);
		this.syncPublicationGate();
		return null;
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

	#persistPendingAuditors(rejected?: { workerId: string; ids: string[]; reason: string }): void {
		const sessionId = this.#sessionId();
		if (!sessionId) return;
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
				})),
			...(rejected
				? { rejected: [{ workerId: rejected.workerId, ids: rejected.ids, reason: rejected.reason }] }
				: {}),
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
