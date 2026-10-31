import {
	matchingRequirementBranch,
	latestRequirementsFromSession,
	matchingRequirementBranchNewestFirst,
	type RequirementEntryMetadata,
} from "./requirements-branch-selection";
import * as path from "node:path";

import type { Agent, AfterToolCallContext, AfterToolCallResult, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import { setAssistantPublicationGate } from "@oh-my-pi/pi-agent-core/assistant-publication";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { imageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
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
	invalidateStaleRequirementVerdicts,
	type RequirementVerdict,
	type RequirementGateArtifact,
	parseRequirementReceipt,
	parseRequirementsLedger,
	requirementAuditSnapshot,
	REQUIREMENTS_LEDGER_CUSTOM_TYPE,
	requirementSourceSnapshot,
	requirementRowDeclarationSnapshot,
	REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE,
	type RequirementAuditAssignment,
	type RequirementImage,
	type RequirementLedgerItem,
	type RequirementDoneGateIssue,
} from "../tools/requirements-ledger";

/** Capture every attachment; editor markers are optional SDK presentation. */
function extractRequirementImages(images: readonly ImageContent[] | undefined): RequirementImage[] {
	return (images ?? []).map((image, offset) => {
		const source = imageAttachmentSource(image);
		const bytes = Buffer.from(image.data ?? "", "base64");
		const sha256 = bytes.length > 0 ? new Bun.CryptoHasher("sha256").update(bytes).digest("hex") : undefined;
		return {
			index: offset + 1,
			...(sha256 ? { sha256 } : {}),
			...(image.mimeType ? { mimeType: image.mimeType } : {}),
			...(source?.path ? { sourcePath: source.path } : {}),
			...(image.data ? { data: image.data } : {}),
		};
	});
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
import type { SessionEntry } from "./session-entries";
import { sha256File } from "../utils/file-hash";
import type { RequirementIdentity } from "../utils/requirement-artifact";
import auditInputTemplate from "../prompts/session/requirements-ledger-audit-input.md" with { type: "text" };
import receiptHeader from "../prompts/session/requirements-ledger-receipt-header.md" with { type: "text" };
import flowNoticeTemplate from "../prompts/session/requirements-ledger-flow-notice.md" with { type: "text" };
import unavailableToolsTemplate from "../prompts/session/requirements-ledger-tools-unavailable.md" with { type: "text" };

function isTodoStateEntryMetadata(entry: RequirementEntryMetadata): boolean {
	return (
		(entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) ||
		(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo")
	);
}

/** The harness renames a worker whose requested name is taken by appending `-<n>`. */
function sameWorkerIdentity(a: string, b: string): boolean {
	return a === b || (b.startsWith(`${a}-`) && /^\d+$/.test(b.slice(a.length + 1)));
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
		const agentContent = await Bun.file(agent.filePath).text();
		return agentContent.replace(/\r\n/g, "\n") === BUNDLED_QA_AUDITOR_TEMPLATE.replace(/\r\n/g, "\n");
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

/**
 * A checkout-resolved artifact carries its commit in `head`; a receipt-typed one carries the same
 * commit in a path-less Git identity for that checkout. Compare both shapes at one commit location.
 */
function comparableArtifactState(state: unknown): string {
	const value = { ...(state as { cwd?: string; head?: string | null; identities?: RequirementIdentity[] }) };
	const git = value.identities?.filter(
		identity => identity.kind === "git" && identity.paths === undefined && identity.repo === value.cwd,
	);
	if (!value.head && value.identities?.length === 1 && git?.length === 1 && git[0]!.kind === "git") {
		value.head = git[0]!.commit;
		delete value.identities;
	}
	return JSON.stringify(value);
}

/** Exact audit target carrier. It may narrow an already structured row scope, never create one. */
function getAuditItemRowArtifact(
	item: Record<string, unknown>,
	row: string,
	rows: readonly string[],
	knownRows: ReadonlySet<string>,
): string | undefined {
	if (typeof item.artifact === "string") return getRequirementRowArtifactIdentity(item.artifact, row, rows, knownRows);
	if (typeof item.task !== "string") return undefined;
	const marker = `row ${JSON.stringify(row)} @ `;
	const start = item.task.indexOf(marker);
	if (start < 0) return undefined;
	const typed = /^(?:git|file|deploy):[^\s,;]+/.exec(item.task.slice(start + marker.length))?.[0];
	return typed ? `${marker}${typed}` : undefined;
}

export type RequirementPublicationGate = (
	message: AssistantMessage,
	signal: AbortSignal,
) =>
	| void
	| { replacementText: string; settled?: true; preserveImages?: true }
	| Promise<void | { replacementText: string; settled?: true; preserveImages?: true }>;

export interface PreparedRequirementCandidate {
	sessionId: string;
	sourceText: string;
	images: RequirementImage[];
}

export interface RequirementCandidateNotice {
	sessionId: string;
	key: string;
	action: string;
	details: string;
}

export interface RequirementCandidateCommit {
	committed: boolean;
	notice?: RequirementCandidateNotice;
	candidateIds?: string[];
}

export interface RequirementsLedgerRuntimeHost {
	agent: Agent;
	agentKind(): "main" | "sub";
	cwd(): string;
	sessionManager: SessionManager;
	onSettledAssistantMessage(message: AssistantMessage): void;
	queueModelNotice?(notice: string): void | Promise<void>;
	setTodoPhases?(phases: TodoPhase[]): void;
	setPublicationGate?(gate: RequirementPublicationGate | undefined): void;
}

/** Owns main-session requirement capture, QA receipts, and completion gates. */
export class RequirementsLedgerRuntime {
	readonly #host: RequirementsLedgerRuntimeHost;
	readonly #auditCalls = new Map<string, RequirementAuditAssignment[]>();
	readonly #pendingAuditors = new Map<string, RequirementAuditAssignment>();
	#publicationGeneration = 0;
	#publicationState = "";
	#noticeState = "";
	#linkedRowNotices: Promise<void> = Promise.resolve();
	readonly #stablePublicationGate: RequirementPublicationGate = (message, signal) =>
		this.#publicationGate(message, signal);

	constructor(host: RequirementsLedgerRuntimeHost) {
		this.#host = host;
		this.#restorePendingAuditors();
		this.syncPublicationGate();
	}

	async prepareCandidate(
		rawText: string,
		images?: readonly ImageContent[],
	): Promise<PreparedRequirementCandidate | undefined> {
		if (this.#host.agentKind() !== "main" || (!rawText.trim() && !images?.length)) return;
		const sessionId = this.#sessionId();
		if (!sessionId) return;
		const referenced = extractRequirementImages(images);
		await this.#materializeImages(referenced, this.#host.sessionManager.getArtifactsDir());
		if (this.#sessionId() !== sessionId) return;
		// An image-only ask has no words to preserve; its positional markers are
		// its durable textual identity, while SHA-addressed files retain pixels.
		const sourceText = rawText.trim() ? rawText : referenced.map(image => `[Image #${image.index}]`).join(" ");
		return { sessionId, sourceText, images: referenced };
	}

	/** Synchronously commit a prepared candidate at the exact input-admission boundary. */
	commitCandidate(prepared: PreparedRequirementCandidate): RequirementCandidateCommit {
		if (this.#host.agentKind() !== "main" || this.#sessionId() !== prepared.sessionId) return { committed: false };
		const requirements = getLatestRequirements(
			matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			),
		);
		const before = requirements
			.filter(requirement => requirement.classification === "candidate")
			.map(requirement => requirement.id);
		appendRequirementsSnapshot(
			this.#appender(),
			createRequirementCandidates(requirements, [prepared.sourceText], new Date().toISOString(), [prepared.images]),
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
		let notice: RequirementCandidateNotice | undefined;
		if (added.length > 0) {
			const branch = matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" || metadata.type === "message",
			);
			const rows = openTodoRowContents(branch);
			const ids = added.map(requirement => requirement.id);
			const details = formatUnclassifiedCandidateReminder(added, rows);
			notice = {
				sessionId: prepared.sessionId,
				key: JSON.stringify(["candidate", ids, added.map(requirement => requirement.rawText)]),
				action: `Classify ${ids.join(", ")} before closing affected todo rows.`,
				details,
			};
		}
		this.syncPublicationGate();
		return { committed: true, candidateIds: added.map(requirement => requirement.id), ...(notice ? { notice } : {}) };
	}

	/** A removed queue entry is an owner withdrawal, not an unfinished obligation. */
	withdrawQueuedCandidates(sessionId: string, ids: readonly string[]): void {
		if (this.#sessionId() !== sessionId || ids.length === 0) return;
		const requirements = getLatestRequirements(
			matchingRequirementBranch(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE,
			),
		);
		const withdrawn = requirements.map(requirement =>
			ids.includes(requirement.id) &&
			(requirement.classification === "candidate" || requirement.classification === "linked")
				? {
						...requirement,
						classification: "not-a-requirement" as const,
						rows: [],
						reason: "User withdrew the queued message before delivery",
					}
				: requirement,
		);
		if (withdrawn.some((requirement, index) => requirement !== requirements[index])) {
			appendRequirementsSnapshot(this.#appender(), withdrawn);
			this.syncPublicationGate();
		}
	}

	async announceCandidateNotice(notice: RequirementCandidateNotice | undefined): Promise<void> {
		if (!notice || this.#sessionId() !== notice.sessionId) return;
		await this.#announceFlowNotice(notice.key, notice.action, notice.details);
	}

	async captureCandidate(rawText: string, images?: readonly ImageContent[]): Promise<void> {
		const prepared = await this.prepareCandidate(rawText, images);
		if (!prepared) return;
		const committed = this.commitCandidate(prepared);
		if (committed.committed) await this.announceCandidateNotice(committed.notice);
	}

	/** Persist captured pixels once, even if a mutable source file still exists. */
	async #materializeImages(images: RequirementImage[], artifactsDir: string | null): Promise<void> {
		for (const image of images) {
			if (image.data && image.sha256 && artifactsDir) {
				const bytes = Buffer.from(image.data, "base64");
				if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== image.sha256) continue;
				const artifactPath = path.join(artifactsDir, `requirement-image-${image.sha256}`);
				let matches = false;
				try {
					matches = (await sha256File(artifactPath)) === image.sha256;
				} catch {}
				if (!matches) await Bun.write(artifactPath, bytes);
				image.artifactPath = artifactPath;
				delete image.data;
			}
		}
	}

	/** Announce newly reachable todo gates and requirement-retention behavior before execution. */
	async beforeTodoCall(toolName: string, input: unknown, _signal?: AbortSignal): Promise<void> {
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
		const rows = openTodoRowContents(branch);
		const user = branch.findLast(entry => entry.type === "message" && entry.message.role === "user");
		const key = JSON.stringify([user?.id ?? null, candidates.map(item => [item.id, item.rawText]), rows]);
		const previous = branch.findLast(
			entry => entry.type === "custom" && entry.customType === "requirements_candidate_reminder",
		);
		if (previous?.type === "custom" && isRecord(previous.data) && previous.data.key === key) return undefined;
		this.#host.sessionManager.appendCustomEntry("requirements_candidate_reminder", { key });
		return { additionalContext: formatUnclassifiedCandidateReminder(candidates, rows) };
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
		const missingImages = new Set<string>();

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
				const rows = [
					...new Set([
						...phases.flatMap(phase => phase.tasks.map(task => task.content)),
						...getTodoRowChanges(branch).keys(),
					]),
				];
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
			throw new Error(
				formatRequirementActionRefusal(
					"Restore the bundled qa-auditor profile, then retry the audit task.",
					`Resolved qa-auditor profile is ${resolvedAuditor?.source ?? "unavailable"}; dispatch requires the bundled auditor.`,
				),
			);
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
			const rowArtifacts: Record<string, string> = {};
			const declaredArtifacts: string[] = [];
			const imagePayloads: RequirementAuditImagePayload[] = [];
			const imageLines: string[] = [];
			for (const source of sources) {
				const captured = requirements.find(requirement => requirement.id === source.id);
				// A reasoned owner restatement explicitly replaces an unavailable
				// image; retain the old ask, without reblocking its replacement.
				if (captured?.classification === "merged" && captured.imageState === "needs-user-restatement") continue;
				const before = JSON.stringify(source.images);
				await this.#materializeImages(source.images ?? [], this.#host.sessionManager.getArtifactsDir());
				imagesChanged ||= before !== JSON.stringify(source.images);
				for (const image of source.images ?? []) {
					let available = Boolean(
						image.data &&
						image.sha256 &&
						new Bun.CryptoHasher("sha256").update(Buffer.from(image.data, "base64")).digest("hex") ===
							image.sha256,
					);
					for (const file of [image.artifactPath, image.sourcePath]) {
						if (!file || !image.sha256) continue;
						try {
							if ((await sha256File(file)) === image.sha256) available = true;
						} catch {}
					}
					if (!available) {
						missingImages.add(source.id);
						for (const id of ids)
							if (getRequirementAuditSources(requirements, id).some(candidate => candidate.id === source.id))
								missingImages.add(id);
					}
					const imagePath = image.artifactPath ?? image.sourcePath;
					imageLines.push(
						`${source.id} Image #${image.index}: sha256=${image.sha256 ?? "unavailable"}${imagePath ? `, source=${imagePath}` : ""}${!image.sha256 || !imagePath ? " (source unavailable)" : ""}`,
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
					const declaredArtifact = getAuditItemRowArtifact(
						item,
						row,
						assignedRows,
						new Set(phases.flatMap(phase => phase.tasks.map(task => task.content))),
					);
					if (declaredArtifact && !declaredArtifacts.includes(declaredArtifact))
						declaredArtifacts.push(declaredArtifact);
					const artifact = await bindRequirementRowArtifact(
						{
							cwd: this.#host.cwd(),
							sessionManager: this.#host.sessionManager,
							signal,
							setTodoPhases: this.#host.setTodoPhases,
							...(declaredArtifact ? { receipt: declaredArtifact } : {}),
						},
						row,
						phases,
						this.#appender(),
						checkoutCache,
					);
					// An unresolved owner lookup is not a freshness baseline. The auditor's
					// typed receipt will probe the real target at completion; only a target
					// resolved now can prove that the artifact did not move during the audit.
					if (!artifact.reason && (artifact.head || artifact.sha256 || artifact.identities?.length))
						Object.defineProperty(rowArtifacts, row, {
							value: JSON.stringify(requirementArtifactState(artifact)),
							enumerable: true,
							configurable: true,
						});
					const artifactText = formatRequirementGateArtifact(
						!artifact.head && !artifact.sha256
							? { ...artifact, lastChange: getTodoRowChanges(branch).get(row) }
							: artifact,
						row,
					);
					for (const source of getRequirementAuditSources(requirements, id))
						rowHeads.push(`${source.id} ${artifactText}`);
				}
			}

			const protocol = prompt.render(auditInputTemplate, {
				sources: sources.map(source => `${source.id} (said at ${source.at}): ${source.rawText}`),
				imageLines,
				rowHeads,
				receiptHeader: receiptHeader.trim(),
			});
			revised[index] = {
				...item,
				...(declaredArtifacts.length ? { artifact: declaredArtifacts.join("; ") } : {}),
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
				rowArtifacts,
			});
		}

		if (assignments.length === 0) return undefined;
		if (this.#sessionId() !== sessionId) throw new Error("Audit session changed during preparation");
		if (imagesChanged || missingImages.size) {
			const current = latestRequirementsFromSession(this.#host.sessionManager);
			appendRequirementsSnapshot(
				this.#appender(),
				current.map(requirement => {
					const captured = requirements.find(item => item.id === requirement.id);
					if (
						!captured ||
						captured.at !== requirement.at ||
						captured.rawText !== requirement.rawText ||
						JSON.stringify(captured.images?.map(image => [image.index, image.sha256])) !==
							JSON.stringify(requirement.images?.map(image => [image.index, image.sha256]))
					)
						return requirement;
					return {
						...requirement,
						images: captured.images,
						...(missingImages.has(requirement.id) ? { imageState: "needs-user-restatement" as const } : {}),
					};
				}),
			);
		}
		this.#auditCalls.set(toolCallId, assignments);
		return multiple ? { ...input, tasks: revised } : { ...input, ...(revised[0] as Record<string, unknown>) };
	}

	/** Resolves once every announcement queued by {@link afterToolCall} has been delivered or dropped. */
	async settleBackgroundNotices(): Promise<void> {
		await this.#linkedRowNotices;
	}

	#scheduleLinkedRowNotices(rows: readonly string[]): void {
		if (rows.length === 0) return;
		const sessionId = this.#sessionId();
		this.#linkedRowNotices = this.#linkedRowNotices
			.then(() => this.#announceLinkedRows(sessionId, rows))
			.catch(error => {
				logger.warn("Linked-row requirement notice failed", {
					error: error instanceof Error ? error.message : error,
				});
			});
	}

	async #announceLinkedRows(sessionId: string | null, rows: readonly string[]): Promise<void> {
		if (this.#sessionId() !== sessionId) return;
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "custom" && metadata.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) ||
				isTodoStateEntryMetadata(metadata),
		);
		const requirements = getLatestRequirements(branch).filter(item => item.classification === "linked");
		const phases = getLatestTodoPhasesFromEntries(branch);
		for (const row of new Set(rows)) {
			if (this.#sessionId() !== sessionId) return;
			if (!phases.some(phase => phase.tasks.some(task => task.content === row))) continue;
			const rowRequirements = requirements.filter(item => item.rows.includes(row));
			if (rowRequirements.length === 0) continue;
			const ids = rowRequirements.map(item => item.id);
			const verdicts = rowRequirements.map(item => getRequirementRowVerdict(item, row));
			await this.#announceFlowNotice(
				JSON.stringify(["linked-row", row, ids, requirementRowDeclarationSnapshot(phases, [row]), verdicts]),
				`Audit ${ids.join(", ")} on ${JSON.stringify(row)} before marking it done.`,
				`Closing this linked row requires a qa-auditor pass bound to its current artifact. Call task({agent:"qa-auditor",name:"qa-auditor",requirementIds:${JSON.stringify(ids)},task:${JSON.stringify(`Audit ${ids.join(", ")} for TODO row ${JSON.stringify(row)} at its current artifact; return one receipt row per ID.`)}}).`,
			);
		}
	}

	async afterToolCall(context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
		if (this.#host.agentKind() !== "main") return undefined;
		if (context.toolCall.name === "todo") {
			const details = isRecord(context.result.details) ? context.result.details : undefined;
			if (!context.isError && details && isRecord(context.args)) {
				if (details.op === "classify" && context.args.classification === "linked") {
					const rows = Array.isArray(context.args.rows)
						? context.args.rows.filter((row): row is string => typeof row === "string")
						: [];
					this.#scheduleLinkedRowNotices(rows);
				} else if (details.op === "start") {
					this.#scheduleLinkedRowNotices(
						getTodoActionRows(details.phases as TodoPhase[], context.args as { op: string }),
					);
				}
			}
			if (details?.op === "done" && Array.isArray(details.requirementGateIssues)) {
				// The canonical done gate already checked and invalidated these passes.
				// Reuse that exact evidence rather than resolving the artifacts twice.
				await this.#announceStaleRows(
					this.#staleGateRows(details.requirementGateIssues as RequirementDoneGateIssue[]),
				);
			}
		}
		if (context.toolCall.name === "wait") {
			await this.#consumeWaitSnapshot(context.result);
			return undefined;
		}
		if (context.toolCall.name !== "task") return undefined;

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
			const result = results.find(value => isRecord(value) && value.index === assignment.index);
			if (context.isError && !isRecord(result)) {
				const launched = progress.some(value => isRecord(value) && value.index === assignment.index);
				if (launched) {
					firstRejectedId ??= assignment.ids[0];
					rejected.push(`${assignment.ids.join(", ")}: qa-auditor task failed`);
				}
				continue;
			}
			if (isRecord(result)) {
				const failed = isFailedTaskSingleResult(
					{},
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
					rejected.push(
						`${assignment.ids.join(", ")}: ${failed ? "qa-auditor task failed" : "not a complete qa-auditor result"}`,
					);
					continue;
				}
				const intake = await this.#acceptReceipt(result.id, { ...assignment, workerId: result.id }, result.output);
				if (assignment.sessionId !== this.#sessionId()) continue;
				if (intake.issue) {
					firstRejectedId ??= intake.rejectedIds[0];
					rejected.push(intake.issue);
					this.#persistPendingAuditors(
						{ workerId: result.id, ids: intake.rejectedIds, reason: intake.issue },
						intake.acceptedIds,
					);
				} else {
					this.#persistPendingAuditors(undefined, intake.acceptedIds);
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
			isError: true,
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
			if (assignment.sessionId !== this.#sessionId()) return;
			const rejection =
				outcome.status === "accepted"
					? undefined
					: outcome.status === "rejected"
						? outcome.reason
						: "async result was incomplete, truncated, or not from qa-auditor";
			if (outcome.status !== "absent") acceptedIds.push(...(outcome.acceptedIds ?? []));
			if (rejection)
				this.#persistPendingAuditors({
					workerId: key,
					ids: outcome.status === "rejected" ? (outcome.rejectedIds ?? assignment.ids) : assignment.ids,
					reason: rejection,
				});
			this.#pendingAuditors.delete(key);
			pendingChanged = true;
		}
		if (pendingChanged) this.#persistPendingAuditors(undefined, acceptedIds);
	}

	async #publicationGate(
		message: AssistantMessage,
		signal: AbortSignal,
	): Promise<{ replacementText: string; settled?: true; preserveImages?: true } | void> {
		if (this.#host.agentKind() !== "main") {
			return;
		}
		// Provider failures and aborts retain their actual text and error metadata.
		// Tool turns do not publish a final status and must not scan every checkout.
		if (
			message.stopReason === "error" ||
			message.stopReason === "aborted" ||
			message.content.some(block => block.type === "toolCall")
		)
			return;
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
			const lastReport = matchingRequirementBranchNewestFirst(
				this.#host.sessionManager,
				metadata => metadata.type === "custom" && metadata.customType === "requirements_publication_notice",
			).next().value;
			if (lastReport?.type === "custom" && isRecord(lastReport.data) && lastReport.data.state !== null)
				this.#host.sessionManager.appendCustomEntry("requirements_publication_notice", { state: null });
			return;
		}
		const tools = this.#host.agent.state?.tools;
		const requiredTools = open.some(item => item.requirement.classification === "linked")
			? ["todo", "task"]
			: ["todo"];
		const missingTools = tools ? requiredTools.filter(name => !tools.some(tool => tool.name === name)) : [];
		const noticeState = JSON.stringify([
			this.#sessionId(),
			open.map(item => [item.requirement.id, item.issues]),
			missingTools,
		]);
		if (noticeState !== this.#noticeState) {
			if (freshness.staleRows.length === 0) {
				const notice = formatRequirementGateNotice(
					open.map(item => ({
						...item,
						awaitingUser: item.issues.every(issue => awaitingUserIssues.has(issue)),
					})),
				);
				await this.#host.queueModelNotice?.(
					missingTools.length
						? prompt.render(unavailableToolsTemplate, { notice, missingTools: missingTools.join(", ") })
						: notice,
				);
			}
			this.#noticeState = noticeState;
		}
		const branch = matchingRequirementBranch(
			this.#host.sessionManager,
			metadata =>
				(metadata.type === "message" && metadata.messageRole === "user") ||
				(metadata.type === "custom" &&
					(metadata.customType === "requirements_awaiting_user_notice" ||
						metadata.customType === "requirements_publication_notice")),
		);
		const userMessage = branch.findLast(entry => entry.type === "message" && entry.message.role === "user");
		const userTurn = userMessage?.id ?? null;
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
		const original = message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		// Suppress unchanged notices across audit-source churn, but publish again
		// when the visible issues, full open set, total, or user turn changes.
		const state = new Bun.CryptoHasher("sha256")
			.update(
				JSON.stringify([
					total,
					visible.map(item => [item.requirement.id, item.issues]),
					open.map(item => [item.requirement.id, item.issues]),
				]),
			)
			.digest("hex");
		const previousReport = branch.findLast(
			entry => entry.type === "custom" && entry.customType === "requirements_publication_notice",
		);
		if (
			previousReport?.type === "custom" &&
			isRecord(previousReport.data) &&
			previousReport.data.userTurn === userTurn &&
			previousReport.data.state === state &&
			newKeys.length === 0
		)
			return { replacementText: original, settled: true, preserveImages: true };
		this.#host.sessionManager.appendCustomEntry("requirements_publication_notice", { userTurn, state });
		const notice = formatRequirementPublicationStatus(visible, total);
		return {
			replacementText: original ? `${original}\n\n${notice}` : notice,
			settled: true,
			preserveImages: true,
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
		const sessionId = this.#sessionId();
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
		const staleRows = this.#staleGateRows(open);
		const invalidated = invalidateStaleRequirementVerdicts(requirements, open);
		let currentRequirements = requirements;
		const unchanged = () =>
			this.#sessionId() === sessionId &&
			JSON.stringify(latestRequirementsFromSession(this.#host.sessionManager)) === JSON.stringify(requirements) &&
			JSON.stringify(
				getLatestTodoPhasesFromEntries(
					matchingRequirementBranch(this.#host.sessionManager, isTodoStateEntryMetadata),
				),
			) === JSON.stringify(phases);
		if (invalidated.some((requirement, index) => requirement !== requirements[index]) && unchanged()) {
			// Queue the retry using the original pass before persisting its stale
			// state, so the generation retry cannot lose the exact audit identity.
			await this.#announceStaleRows(staleRows);
			if (unchanged()) {
				appendRequirementsSnapshot(this.#appender(), invalidated);
				currentRequirements = invalidated;
			}
		}
		return {
			requirements: currentRequirements,
			staleById: new Map(open.map(item => [item.requirement.id, item.issues])),
			awaitingUserIssues: new Set(open.flatMap(item => item.awaitingUserIssues)),
			staleRows,
		};
	}

	#staleGateRows(open: readonly RequirementDoneGateIssue[]) {
		return open.flatMap(item => {
			return item.auditRows.flatMap(audit => {
				const verdict = getRequirementRowVerdict(item.requirement, audit.row);
				return verdict?.status === "pass" && item.stalePassRows?.includes(audit.row)
					? [
							{
								requirement: item.requirement,
								row: audit.row,
								artifact: audit.artifact,
								verdict,
								lastChange: audit.artifact.lastChange,
							},
						]
					: [];
			});
		});
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
				`Re-audit ${requirement.id} for ${JSON.stringify(row)} before done or publishing.`,
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

	/** Each target's complete merged-source closure is independent of siblings. */
	async #acceptReceipt(
		workerId: string,
		assignment: RequirementAuditAssignment,
		output: string,
	): Promise<{
		acceptedIds: string[];
		rejectedIds: string[];
		issue: string | null;
	}> {
		const current = latestRequirementsFromSession(this.#host.sessionManager);
		if (requirementAuditSnapshot(current, assignment.ids) !== assignment.snapshot)
			return {
				acceptedIds: [],
				rejectedIds: assignment.ids,
				issue: `${assignment.ids.join(", ")}: requirement raw sources or linked rows changed after audit dispatch`,
			};
		const acceptedIds: string[] = [];
		const rejectedIds: string[] = [];
		const issues: string[] = [];
		for (const id of assignment.ids) {
			const issue = await this.#acceptRequirementReceipts(
				workerId,
				{
					...assignment,
					ids: [id],
					snapshot: requirementAuditSnapshot(current, [id]),
				},
				output,
			);
			if (issue) {
				rejectedIds.push(id);
				issues.push(issue);
			} else acceptedIds.push(id);
		}
		return { acceptedIds, rejectedIds, issue: issues.length ? issues.join("; ") : null };
	}

	async #acceptRequirementReceipts(
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
		const sources = expectedIds.flatMap(id => getRequirementAuditSources(requirements, id));
		const sourceIds = [...new Set(sources.map(source => source.id))];
		let identityFailure: string | undefined;
		let parseFailure: string | undefined;
		const sourceReceipts = parseRequirementReceipt(
			output,
			sourceIds,
			new Map(sources.map(source => [source.id, source.rawText])),
			(receivedId, expectedParentId) => {
				identityFailure ??= `${expectedParentId}: received requirement ID ${receivedId}; restate one row with exact assigned ID ${expectedParentId}, verdict pass|fail|unverifiable, all clause evidence, and one unchanged assigned artifact identity. Do not mix parent and sub-row IDs or discard a failing clause.`;
			},
			reason => {
				parseFailure = reason;
			},
		);
		if (!sourceReceipts) {
			if (identityFailure) return identityFailure;
			return `${expectedIds.join(", ")}: rejected verdict table: ${parseFailure ?? "unparseable"}`;
		}
		for (const source of sources) {
			const receipt = sourceReceipts.find(receipt => receipt.id === source.id)!;
			const issue = getRequirementVerdictSourceIssue(
				{ ...expected[0]!, id: source.id, rawText: source.rawText },
				assignment.rows?.[0] ?? "audit",
				{
					...receipt,
					status: "pass",
					workerId,
					auditor: "qa-auditor",
				},
			);
			if (issue) return `${source.id}: ${issue}`;
		}
		// Each merged ask is an independently authenticated verdict. A target
		// can pass only if every source passes on that same assigned artifact.
		const receipts = expected.map(requirement => {
			const related = getRequirementAuditSources(requirements, requirement!.id).map(source =>
				sourceReceipts.find(receipt => receipt.id === source.id)!,
			);
			const own = related[0]!;
			return {
				...own,
				status: related.some(receipt => receipt.status === "fail")
					? ("fail" as const)
					: related.some(receipt => receipt.status === "unverifiable")
						? ("unverifiable" as const)
						: ("pass" as const),
				evidence:
					related.length === 1
						? own.evidence
						: related.map(receipt => `${receipt.id}: ${receipt.evidence}`).join("; "),
				mergedArtifacts: related.map(receipt => receipt.artifact),
			};
		});
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
				if (
					receipt.mergedArtifacts.some(artifact => {
						const labels = getRequirementReceiptArtifactRowLabels(artifact, knownRows);
						return (
							labels.some(label => requirement.rows.includes(label) && !scopedRows.includes(label)) ||
							getRequirementRowArtifactIdentity(artifact, row, rows, knownRows) !== identity
						);
					})
				)
					return `${receipt.id}: merged source receipts name different or unassigned artifacts`;
				const artifact = await bindRequirementRowArtifact(
					{
						cwd: this.#host.cwd(),
						sessionManager: this.#host.sessionManager,
						receipt: identity,
						setTodoPhases: this.#host.setTodoPhases,
					},
					row,
					phases,
					this.#appender(),
					checkoutCache,
				);
				if (assignment.rowArtifacts?.[row] !== undefined) {
					// `artifact` was resolved through the receipt's typed target above. Compare
					// like-for-like so a transient QA owner cannot replace the audited target.
					const current = artifact;
					if (
						comparableArtifactState(JSON.parse(assignment.rowArtifacts[row]!)) !==
						comparableArtifactState(requirementArtifactState(current))
					)
						return `${receipt.id}: row artifact changed after audit dispatch for ${JSON.stringify(row)}; dispatch: ${assignment.rowArtifacts[row]}; current: ${JSON.stringify(requirementArtifactState(current))}`;
				}
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
					sourceSnapshot: requirementSourceSnapshot(requirements, requirement.id),
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
	): Promise<
		| { status: "accepted"; acceptedIds: string[] }
		| { status: "rejected"; reason: string; acceptedIds?: string[]; rejectedIds?: string[] }
		| { status: "absent" }
	> {
		const key = this.#resolvePendingAuditorKey(workerId);
		const assignment = key ? this.#pendingAuditors.get(key) : undefined;
		if (!key || !assignment) return { status: "absent" };
		// Headers and outer closing tags are framing lines. Receipt cells may
		// contain literal closing-tag text, so never stop at its first occurrence.
		const headers = [
			...content.matchAll(/^<task-result id="([^"\r\n]+)" agent="([^"\r\n]+)" status="([^"\r\n]+)"[^>]*>/gm),
		];
		const exact = headers.find(header => header[1] === workerId);
		const header =
			exact ??
			headers.find(
				candidate => sameWorkerIdentity(workerId, candidate[1]!) && !this.#pendingAuditors.has(candidate[1]!),
			);
		if (!header || header.index === undefined) return { status: "absent" };
		const next = headers.find(candidate => candidate.index! > header.index!);
		const framed = content.slice(header.index, next?.index);
		const close = framed.lastIndexOf("</task-result>");
		if (close < header[0].length) return { status: "absent" };
		const envelope = framed.slice(0, close);
		const sessionId = this.#sessionId();
		if (
			!sessionId ||
			assignment.sessionId !== sessionId ||
			assignment.agent !== "qa-auditor" ||
			(assignment.workerId !== undefined && !sameWorkerIdentity(assignment.workerId, workerId))
		) {
			return { status: "rejected", reason: "session or worker identity did not match" };
		}
		if (header[2] !== "qa-auditor" || header[3] !== "completed") {
			return { status: "rejected", reason: "result was incomplete, truncated, or not from qa-auditor" };
		}
		const body = envelope.slice(header[0].length);
		const preview = /^\s*(?:<meta[^>]*>\s*)?<preview(?:\s[^>]*)?>/.exec(body);
		let receiptOutput: string | undefined;
		if (preview) {
			const directory = this.#host.sessionManager.getArtifactsDir();
			// The assignment is authenticated above. Never search another session's
			// same-named worker output, even if this session's file is missing.
			if (directory && path.basename(header[1]!) === header[1]) {
				try {
					receiptOutput = await Bun.file(path.join(directory, `${header[1]}.md`)).text();
				} catch {}
			}
		} else {
			const start = body.indexOf("<output>");
			const end = body.lastIndexOf("</output>");
			if (start >= 0 && end >= start + "<output>".length)
				receiptOutput = body.slice(start + "<output>".length, end).trim();
		}
		if (receiptOutput === undefined)
			return {
				status: "rejected",
				reason: "result did not contain complete auditor output in its assigned session",
			};
		const intake = await this.#acceptReceipt(header[1]!, assignment, receiptOutput);
		return intake.issue
			? {
					status: "rejected",
					reason: intake.issue,
					acceptedIds: intake.acceptedIds,
					rejectedIds: intake.rejectedIds,
				}
			: { status: "accepted", acceptedIds: intake.acceptedIds };
	}

	/** A `wait` snapshot can recover a result the delivery path never auto-delivered. */
	async #consumeWaitSnapshot(result: unknown): Promise<void> {
		const content = resultText(result);
		if (!content || !content.includes("<task-result ")) return;
		this.#restorePendingAuditors();
		let pendingChanged = false;
		const acceptedIds: string[] = [];
		const deliveredIds = (content.match(/^<task-result id="([^"]+)"/gm) ?? []).map(tag =>
			tag.slice('<task-result id="'.length, -1),
		);
		for (const [key, assignment] of this.#pendingAuditors) {
			if (!deliveredIds.some(id => sameWorkerIdentity(key, id))) continue;
			const outcome = await this.#consumeTaskResultEnvelope(key, content);
			if (assignment.sessionId !== this.#sessionId()) return;
			if (outcome.status === "absent") continue;
			acceptedIds.push(...(outcome.acceptedIds ?? []));
			if (outcome.status === "rejected")
				this.#persistPendingAuditors({
					workerId: key,
					ids: outcome.rejectedIds ?? assignment.ids,
					reason: outcome.reason,
				});
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
		let assignmentEntry: SessionEntry | undefined;
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
					rowArtifacts: assignment.rowArtifacts,
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
		const state = JSON.stringify([
			this.#sessionId(),
			getLatestRequirements(branch),
			getLatestTodoPhasesFromEntries(branch),
		]);
		if (state !== this.#publicationState) {
			this.#publicationState = state;
			this.#publicationGeneration++;
		}
		return this.#publicationGeneration;
	}
	syncPublicationGate(): void {
		// A running AgentLoopConfig retains this wrapper even before a queued
		// user message creates the first requirement.
		const gate = this.#host.agentKind() === "main" ? this.#stablePublicationGate : undefined;
		if (this.#host.setPublicationGate) this.#host.setPublicationGate(gate);
		else setAssistantPublicationGate(this.#host.agent, gate);
	}
}
