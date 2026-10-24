import {
	matchingRequirementBranch,
	latestRequirementsFromSession,
	matchingRequirementBranchNewestFirst,
	type RequirementEntryMetadata,
} from "./requirements-branch-selection";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Agent, AfterToolCallContext, AfterToolCallResult, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import { setAssistantPublicationGate } from "@oh-my-pi/pi-agent-core/assistant-publication";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { createHash } from "node:crypto";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import {
	appendRequirementsSnapshot,
	createRequirementCandidates,
	formatRequirementGateArtifact,
	formatUnclassifiedCandidateReminder,
	formatRequirementGateNotice,
	formatRequirementPublicationStatus,
	getLatestRequirements,
	getLinkedRequirementRows,
	getUnclassifiedRequirementCandidates,
	getPersistedRequirementAuditorAssignments,
	getPersistedRequirementAuditRejections,
	getRequirementAuditSources,
	getRequirementReceiptArtifactRowLabels,
	getRequirementRowArtifactIdentity,
	getRequirementRowVerdict,
	getRequirementVerdictSourceIssue,
	getRequirementVerdictStaleness,
	formatRequirementActionRefusal,
	evaluateRequirementDoneGate,
	type RequirementVerdict,
	type RequirementGateArtifact,
	parseRequirementReceipt,
	parseRequirementsLedger,
	requirementAuditSnapshot,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	requirementSourceDigest,
	requirementRowDeclarationSnapshot,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	type RequirementAuditAssignment,
	type RequirementImage,
	type RequirementLedgerItem,
} from "../tools/requirements-ledger";

/**
 * Map each `[Image #N]` marker in a requirement's raw words to the user
 * message's image content part N-1. Positional, matching
 * `AgentSession#extractUserMessageImages`. An image that resolves to neither a
 * source file nor bytes keeps no `sha256`, which marks the row
 * `needs-user-restatement` at capture time.
 */
function extractRequirementImages(rawText: string, images: readonly ImageContent[] | undefined): RequirementImage[] {
	if (!images?.length) return [];
	const seen = new Set<number>();
	const out: RequirementImage[] = [];
	for (const match of rawText.matchAll(/\[Image #(\d+)(?:[,\]][^\]]*)?\]/g)) {
		const index = Number(match[1]);
		if (!Number.isInteger(index) || index < 1 || seen.has(index)) continue;
		seen.add(index);
		const image = images[index - 1];
		if (!image) continue;
		const source = imageAttachmentSource(image);
		const bytes = Buffer.from(image.data ?? "", "base64");
		const sha256 = bytes.length > 0 ? createHash("sha256").update(bytes).digest("hex") : undefined;
		out.push({
			index,
			...(sha256 ? { sha256 } : {}),
			...(image.mimeType ? { mimeType: image.mimeType } : {}),
			...(source?.path ? { sourcePath: source.path } : {}),
			...(image.data ? { data: image.data } : {}),
		});
	}
	return out;
}

/** Payload shape the task tool forwards to the subagent's first message. */
export interface RequirementAuditImagePayload {
	type: "image";
	mimeType: string;
	sha256: string;
	rn: string;
	index: number;
	sourcePath?: string;
	artifactPath?: string;
}
import { ASYNC_RESULT_MESSAGE_TYPE } from "./async-job-delivery";
import type { SessionManager } from "./session-manager";
import { isFailedTaskSingleResult } from "../task/result-summary";
import { discoverAgents, getAgent } from "../task/discovery";
import {
	bindRequirementRowArtifact,
	getLatestTodoPhasesFromEntries,
	getRequirementRowArtifact,
	getTodoRowChanges,
	getTodoActionRows,
	USER_TODO_EDIT_CUSTOM_TYPE,
	type RequirementRowArtifact,
} from "../tools/todo";
import { BUNDLED_QA_AUDITOR_TEMPLATE } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";
import auditInputTemplate from "../prompts/session/requirements-ledger-audit-input.md" with { type: "text" };
import receiptHeader from "../prompts/session/requirements-ledger-receipt-header.md" with { type: "text" };
import flowNoticeTemplate from "../prompts/session/requirements-ledger-flow-notice.md" with { type: "text" };

function isTodoStateEntryMetadata(entry: RequirementEntryMetadata): boolean {
	return (
		(entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) ||
		(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo")
	);
}

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

function requirementArtifactState(artifact: RequirementGateArtifact): unknown {
	return {
		cwd: artifact.cwd,
		head: artifact.head,
		dirty: artifact.dirty,
		sha256: artifact.sha256,
		dirtyFingerprint: artifact.dirtyFingerprint,
		identities: artifact.identities,
		awaitingUser: artifact.awaitingUser,
	};
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
	queueModelNotice?(notice: string): void | Promise<void>;
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
	#noticeState = "";

	constructor(host: RequirementsLedgerRuntimeHost) {
		this.#host = host;
		this.#restorePendingAuditors();
		this.syncPublicationGate();
	}

	async captureCandidate(rawText: string, images?: readonly ImageContent[]): Promise<void> {
		if (this.#host.agentKind() !== "main" || !rawText.trim() || rawText.trimStart().startsWith("/")) return;
		const requirements = getLatestRequirements(
			matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			),
		);
		const referenced = extractRequirementImages(rawText, images);
		const before = requirements
			.filter(requirement => requirement.classification === "candidate")
			.map(requirement => requirement.id);
		appendRequirementsSnapshot(
			this.#appender(),
			createRequirementCandidates(requirements, [rawText], new Date().toISOString(), [referenced]),
		);
		const after = getUnclassifiedRequirementCandidates(
			matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			),
		);
		const added = after.filter(
			requirement => requirement.classification === "candidate" && !before.includes(requirement.id),
		);
		if (added.length > 0) {
			const branch = matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" || metadata.type === "message",
			);
			const rows = openTodoRowContents(branch);
			const ids = added.map(requirement => requirement.id);
			const details = formatUnclassifiedCandidateReminder(added, rows);
			await this.#announceFlowNotice(
				JSON.stringify(["candidate", ids, added.map(requirement => requirement.rawText)]),
				`Classify ${ids.join(", ")} before closing affected todo rows.`,
				details,
			);
		}
		this.syncPublicationGate();
	}

	/** Announce newly reachable todo gates and requirement-retention behavior before execution. */
	async beforeTodoCall(toolName: string, input: unknown, signal?: AbortSignal): Promise<void> {
		if (this.#host.agentKind() !== "main" || toolName !== "todo" || !isRecord(input)) return;
		const op = input.op;
		if (op !== "done" && op !== "rm" && op !== "drop" && op !== "init") return;
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
				isTodoStateEntryMetadata(metadata),
		);
		const requirements = getLatestRequirements(branch).filter(requirement => requirement.classification === "linked");
		const phases = getLatestTodoPhasesFromEntries(branch);
		const requested = getTodoActionRows(
			phases,
			input as {
				op: "done" | "rm" | "drop" | "init";
				task?: string;
				phase?: string;
				items?: string[];
				list?: Array<{ phase: string; items: string[] }>;
			},
		);
		const affected = requirements.flatMap(requirement =>
			requirement.rows.filter(row => requested.includes(row)).map(row => ({ requirement, row })),
		);
		if (affected.length === 0) return;
		if (op === "rm" || op === "init") {
			const transition = op === "init" ? "init replacement" : "removal";
			const details = affected
				.map(
					({ requirement, row }) =>
						`${requirement.id} stays linked to ${JSON.stringify(row)} after ${transition}; ledger history and verdicts are retained.`,
				)
				.join(" ");
			await this.#announceFlowNotice(
				JSON.stringify([transition, affected.map(({ requirement, row }) => [requirement.id, row])]),
				`Preserve or reclassify ${affected[0]!.requirement.id} before changing ${JSON.stringify(affected[0]!.row)}.`,
				details,
			);
			return;
		}
		if (op === "drop") {
			await this.#announceFlowNotice(
				JSON.stringify(["abandon", affected.map(({ requirement, row }) => [requirement.id, row])]),
				`Account for linked requirement ${affected[0]!.requirement.id} before abandoning its row.`,
				affected
					.map(
						({ requirement, row }) =>
							`${requirement.id} stays linked to ${JSON.stringify(row)}; ledger history and verdicts are retained.`,
					)
					.join(" "),
			);
			return;
		}
		await this.#announceFlowNotice(
			JSON.stringify(["complete", affected.map(({ requirement, row }) => [requirement.id, row])]),
			`Keep ${affected[0]!.requirement.id} linked while completing ${JSON.stringify(affected[0]!.row)}.`,
			affected
				.map(
					({ requirement, row }) =>
						`${requirement.id} remains in the ledger after completion of ${JSON.stringify(row)}; todo done requires its fresh qa-auditor verdict for the current row artifact.`,
				)
				.join(" "),
		);
		const linkedRows = [...new Set(affected.map(item => item.row))];
		const changes = getTodoRowChanges(branch);
		const staleRows: Array<{
			requirement: RequirementLedgerItem;
			row: string;
			artifact: RequirementGateArtifact;
			verdict: RequirementVerdict;
			lastChange?: { at: string; id: string };
		}> = [];
		for (const requirement of requirements) {
			for (const row of requirement.rows.filter(row => linkedRows.includes(row))) {
				const verdict = getRequirementRowVerdict(requirement, row);
				if (verdict?.status !== "pass") continue;
				const artifact = await getRequirementRowArtifact(
					{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager, signal },
					row,
					phases,
				);
				const lastChange = changes.get(row);
				if (getRequirementVerdictStaleness(requirement, [{ row, ...artifact, lastChange }]) !== null)
					staleRows.push({ requirement, row, artifact, verdict, lastChange });
			}
		}
		await this.#announceStaleRows(staleRows);
	}

	async #announceFlowNotice(key: string, action: string, details: string): Promise<void> {
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata => metadata.type === "custom" || metadata.type === "message",
		);
		if (
			branch.some(
				entry =>
					entry.type === "custom" &&
					entry.customType === "requirements_flow_notice" &&
					isRecord(entry.data) &&
					entry.data.key === key,
			)
		)
			return;
		this.#host.sessionManager.appendCustomEntry("requirements_flow_notice", { key });
		await this.#host.queueModelNotice?.(
			prompt.render(flowNoticeTemplate, { action, details: details.replace(/\s*\n\s*/g, " ") }),
		);
	}

	/**
	 * Pending candidates never block dispatch: an angry or urgent owner message
	 * must not delay the work. The reminder rides on the `task` result; the
	 * completion gates (todo done, publication) keep holding unclassified candidates.
	 */
	remindUnclassifiedCandidates(toolName: string, input?: unknown): BeforeToolCallResult | undefined {
		if (this.#host.agentKind() !== "main" || toolName !== "task") return undefined;
		if (
			isRecord(input) &&
			(input.action === "abort" || input.action === "cancel") &&
			!("task" in input) &&
			!("tasks" in input)
		) {
			return undefined;
		}
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata => metadata.type === "custom" || metadata.type === "message",
		);
		const candidates = getUnclassifiedRequirementCandidates(branch);
		if (candidates.length === 0) return undefined;
		return { additionalContext: formatUnclassifiedCandidateReminder(candidates, openTodoRowContents(branch)) };
	}

	/** Audit scope comes only from named workers' structured TODO ownership, never task prose or quoted IDs. */
	async prepareAuditorTaskCall(
		toolName: string,
		toolCallId: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<Record<string, unknown> | undefined> {
		if (this.#host.agentKind() !== "main" || toolName !== "task" || !isRecord(input)) return undefined;
		const sessionId = this.#sessionId();
		if (!sessionId) return undefined;

		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
				isTodoStateEntryMetadata(metadata),
		);
		const requirements = getLatestRequirements(branch);
		const phases = getLatestTodoPhasesFromEntries(branch);
		const multiple = Array.isArray(input.tasks);
		const items = multiple ? (input.tasks as unknown[]) : [input];
		const revised = [...items];
		const assignments: RequirementAuditAssignment[] = [];
		const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
		let imagesChanged = false;

		const scopes = items.map(item => {
			if (!isRecord(item) || item.agent !== "qa-auditor") return [];
			if (item.requirementIds !== undefined) {
				if (!Array.isArray(item.requirementIds) || item.requirementIds.length === 0)
					throw new Error(
						formatRequirementActionRefusal(
							`Retry task with requirementIds=["<linked ID>"] for the rows owned by qa-auditor.`,
							"QA requirementIds must be a nonempty array of linked requirement IDs.",
						),
					);
				const rows = phases.flatMap(phase => phase.tasks.map(task => task.content));
				return [
					...new Set(
						item.requirementIds.flatMap(id => {
							const requirement = requirements.find(requirement => requirement.id === id);
							if (!requirement || requirement.classification !== "linked" || requirement.rows.length === 0)
								throw new Error(
									formatRequirementActionRefusal(
										`Link ${String(id)} to an active Todo row, then retry task with requirementIds=[${JSON.stringify(String(id))}].`,
										`Active audit rows: ${JSON.stringify(rows)}; missing rows: ${JSON.stringify(requirement?.rows.filter(row => !rows.includes(row)) ?? [])}. Inspect the ledger with todo op="view".`,
									),
								);
							const linkedRows = getLinkedRequirementRows(requirement, rows);
							if (linkedRows.length === 0) {
								const missingRows = requirement.rows.filter(row => !rows.includes(row));
								throw new Error(
									formatRequirementActionRefusal(
										`Restore ${String(id)} rows with todo append, then retry task requirementIds=[${JSON.stringify(String(id))}].`,
										`Requested audit rows: ${JSON.stringify(requirement.rows)}; missing rows: ${JSON.stringify(missingRows)}. Restore with todo op="append", phase=${JSON.stringify(phases[0]?.name ?? "QA recovery")}, items=${JSON.stringify(missingRows)}.`,
									),
								);
							}
							return linkedRows;
						}),
					),
				];
			}
			if (typeof item.name !== "string") return [];
			return phases
				.flatMap(phase => phase.tasks)
				.flatMap(task => {
					const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : undefined;
					return schedule?.owner === item.name ? [task.content] : [];
				});
		});
		// Explicit requirement IDs are authoritative. Shared Todo rows must not
		// pull neighbouring requirements into an explicitly scoped audit.
		const requirementScopes = scopes.map((assignedRows, index) => {
			const item = items[index];
			if (!isRecord(item) || item.agent !== "qa-auditor") return [];
			const explicitIds = Array.isArray(item.requirementIds) ? item.requirementIds : undefined;
			return requirements
				.filter(
					requirement =>
						(!explicitIds || explicitIds.includes(requirement.id)) &&
						getLinkedRequirementRows(requirement, assignedRows).length > 0,
				)
				.map(requirement => requirement.id);
		});
		const hasAuditorTask = items.some(item => isRecord(item) && item.agent === "qa-auditor");
		const resolvedAuditor = hasAuditorTask
			? getAgent((await discoverAgents(this.#host.cwd())).agents, "qa-auditor")
			: undefined;
		if (hasAuditorTask && !(await isBundledQaAuditor(resolvedAuditor))) {
			const ids = [...new Set(requirementScopes.flat())];
			if (ids.length > 0)
				this.#auditorRefusals.set(toolCallId, { ids, source: resolvedAuditor?.source ?? "unavailable" });
			// The audit input stays on the task even for a non-bundled profile: a
			// worker must never be dispatched without the immutable QA AUDIT INPUT
			// block. The refusal above still rejects any receipt it returns.
		}
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			if (!isRecord(item) || item.agent !== "qa-auditor" || typeof item.task !== "string") continue;
			const assignedRows = scopes[index]!;
			const ids = requirementScopes[index]!;
			if (ids.length === 0 && !requirements.some(requirement => requirement.classification === "linked")) continue;
			if (ids.length === 0)
				throw new Error(
					formatRequirementActionRefusal(
						`Set linked requirementIds for ${String(item.name ?? "qa-auditor")} or match its name to a row owner.`,
						"QA audit has no linked requirement scope. Set requirementIds to linked IDs or match the Todo row schedule.owner.",
					),
				);

			const sources = [
				...new Map(
					ids
						.flatMap(id => getRequirementAuditSources(requirements, id))
						.map(source => [source.id, source] as const),
				).values(),
			];
			const rowHeads: string[] = [];
			const imagePayloads: RequirementAuditImagePayload[] = [];
			const imageLines: string[] = [];
			for (const source of sources) {
				for (const image of source.images ?? []) {
					const sourceExists = image.sourcePath ? await Bun.file(image.sourcePath).exists() : false;
					const artifactsDir = this.#host.sessionManager.getArtifactsDir();
					if (!sourceExists && image.data && image.sha256 && artifactsDir) {
						const artifactPath = image.artifactPath ?? join(artifactsDir, `requirement-image-${image.sha256}`);
						if (!(await Bun.file(artifactPath).exists()))
							await Bun.write(artifactPath, Buffer.from(image.data, "base64"));
						if (image.artifactPath !== artifactPath) {
							image.artifactPath = artifactPath;
							imagesChanged = true;
						}
					}
					const imagePath = sourceExists ? image.sourcePath : (image.artifactPath ?? image.sourcePath);
					imageLines.push(
						`${source.id} Image #${image.index}: sha256=${image.sha256 ?? "unavailable"}${imagePath ? `, source=${imagePath}` : ""}${!image.sha256 && !imagePath ? " (bytes and source path both gone)" : ""}${image.sha256 && !imagePath ? " (source unavailable)" : ""}`,
					);
					if (!image.sha256 || !imagePath) continue;
					imagePayloads.push({
						type: "image",
						mimeType: image.mimeType ?? "image/png",
						sha256: image.sha256,
						rn: source.id,
						index: image.index,
						...(image.sourcePath ? { sourcePath: image.sourcePath } : {}),
						...(image.artifactPath ? { artifactPath: image.artifactPath } : {}),
					});
				}
			}
			for (const id of ids) {
				const requirement = requirements.find(candidate => candidate.id === id)!;
				for (const row of getLinkedRequirementRows(requirement, assignedRows)) {
					const artifact = await bindRequirementRowArtifact(
						{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager, signal },
						row,
						phases,
						this.#appender(),
						checkoutCache,
					);
					rowHeads.push(
						`${id} ${formatRequirementGateArtifact(
							!artifact.head && !artifact.sha256
								? { ...artifact, lastChange: getTodoRowChanges(branch).get(row) }
								: artifact,
							row,
						)}`,
					);
				}
			}

			const protocol = prompt.render(auditInputTemplate, {
				sources: sources.map(
					source =>
						`${source.id} (said at ${source.at}, source sha256=${requirementSourceDigest(source.rawText)}): ${source.rawText}`,
				),
				imageLines,
				rowHeads,
				receiptHeader: receiptHeader.trim(),
			});
			revised[index] = {
				...item,
				task: `${item.task}\n\n${protocol}`,
				...(imagePayloads.length ? { images: imagePayloads } : {}),
			};
			assignments.push({
				ids,
				snapshot: requirementAuditSnapshot(requirements, ids),
				sessionId,
				agent: "qa-auditor",
				index,
				rows: assignedRows,
				rowDeclarations: requirementRowDeclarationSnapshot(phases, assignedRows),
			});
		}

		if (assignments.length === 0) return undefined;
		if (imagesChanged) appendRequirementsSnapshot(this.#appender(), requirements);
		this.#auditCalls.set(toolCallId, assignments);
		return multiple ? { ...input, tasks: revised } : { ...input, ...(revised[0] as Record<string, unknown>) };
	}

	async afterToolCall(context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
		if (this.#host.agentKind() !== "main") return undefined;
		if (context.toolCall.name === "todo" && !context.isError) {
			const details = isRecord(context.result.details) ? context.result.details : undefined;
			if (details && (details.op === "classify" || details.op === "start")) {
				const branch = matchingRequirementBranch(
					this.#host.sessionManager,
					metadata =>
						(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
						isTodoStateEntryMetadata(metadata),
				);
				const requirements = getLatestRequirements(branch).filter(item => item.classification === "linked");
				const phases = getLatestTodoPhasesFromEntries(branch);
				for (const requirement of requirements) {
					for (const row of requirement.rows) {
						if (!phases.some(phase => phase.tasks.some(task => task.content === row))) continue;
						const rowRequirements = requirements.filter(item => item.rows.includes(row));
						const ids = rowRequirements.map(item => item.id);
						const artifact = await getRequirementRowArtifact(
							{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager },
							row,
							phases,
						);
						const verdicts = rowRequirements.map(item => getRequirementRowVerdict(item, row));
						await this.#announceFlowNotice(
							JSON.stringify(["linked-row", row, ids, artifact, verdicts]),
							`Audit ${ids.join(", ")} on ${JSON.stringify(row)} before marking it done.`,
							`Closing this linked row requires a pass bound to ${formatRequirementGateArtifact(artifact, row)}. Call task({agent:"qa-auditor",name:"qa-auditor",requirementIds:${JSON.stringify(ids)},task:${JSON.stringify(`Audit ${ids.join(", ")} for TODO row ${JSON.stringify(row)} at its current artifact; return one receipt row per ID.`)}}).`,
						);
					}
				}
			}
		}
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
					{
						type: "text",
						text: formatRequirementActionRefusal(
							`Restore bundled qa-auditor for ${refusal.ids[0] ?? "the linked requirement"}, then retry the audit task.`,
							`Resolved profile is ${refusal.source}, not the bundled auditor. ${refusal.ids.map(id => `Call task with agent="qa-auditor", requirementIds=[${JSON.stringify(id)}], task="Audit ${id} at the current clean row HEAD"`).join("; ")}`,
						),
					},
					...context.result.content,
				],
			};
		}
		const assignments = this.#auditCalls.get(context.toolCall.id);
		if (!assignments) return undefined;
		this.#auditCalls.delete(context.toolCall.id);

		const rejected: string[] = [];
		let firstRejectedId: string | undefined;
		const details = isRecord(context.result.details) ? context.result.details : {};
		const results = Array.isArray(details.results) ? details.results : [];
		const progress = Array.isArray(details.progress) ? details.progress : [];
		let pendingChanged = false;
		for (const assignment of assignments) {
			if (context.isError) {
				// A pre-dispatch gate refusal launches no worker: keep the gate's own text, no audit-failure record.
				const launched =
					results.some(value => isRecord(value) && value.index === assignment.index) ||
					progress.some(value => isRecord(value) && value.index === assignment.index);
				if (launched) {
					firstRejectedId ??= assignment.ids[0];
					rejected.push(`${assignment.ids.join(", ")}: qa-auditor task failed`);
				}
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
					firstRejectedId ??= assignment.ids[0];
					rejected.push(`${assignment.ids.join(", ")}: not a complete qa-auditor result`);
					continue;
				}
				const issue = await this.#acceptReceipt(result.id, { ...assignment, workerId: result.id }, result.output);
				if (issue) {
					firstRejectedId ??= assignment.ids[0];
					rejected.push(issue);
					this.#persistPendingAuditors({ workerId: result.id, ids: assignment.ids, reason: issue });
				} else {
					this.#persistPendingAuditors(undefined, assignment.ids);
				}
				continue;
			}
			const worker = progress.find(value => isRecord(value) && value.index === assignment.index);
			if (isRecord(worker) && worker.agent === "qa-auditor" && typeof worker.id === "string" && worker.id) {
				this.#pendingAuditors.set(worker.id, { ...assignment, workerId: worker.id });
				pendingChanged = true;
			} else {
				firstRejectedId ??= assignment.ids[0];
				rejected.push(`${assignment.ids.join(", ")}: task result did not identify its qa-auditor worker`);
			}
		}
		if (pendingChanged) this.#persistPendingAuditors();
		if (rejected.length === 0) return undefined;
		return {
			content: [
				{
					type: "text",
					text: formatRequirementActionRefusal(
						`Repair the qa-auditor receipt for ${firstRejectedId ?? "the assigned requirement"}, then retry task.`,
						`requirements receipt rejected: ${rejected.join("; ")}.`,
					),
				},
				...context.result.content,
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
			// Display text escapes harness tags; machine intake uses the original per-job envelope.
			const result = typeof job.result === "string" ? job.result : content;
			const outcome = await this.#consumeTaskResultEnvelope(workerId, result);
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
		if (this.#host.agentKind() !== "main") {
			return;
		}
		// Provider failures and aborts must retain their actual text and error metadata.
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		let generation = this.#getPublicationGeneration();
		let freshness = await this.#refreshRequirementFreshness(signal);
		if (this.#getPublicationGeneration() !== generation) {
			generation = this.#getPublicationGeneration();
			freshness = await this.#refreshRequirementFreshness(signal);
			// Never erase the assistant's own text on a generation race: publish unchanged.
			if (this.#getPublicationGeneration() !== generation) return;
		}
		const decisionGeneration = this.#getPublicationGeneration();
		const { requirements, staleById, awaitingUserIssues } = freshness;
		await this.#announceStaleRows(freshness.staleRows);
		const open = this.#openRequirements(requirements, staleById);
		this.syncPublicationGate();
		// Never erase the assistant's own text on a generation race: publish unchanged.
		if (this.#getPublicationGeneration() !== decisionGeneration) return;
		if (open.length === 0) {
			this.#noticeState = "";
			return;
		}
		// With tool calls the text stays as it is: the gate only appends to final text.
		if (message.content.some(block => block.type === "toolCall")) return;
		const noticeState = JSON.stringify(open.map(item => [item.requirement.id, item.issues]));
		if (noticeState !== this.#noticeState) {
			if (freshness.staleRows.length === 0)
				await this.#host.queueModelNotice?.(
					formatRequirementGateNotice(
						open.map(item => ({
							...item,
							awaitingUser: item.issues.every(issue => awaitingUserIssues.has(issue)),
						})),
					),
				);
			this.#noticeState = noticeState;
		}
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "message" && metadata.messageRole === "user") ||
				(metadata.type === "custom" && metadata.customType === "requirements_awaiting_user_notice"),
		);
		const userMessage = branch.findLast(entry => entry.type === "message" && entry.message.role === "user");
		const announced = new Set<string>();
		for (const entry of branch) {
			if (
				entry.type !== "custom" ||
				entry.customType !== "requirements_awaiting_user_notice" ||
				!isRecord(entry.data)
			)
				continue;
			if (Array.isArray(entry.data.keys))
				for (const key of entry.data.keys) if (typeof key === "string") announced.add(key);
		}
		const newKeys: string[] = [];
		const visible = open.flatMap(item => {
			const issues = item.issues.filter(issue => {
				// Only explicit user-owned checks are quieted. Agent-side failures keep blocking every turn.
				if (!awaitingUserIssues.has(issue)) return true;
				const key = JSON.stringify([userMessage?.id ?? null, item.requirement.id, item.requirement.rawText, issue]);
				if (announced.has(key)) return false;
				newKeys.push(key);
				return true;
			});
			return issues.length
				? [{ ...item, issues, awaitingUser: issues.every(issue => awaitingUserIssues.has(issue)) }]
				: [];
		});
		if (visible.length === 0) return;
		if (newKeys.length)
			this.#host.sessionManager.appendCustomEntry("requirements_awaiting_user_notice", { keys: newKeys });
		const total = requirements.filter(
			item => item.classification === "candidate" || item.classification === "linked",
		).length;
		this.#host.onSettledAssistantMessage(message);
		const notice = formatRequirementPublicationStatus(visible, total);
		const original = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		return {
			replacementText: original ? `${original}\n\n${notice}` : notice,
			settled: true,
		};
	}

	async #refreshRequirementFreshness(signal?: AbortSignal): Promise<{
		requirements: RequirementLedgerItem[];
		staleById: Map<string, string[]>;
		awaitingUserIssues: Set<string>;
		staleRows: Array<{
			requirement: RequirementLedgerItem;
			row: string;
			artifact: RequirementGateArtifact;
			verdict: RequirementVerdict;
			lastChange?: { at: string; id: string };
		}>;
	}> {
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
				(metadata.type === "custom" && metadata.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE) ||
				isTodoStateEntryMetadata(metadata),
		);
		const requirements = getLatestRequirements(branch);
		const phases = getLatestTodoPhasesFromEntries(branch);
		const changes = getTodoRowChanges(branch);
		const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
		const open = await evaluateRequirementDoneGate(
			requirements,
			[...new Set(requirements.filter(item => item.classification === "linked").flatMap(item => item.rows))],
			async (row, receipt) => ({
				...(await getRequirementRowArtifact(
					{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager, signal, receipt },
					row,
					phases,
					checkoutCache,
				)),
				lastChange: changes.get(row),
			}),
			getPersistedRequirementAuditRejections(branch, this.#sessionId()),
		);
		const staleRows = open.flatMap(item => {
			if (!item.issues.some(issue => issue.includes("freshness check failed"))) return [];
			return item.auditRows.flatMap(audit => {
				const verdict = getRequirementRowVerdict(item.requirement, audit.row);
				return verdict?.status === "pass" && audit.ids.includes(item.requirement.id)
					? [
							{
								requirement: item.requirement,
								row: audit.row,
								artifact: audit.artifact,
								verdict,
								lastChange: changes.get(audit.row),
							},
						]
					: [];
			});
		});
		return {
			requirements,
			staleById: new Map(open.map(item => [item.requirement.id, item.issues])),
			awaitingUserIssues: new Set(open.flatMap(item => item.awaitingUserIssues)),
			staleRows,
		};
	}

	async #announceStaleRows(
		staleRows: readonly {
			requirement: RequirementLedgerItem;
			row: string;
			artifact: RequirementGateArtifact;
			verdict: RequirementVerdict;
			lastChange?: { at: string; id: string };
		}[],
	): Promise<void> {
		for (const { requirement, row, artifact, verdict, lastChange } of staleRows) {
			const artifactText = formatRequirementGateArtifact(artifact, row);
			const key = JSON.stringify([
				"stale",
				requirement.id,
				row,
				requirementArtifactState(artifact),
				verdict,
				lastChange,
			]);
			await this.#announceFlowNotice(
				key,
				`Re-audit ${requirement.id} for ${JSON.stringify(row)} before publishing.`,
				`The saved pass for ${verdict.artifact} is stale for this row artifact (${artifactText}). Call task({agent:"qa-auditor",name:"qa-auditor",requirementIds:${JSON.stringify([requirement.id])},task:${JSON.stringify(`Audit ${requirement.id} for TODO row ${JSON.stringify(row)} at its current artifact; return one receipt row for this exact ID.`)}}).`,
			);
		}
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
			// Linked-row decisions and reasons were already computed by the shared gate.
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
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
				isTodoStateEntryMetadata(metadata),
		);
		const requirements = getLatestRequirements(branch);
		const expected = expectedIds.map(id => requirements.find(requirement => requirement.id === id));
		if (expected.some(requirement => !requirement || requirement.classification !== "linked")) {
			return `${expectedIds.join(", ")}: requirements were relinked or removed after audit dispatch`;
		}
		if (requirementAuditSnapshot(requirements, expectedIds) !== assignment.snapshot) {
			return `${expectedIds.join(", ")}: requirement raw sources or linked rows changed after audit dispatch`;
		}
		let identityFailure: string | undefined;
		const receipts = parseRequirementReceipt(
			output,
			expectedIds,
			new Map(expected.map(requirement => [requirement!.id, requirement!.rawText])),
			(receivedId, expectedParentId) => {
				identityFailure ??= `${expectedParentId}: received requirement ID ${receivedId}; restate one row with exact assigned ID ${expectedParentId}, verdict pass|fail|unverifiable, all clause evidence, and one unchanged assigned artifact identity. Do not mix parent and sub-row IDs or discard a failing clause.`;
			},
		);
		if (!receipts) {
			if (identityFailure) return identityFailure;
			const covered = new Set([...output.matchAll(/\|\s*(R[1-9]\d*)\s*\|/g)].map(match => match[1]!));
			const missing = expectedIds.filter(id => !covered.has(id));
			return `${expectedIds.join(", ")}: malformed or partial verdict table (expected id, verdict, evidence, artifact)${missing.length > 0 ? `; missing rows for ${missing.join(", ")}` : ""}`;
		}
		const phases = getLatestTodoPhasesFromEntries(branch);
		const changes = getTodoRowChanges(branch);
		// Declared targets must still match dispatch before any typed probe can reach a newly declared URL or unit.
		if (
			assignment.rowDeclarations !== undefined &&
			requirementRowDeclarationSnapshot(phases, assignment.rows ?? []) !== assignment.rowDeclarations
		) {
			return `${expectedIds.join(", ")}: row artifact declarations have changed after audit dispatch`;
		}
		const checkoutCache = new Map<string, Promise<RequirementRowArtifact>>();
		const updates = new Map<string, Record<string, RequirementVerdict>>();
		for (const receipt of receipts) {
			const requirement = expected.find(entry => entry?.id === receipt.id)!;
			const knownRows = new Set([
				...requirements.flatMap(requirement => requirement.rows),
				...phases.flatMap(phase => phase.tasks.map(task => task.content)),
			]);
			const scopedRows = requirement.rows.filter(row => !assignment.rows || assignment.rows.includes(row));
			// The authenticated assignment snapshot supplies canonical source words;
			// the auditor's optional prose echo is not requirement identity.
			const sourceIssue = getRequirementVerdictSourceIssue(requirement, scopedRows[0] ?? requirement.rows[0]!, {
				status: "pass",
				evidence: receipt.evidence,
				artifact: receipt.artifact,
				rawWords: receipt.rawWords,
				workerId,
				auditor: "qa-auditor",
			});
			if (sourceIssue) return `${receipt.id}: ${sourceIssue}`;
			const namedRows = requirement.rows.filter(
				row => getRequirementRowArtifactIdentity(receipt.artifact, row, scopedRows, knownRows) !== undefined,
			);
			// A label naming a linked-but-unassigned row, or any label when no assigned row
			// is named, is out of scope; reject before any artifact identity check and name
			// both sides. Unrelated `x @ y` evidence beside an assigned row stays evidence.
			const artifactLabels = getRequirementReceiptArtifactRowLabels(receipt.artifact, knownRows);
			const outsideLabels = artifactLabels.filter(
				label => !scopedRows.includes(label) && (requirement.rows.includes(label) || namedRows.length === 0),
			);
			if (outsideLabels.length > 0) {
				// Retry form names only the assigned rows' own current typed identities; no foreign target is probed.
				const retries: string[] = [];
				for (const row of scopedRows) {
					const own = await getRequirementRowArtifact(
						{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager },
						row,
						phases,
						checkoutCache,
					);
					if (own.identities?.length) retries.push(formatRequirementGateArtifact(own, row));
				}
				return `${receipt.id}: artifact names a row outside this audit assignment (assigned: ${scopedRows.map(row => JSON.stringify(row)).join(", ") || "none"}; named: ${artifactLabels.map(label => JSON.stringify(label)).join(", ")})${retries.length ? `; retry with ${retries.join("; ")}` : ""}`;
			}
			const rows = namedRows.length ? namedRows : scopedRows;
			if (!rows.length) return `${receipt.id}: receipt did not identify an assigned TODO row`;
			const rowVerdicts: Record<string, RequirementVerdict> = {};
			for (const row of rows) {
				const identity = getRequirementRowArtifactIdentity(receipt.artifact, row, rows, knownRows);
				const artifact = await bindRequirementRowArtifact(
					{ cwd: this.#host.cwd(), sessionManager: this.#host.sessionManager, receipt: identity },
					row,
					phases,
					this.#appender(),
					checkoutCache,
				);
				const lastChange = changes.get(row);
				const receivedAt = new Date().toISOString();
				if (identity === undefined)
					return `${receipt.id}: artifact identity did not identify ${JSON.stringify(row)}; resolved checkout: ${formatRequirementGateArtifact(artifact)}`;
				const verdict: RequirementVerdict = {
					status: receipt.status,
					evidence: receipt.evidence,
					artifact: identity,
					rawWords: receipt.rawWords,
					workerId,
					auditor: "qa-auditor",
					receivedAt,
					...((!artifact.head || artifact.dirty) && !artifact.identityCheck && lastChange
						? { rowChangeId: lastChange.id }
						: {}),
				};
				const staleReason = getRequirementVerdictStaleness(
					{ ...requirement, rowVerdicts: { [row]: { ...verdict, status: "pass" } } },
					[{ row, ...artifact, lastChange }],
				);
				if (staleReason !== null) {
					return `${receipt.id}: ${staleReason}; row ${JSON.stringify(row)} resolved checkout: ${formatRequirementGateArtifact(artifact, artifact.identities?.length ? row : undefined)}`;
				}
				Object.defineProperty(rowVerdicts, row, {
					value: verdict,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			updates.set(receipt.id, rowVerdicts);
		}
		const currentRequirements = getLatestRequirements(
			matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			),
		);
		if (
			expectedIds.some(
				id => currentRequirements.find(requirement => requirement.id === id)?.classification !== "linked",
			) ||
			requirementAuditSnapshot(currentRequirements, expectedIds) !== assignment.snapshot ||
			(assignment.rowDeclarations !== undefined &&
				requirementRowDeclarationSnapshot(
					getLatestTodoPhasesFromEntries(
						matchingRequirementBranch(this.#host.sessionManager, isTodoStateEntryMetadata),
					),
					assignment.rows ?? [],
				) !== assignment.rowDeclarations)
		) {
			return `${expectedIds.join(", ")}: requirement raw sources or linked rows changed during artifact resolution`;
		}
		appendRequirementsSnapshot(
			this.#appender(),
			currentRequirements.map(requirement => {
				const update = updates.get(requirement.id);
				if (!update) return requirement;
				const rowVerdicts = { ...requirement.rowVerdicts, ...update };
				return { ...requirement, rowVerdicts };
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
		const sessionId = this.#sessionId();
		let requirements: RequirementLedgerItem[] = [];
		let assignmentEntry: import("./session-entries").SessionEntry | undefined;
		let foundLedger = false;
		for (const entry of matchingRequirementBranchNewestFirst(
			this.#host.sessionManager,
			metadata =>
				metadata.type === "custom" &&
				(metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE ||
					metadata.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE),
		)) {
			if (entry.type !== "custom") continue;
			if (!foundLedger && entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) {
				const ledger = parseRequirementsLedger(entry.data);
				if (ledger) {
					requirements = ledger.requirements;
					foundLedger = true;
				}
			}
			if (
				!assignmentEntry &&
				entry.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE &&
				isRecord(entry.data) &&
				entry.data.sessionId === sessionId
			)
				assignmentEntry = entry;
			if (foundLedger && assignmentEntry) break;
		}
		const restored = getPersistedRequirementAuditorAssignments(
			assignmentEntry ? [assignmentEntry] : [],
			sessionId,
			requirements,
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
		const rejections = getPersistedRequirementAuditRejections(
			matchingRequirementBranch(
				this.#host.sessionManager,
				metadata =>
					metadata.type === "custom" && metadata.customType === REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
			),
			sessionId,
		);
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
					rows: assignment.rows,
					rowDeclarations: assignment.rowDeclarations,
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
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
				isTodoStateEntryMetadata(metadata),
		);
		const state = JSON.stringify([getLatestRequirements(branch), getLatestTodoPhasesFromEntries(branch)]);
		if (state !== this.#publicationState) {
			this.#publicationState = state;
			this.#publicationGeneration++;
		}
		return this.#publicationGeneration;
	}
	syncPublicationGate(): void {
		const requirements = latestRequirementsFromSession(this.#host.sessionManager);
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
