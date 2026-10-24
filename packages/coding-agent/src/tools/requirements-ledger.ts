import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

import type { SessionEntry } from "../session/session-entries";
import receiptHeader from "../prompts/session/requirements-ledger-receipt-header.md" with { type: "text" };
import { isAcknowledgementOnlyInput } from "../tiny/text";
import {
	formatRequirementIdentity,
	parseRequirementIdentity,
	splitRequirementIdentitySegments,
	type RequirementIdentity,
} from "../utils/requirement-artifact";
declare module "@oh-my-pi/pi-tui/tools/todo" {
	interface TodoItem {
		/** User-owned check; does not constitute verification or close the row. */
		awaitingUser?: { action: string; ids?: string[] };
	}
}

/** Prepare row-owned pending checks before the normal operation validates and changes status. */
export function prepareAwaitingUserCheck(
	phases: TodoPhase[],
	entry: { op: string; task?: string; phase?: string; reason?: string; awaitingUser?: TodoItem["awaitingUser"] },
	errors: string[],
): boolean {
	if (entry.op !== "block" && entry.op !== "unblock") return true;
	const action = entry.awaitingUser?.action.trim();
	if (entry.op === "block" && entry.awaitingUser && !action) {
		errors.push("awaitingUser requires the exact action the user must take");
		return false;
	}
	if (entry.op === "block" && action && !entry.reason?.replace(/\s+/g, " ").trim()) entry.reason = action;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (entry.task ? task.content !== entry.task : !entry.phase || phase.name !== entry.phase) continue;
			if (entry.op === "unblock") {
				if (task.status === "blocked") delete task.awaitingUser;
			} else if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") {
				task.awaitingUser = action ? { ...entry.awaitingUser!, action } : undefined;
			}
			if (entry.task) return true;
		}
		if (!entry.task && phase.name === entry.phase) return true;
	}
	return true;
}

export const REQUIREMENTS_LEDGER_CUSTOM_TYPE = "requirements_ledger";

export type RequirementClassification = "candidate" | "linked" | "not-a-requirement" | "merged";
export type RequirementVerdictStatus = "pass" | "fail" | "unverifiable";

export interface RequirementVerdict {
	status: RequirementVerdictStatus;
	evidence: string;
	artifact: string;
	workerId: string;
	auditor?: "qa-auditor";
	/** Canonical source bound by the authenticated audit snapshot, not the auditor's prose echo. */
	rawWords?: string;
	/** Row receipt time and the saved todo change it reviewed (ties within one millisecond stay ordered). */
	receivedAt?: string;
	rowChangeId?: string;
}

/** One image referenced by a requirement's `[Image #N]` marker (N is `index`). */
export interface RequirementImage {
	/** One-based positional marker number in `rawText`. */
	index: number;
	sha256?: string;
	mimeType?: string;
	/** Attachment source path when the image is file-backed. */
	sourcePath?: string;
	/** Session artifact holding the bytes when no source file exists. */
	artifactPath?: string;
	/** Inline base64 fallback when neither a source file nor an artifact exists. */
	data?: string;
}

/** `needs-user-restatement` is set once when every backing for an image is gone. */
export type RequirementImageState = "needs-user-restatement";

/** One reasoned row change or owner-backed classification change, oldest first. */
export interface RequirementAmendment {
	at: string;
	oldRows: string[];
	newRows: string[];
	reason: string;
	supersededBy?: string;
	oldClassification?: RequirementClassification;
	newClassification?: RequirementClassification;
}

export interface RequirementLedgerItem {
	id: string;
	at: string;
	rawText: string;
	classification: RequirementClassification;
	rows: string[];
	reason?: string;
	mergeInto?: string;
	verdict?: RequirementVerdict;
	/** Canonical receipts are scoped to a row; `verdict` is only the legacy snapshot input. */
	rowVerdicts?: Record<string, RequirementVerdict>;
	images?: RequirementImage[];
	imageState?: RequirementImageState;
	/** Set once the `needs-user-restatement` question has been surfaced for this user message. */
	imageQuestionAsked?: true;
	/** Append-only changes; original identity and source words remain immutable. */
	amendments?: RequirementAmendment[];
}

export interface RequirementsLedgerData {
	version: 1;
	requirements: RequirementLedgerItem[];
}

export interface RequirementsLedgerAppender {
	appendEntry(customType: string, data?: unknown): unknown;
}

export interface RequirementCounts {
	total: number;
	passed: number;
	open: number;
	failed: number;
}

export type RequirementAuditSource = Pick<RequirementLedgerItem, "id" | "at" | "rawText" | "images">;

const REQUIREMENT_ID = /^R([1-9]\d*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FULL_COMMIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const COMMIT_IDS_IN_ARTIFACT = /(?:^|[^a-f0-9])([a-f0-9]{40}|[a-f0-9]{64})(?=$|[^a-f0-9])/gi;
const CLASSIFICATIONS: Record<RequirementClassification, true> = {
	candidate: true,
	linked: true,
	"not-a-requirement": true,
	merged: true,
};
const VERDICT_STATUSES: Record<RequirementVerdictStatus, true> = { pass: true, fail: true, unverifiable: true };

function parseVerdict(value: unknown): RequirementVerdict | undefined {
	if (
		!isRecord(value) ||
		typeof value.status !== "string" ||
		!Object.hasOwn(VERDICT_STATUSES, value.status) ||
		typeof value.evidence !== "string" ||
		typeof value.artifact !== "string" ||
		typeof value.workerId !== "string" ||
		(value.status === "pass" && (!value.evidence.trim() || !value.artifact.trim() || !value.workerId.trim())) ||
		(value.receivedAt !== undefined &&
			(typeof value.receivedAt !== "string" ||
				!ISO_TIMESTAMP.test(value.receivedAt) ||
				!Number.isFinite(Date.parse(value.receivedAt)))) ||
		(value.rowChangeId !== undefined && typeof value.rowChangeId !== "string")
	)
		return undefined;
	return {
		status: value.status as RequirementVerdictStatus,
		evidence: value.evidence,
		artifact: value.artifact,
		workerId: value.workerId,
		...(value.auditor === "qa-auditor" ? { auditor: "qa-auditor" as const } : {}),
		...(typeof value.rawWords === "string" && value.rawWords.trim() ? { rawWords: value.rawWords } : {}),
		...(typeof value.receivedAt === "string" ? { receivedAt: value.receivedAt } : {}),
		...(typeof value.rowChangeId === "string" ? { rowChangeId: value.rowChangeId } : {}),
	};
}

function parseRequirement(value: unknown): RequirementLedgerItem | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!REQUIREMENT_ID.test(value.id) ||
		typeof value.at !== "string" ||
		!ISO_TIMESTAMP.test(value.at) ||
		!Number.isFinite(Date.parse(value.at)) ||
		typeof value.rawText !== "string" ||
		value.rawText.trim().length === 0 ||
		typeof value.classification !== "string" ||
		!Object.hasOwn(CLASSIFICATIONS, value.classification) ||
		!Array.isArray(value.rows) ||
		!value.rows.every(row => typeof row === "string" && row.trim().length > 0) ||
		(value.classification === "linked" ? value.rows.length === 0 : value.rows.length > 0)
	) {
		return undefined;
	}

	if (value.reason !== undefined && typeof value.reason !== "string") return undefined;
	if (
		value.classification === "not-a-requirement" &&
		(typeof value.reason !== "string" || value.reason.trim().length === 0)
	) {
		return undefined;
	}
	if (
		value.mergeInto !== undefined &&
		(typeof value.mergeInto !== "string" || !REQUIREMENT_ID.test(value.mergeInto))
	) {
		return undefined;
	}
	if ((value.classification === "merged") !== (value.mergeInto !== undefined)) return undefined;

	const verdict = value.verdict === undefined ? undefined : parseVerdict(value.verdict);
	if (value.verdict !== undefined && !verdict) return undefined;
	let rowVerdicts: Record<string, RequirementVerdict> | undefined;
	if (value.rowVerdicts !== undefined) {
		if (!isRecord(value.rowVerdicts)) return undefined;
		rowVerdicts = {};
		for (const [row, receipt] of Object.entries(value.rowVerdicts)) {
			const parsed = parseVerdict(receipt);
			if (!value.rows.includes(row) || !parsed || !parsed.receivedAt) return undefined;
			Object.defineProperty(rowVerdicts, row, {
				value: parsed,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
	}
	const images: RequirementImage[] | undefined =
		value.images === undefined
			? undefined
			: Array.isArray(value.images) &&
				  value.images.every(
						image =>
							isRecord(image) &&
							Number.isInteger(image.index) &&
							Number(image.index) > 0 &&
							(image.sha256 === undefined ||
								(typeof image.sha256 === "string" && /^[a-f0-9]{64}$/.test(image.sha256))) &&
							(image.mimeType === undefined || typeof image.mimeType === "string") &&
							(image.sourcePath === undefined || typeof image.sourcePath === "string") &&
							(image.artifactPath === undefined || typeof image.artifactPath === "string") &&
							(image.data === undefined || typeof image.data === "string"),
				  )
				? (value.images as RequirementImage[])
				: undefined;
	if (value.images !== undefined && images === undefined) return undefined;
	if (value.imageState !== undefined && value.imageState !== "needs-user-restatement") return undefined;
	if (value.imageQuestionAsked !== undefined && value.imageQuestionAsked !== true) return undefined;
	const isRowList = (rows: unknown): rows is string[] =>
		Array.isArray(rows) && rows.every(row => typeof row === "string" && row.trim().length > 0);
	if (
		value.amendments !== undefined &&
		(!Array.isArray(value.amendments) ||
			!value.amendments.every(
				amendment =>
					isRecord(amendment) &&
					typeof amendment.at === "string" &&
					ISO_TIMESTAMP.test(amendment.at) &&
					Number.isFinite(Date.parse(amendment.at)) &&
					isRowList(amendment.oldRows) &&
					isRowList(amendment.newRows) &&
					typeof amendment.reason === "string" &&
					amendment.reason.trim().length > 0 &&
					(amendment.supersededBy === undefined
						? amendment.oldClassification === undefined && amendment.newClassification === undefined
						: typeof amendment.supersededBy === "string" &&
							REQUIREMENT_ID.test(amendment.supersededBy) &&
							typeof amendment.oldClassification === "string" &&
							Object.hasOwn(CLASSIFICATIONS, amendment.oldClassification) &&
							typeof amendment.newClassification === "string" &&
							Object.hasOwn(CLASSIFICATIONS, amendment.newClassification)),
			))
	)
		return undefined;
	const amendments = (value.amendments as RequirementAmendment[] | undefined)?.map(amendment => ({
		at: amendment.at,
		oldRows: [...amendment.oldRows],
		newRows: [...amendment.newRows],
		reason: amendment.reason,
		...(amendment.supersededBy === undefined
			? {}
			: {
					supersededBy: amendment.supersededBy,
					oldClassification: amendment.oldClassification,
					newClassification: amendment.newClassification,
				}),
	}));

	return {
		id: value.id,
		at: value.at,
		rawText: value.rawText,
		classification: value.classification as RequirementClassification,
		rows: [...value.rows] as string[],
		...(value.reason === undefined ? {} : { reason: value.reason }),
		...(value.mergeInto === undefined ? {} : { mergeInto: value.mergeInto }),
		...(verdict === undefined ? {} : { verdict }),
		...(rowVerdicts === undefined ? {} : { rowVerdicts }),
		...(images === undefined ? {} : { images: structuredClone(images) }),
		...(value.imageState === undefined ? {} : { imageState: value.imageState }),
		...(value.imageQuestionAsked === true ? { imageQuestionAsked: true } : {}),
		...(amendments === undefined ? {} : { amendments }),
	};
}

/** Parse and validate the canonical custom-entry payload without rewriting ask text or IDs. */
export function parseRequirementsLedger(value: unknown): RequirementsLedgerData | undefined {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.requirements)) return undefined;
	const requirements: RequirementLedgerItem[] = [];
	const ids = new Set<string>();
	for (const item of value.requirements) {
		const requirement = parseRequirement(item);
		if (!requirement || ids.has(requirement.id)) return undefined;
		ids.add(requirement.id);
		requirements.push(requirement);
	}
	for (const requirement of requirements) {
		let ownerAt = requirement.at;
		for (const amendment of requirement.amendments ?? []) {
			if (!amendment.supersededBy) continue;
			const owner = requirements.find(item => item.id === amendment.supersededBy);
			if (!owner || owner.id === requirement.id || Date.parse(owner.at) <= Date.parse(ownerAt)) return undefined;
			ownerAt = owner.at;
		}
		if (requirement.classification !== "merged") continue;
		const target = requirements.find(candidate => candidate.id === requirement.mergeInto);
		if (
			!target ||
			target.id === requirement.id ||
			target.classification === "merged" ||
			target.classification === "not-a-requirement"
		) {
			return undefined;
		}
	}
	return { version: 1, requirements };
}

/** Read the newest valid `requirements_ledger` custom entry on the supplied branch. */
export function getLatestRequirements(entries: readonly SessionEntry[]): RequirementLedgerItem[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== REQUIREMENTS_LEDGER_CUSTOM_TYPE) continue;
		const ledger = parseRequirementsLedger(entry.data);
		if (ledger) return ledger.requirements;
	}
	return [];
}

/** Append one canonical snapshot entry through the owning session's custom-entry API. */
export function appendRequirementsSnapshot(
	pi: RequirementsLedgerAppender,
	requirements: readonly RequirementLedgerItem[],
): void {
	const ledger = parseRequirementsLedger({ version: 1, requirements });
	if (!ledger) throw new TypeError("Invalid requirements ledger snapshot");
	pi.appendEntry(REQUIREMENTS_LEDGER_CUSTOM_TYPE, ledger);
}

/** Every non-empty line starts with `>`: a quote of earlier text, not a new ask. */
function isQuotedText(rawText: string): boolean {
	const lines = rawText.split(/\r?\n/u).filter(line => line.trim() !== "");
	return lines.length > 0 && lines.every(line => line.trimStart().startsWith(">"));
}

/** Append candidates in ask order, assigning stable Rn IDs while preserving each raw string byte-for-byte. */
export function createRequirementCandidates(
	requirements: readonly RequirementLedgerItem[],
	rawTexts: readonly string[],
	at = new Date().toISOString(),
	imagesByCandidate: readonly (readonly RequirementImage[] | undefined)[] = [],
): RequirementLedgerItem[] {
	if (!ISO_TIMESTAMP.test(at) || !Number.isFinite(Date.parse(at))) {
		throw new TypeError("Requirement timestamp must be an ISO timestamp");
	}
	let highestId = 0;
	for (const requirement of requirements) {
		const match = REQUIREMENT_ID.exec(requirement.id);
		if (match) highestId = Math.max(highestId, Number(match[1]));
	}
	const additions = rawTexts.map((rawText, position) => {
		if (typeof rawText !== "string" || rawText.trim().length === 0) {
			throw new TypeError("Requirement rawText must be a non-empty string");
		}
		const images = imagesByCandidate[position];
		const quoted = !images?.length && isQuotedText(rawText);
		const acknowledgementOnly = !images?.length && (quoted || isAcknowledgementOnlyInput(rawText));
		// An image with no backing bytes and no source path cannot be shown to
		// qa-auditor later; mark it once so the done-gate asks the user instead
		// of demanding an impossible audit every round.
		const unresolvable = images?.some(image => !image.sha256) ?? false;
		return {
			id: `R${++highestId}`,
			at,
			rawText,
			classification: acknowledgementOnly ? ("not-a-requirement" as const) : ("candidate" as const),
			...(acknowledgementOnly
				? {
						reason: quoted
							? "Quoted text, not a new ask"
							: "Acknowledgement, urgency or reaction without a deliverable",
					}
				: {}),
			rows: [],
			...(images?.length ? { images: [...structuredClone(images)] } : {}),
			...(unresolvable ? { imageState: "needs-user-restatement" as const } : {}),
		};
	});
	return [...requirements, ...additions];
}

export type RequirementDecision = "linked" | "not-a-requirement" | "merged";

export interface ClassifyRequirementOptions {
	rows?: readonly string[];
	reason?: string;
	mergeInto?: string;
	/** Reasoned linked -> linked row change; requires `reason` and at least one row. */
	relink?: boolean;
	/** Exact newer canonical owner requirement authorizing a classification change. */
	supersededBy?: string;
}

export type ClassifyRequirementResult = { requirements: RequirementLedgerItem[] } | { error: string };

/** Classify once, or record a reasoned transition authorized by a newer owner statement. */
export function classifyRequirement(
	requirements: readonly RequirementLedgerItem[],
	id: string,
	classification: RequirementDecision,
	options: ClassifyRequirementOptions = {},
): ClassifyRequirementResult {
	const classifyForm = `todo op="classify", id="${id}", classification="linked", rows=["<exact todo row>"] (or classification="not-a-requirement" with reason="...", or classification="merged" with mergeInto="<other Rn>")`;
	const sourceIndex = requirements.findIndex(requirement => requirement.id === id);
	if (sourceIndex < 0)
		return {
			error: `Blocked: requirement ${id} is unknown. No classify call can target it; call todo op="view" to list current requirements and rows, then ${classifyForm}`,
		};
	const source = requirements[sourceIndex]!;
	const superseding =
		options.supersededBy === undefined
			? undefined
			: requirements.find(requirement => requirement.id === options.supersededBy);
	if (options.supersededBy !== undefined) {
		const previousAuthority = source.amendments?.filter(amendment => amendment.supersededBy).at(-1);
		const previousAt = previousAuthority
			? requirements.find(requirement => requirement.id === previousAuthority.supersededBy)?.at
			: source.at;
		if (
			source.classification === "candidate" ||
			!superseding ||
			superseding.id === id ||
			!previousAt ||
			Date.parse(superseding.at) <= Date.parse(previousAt) ||
			!options.reason?.trim()
		) {
			return {
				error: `Blocked: changing ${id} requires supersededBy="<newer owner Rn>" and a nonblank reason; cite an existing owner statement strictly newer than the original requirement and its last superseding statement. Candidate requirements must be classified normally.`,
			};
		}
	}
	if (options.relink && source.classification !== "candidate" && !superseding)
		return relinkRequirement(requirements, sourceIndex, classification, options);
	const restatementTarget = requirements.find(requirement => requirement.id === options.mergeInto);
	const resolvesImage =
		source.imageState === "needs-user-restatement" &&
		classification === "merged" &&
		restatementTarget?.classification === "candidate" &&
		restatementTarget.at > source.at &&
		!restatementTarget.imageState &&
		new RegExp(`\\b${id}\\b`).test(restatementTarget.rawText);
	if (source.classification !== "candidate" && !resolvesImage && !superseding) {
		return {
			error: `Blocked: ${id} has already been classified as ${source.classification}; a classification change requires supersededBy="<newer owner Rn>" and a nonblank reason. Use relink=true with a reason only for linked -> linked row changes`,
		};
	}
	if (classification === "not-a-requirement" && !options.reason?.trim()) {
		return {
			error: `Blocked: classifying ${id} ("${source.rawText}") as not-a-requirement requires a reason. Call todo with op="classify", id="${id}", classification="not-a-requirement", reason="<why this is not a requirement>". Then retry`,
		};
	}

	const next = requirements.map(requirement => ({ ...requirement, rows: [...requirement.rows] }));
	const updatedSource: RequirementLedgerItem = {
		...source,
		classification,
		rows: [],
		verdict: undefined,
		...(options.reason === undefined ? {} : { reason: options.reason }),
	};
	delete updatedSource.mergeInto;
	delete updatedSource.verdict;
	delete updatedSource.rowVerdicts;

	if (classification === "linked") {
		if (
			!options.rows ||
			options.rows.length === 0 ||
			options.rows.some(row => typeof row !== "string" || row.trim() === "")
		) {
			return {
				error: `Blocked: linking ${id} ("${source.rawText}") requires at least one TODO row. Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"]. When no matching row exists yet, first create it with todo op="append", items=["<exact todo row>"] (or op="init"), then retry the classify call`,
			};
		}
		updatedSource.rows = [...new Set(options.rows)];
	}

	if (classification === "merged") {
		const mergeInto = options.mergeInto;
		if (!mergeInto || mergeInto === id) {
			return {
				error: `Blocked: merging ${id} ("${source.rawText}") requires a different existing Rn in mergeInto. ${formatMergeRecovery(source, requirements)}. Then retry`,
			};
		}
		let targetIndex = next.findIndex(requirement => requirement.id === mergeInto);
		if (targetIndex < 0)
			return {
				error: `Blocked: unknown merge target ${mergeInto} for ${id}. ${formatMergeRecovery(source, requirements)}. Then retry`,
			};
		// A target merged earlier in this or a previous call resolves to the active
		// requirement it points at, so batched classify calls are order independent.
		for (const seen = new Set([targetIndex]); next[targetIndex]!.classification === "merged";) {
			const hop = next.findIndex(requirement => requirement.id === next[targetIndex]!.mergeInto);
			if (hop < 0 || seen.has(hop)) break;
			seen.add(hop);
			targetIndex = hop;
		}
		const target = next[targetIndex]!;
		if (target.id === id || target.classification === "merged") {
			return {
				error: `Blocked: merge target ${mergeInto} does not resolve to an active requirement. ${formatMergeRecovery(source, requirements)}. Then retry`,
			};
		}
		if (target.classification === "not-a-requirement") {
			// Merging into a non-requirement says this one is not a requirement either.
			updatedSource.classification = "not-a-requirement";
			updatedSource.reason =
				options.reason?.trim() || `Inherited from ${target.id}: ${target.reason ?? "not a requirement"}`;
			delete updatedSource.mergeInto;
			next[sourceIndex] = updatedSource;
			return { requirements: cascadeIncomingMerges(next, updatedSource) };
		}
		const mergedRows = [...new Set([...target.rows, ...source.rows])];
		next[targetIndex] = {
			...target,
			classification: mergedRows.length > 0 ? "linked" : target.classification,
			rows: mergedRows,
			verdict: undefined,
		};
		delete next[targetIndex]!.verdict;
		delete next[targetIndex]!.rowVerdicts;
		updatedSource.mergeInto = target.id;
	}

	if (superseding) {
		updatedSource.amendments = [
			...(source.amendments ?? []),
			{
				at: new Date().toISOString(),
				oldRows: [...source.rows],
				newRows: [...updatedSource.rows],
				oldClassification: source.classification,
				newClassification: classification,
				supersededBy: superseding.id,
				reason: options.reason!.trim(),
			},
		];
	}
	next[sourceIndex] = updatedSource;
	return { requirements: cascadeIncomingMerges(next, updatedSource) };
}

/**
 * Requirements merged into a row that just became a non-requirement inherit that
 * verdict; ones merged into a row that was itself merged follow it to its target.
 * Either order of a batched classify therefore lands in the same ledger.
 */
function cascadeIncomingMerges(
	requirements: RequirementLedgerItem[],
	changed: RequirementLedgerItem,
): RequirementLedgerItem[] {
	if (changed.classification !== "not-a-requirement" && changed.classification !== "merged") return requirements;
	return requirements.map(requirement => {
		if (requirement.classification !== "merged" || requirement.mergeInto !== changed.id) return requirement;
		if (changed.classification === "merged") return { ...requirement, mergeInto: changed.mergeInto };
		const { mergeInto: _mergeInto, ...rest } = requirement;
		return {
			...rest,
			classification: "not-a-requirement" as const,
			reason: `Inherited from ${changed.id}: ${changed.reason ?? "not a requirement"}`,
		};
	});
}

/**
 * Move a linked requirement to a new row set with a recorded reason. Receipts of
 * rows in the symmetric difference are cleared; retained rows keep theirs.
 */
function relinkRequirement(
	requirements: readonly RequirementLedgerItem[],
	sourceIndex: number,
	classification: RequirementDecision,
	options: ClassifyRequirementOptions,
): ClassifyRequirementResult {
	const source = requirements[sourceIndex]!;
	const id = source.id;
	const relinkForm = `todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"], relink=true, reason="<why the rows change>"`;
	if (classification !== "linked")
		return {
			error: `Blocked: relink=true only relinks linked -> linked for ${id}; classification="${classification}" cannot relink. Call ${relinkForm}`,
		};
	if (source.classification !== "linked")
		return {
			error: `Blocked: relink=true requires ${id} to already be linked; it is ${source.classification}. Classify it normally first, then call ${relinkForm}`,
		};
	const reason = options.reason?.trim();
	if (!reason)
		return {
			error: `Blocked: relinking ${id} ("${source.rawText}") requires a reason. Call ${relinkForm}. Then retry`,
		};
	if (!options.rows?.length || options.rows.some(row => typeof row !== "string" || row.trim() === ""))
		return {
			error: `Blocked: relinking ${id} ("${source.rawText}") requires at least one TODO row; relink cannot unlink to zero rows. Call ${relinkForm}. When no matching row exists yet, first create it with todo op="append", items=["<exact todo row>"] (or op="init"), then retry`,
		};
	const oldRows = [...source.rows];
	const newRows = [...new Set(options.rows)];
	const retained = newRows.filter(row => oldRows.includes(row));
	const rowVerdicts: Record<string, RequirementVerdict> = {};
	for (const row of retained) {
		// Canonical row receipts carry over unchanged. A legacy all-row receipt is first
		// projected onto this row against the OLD row set (ambiguous ones resolve to
		// nothing and are dropped), and only when it can persist as a row receipt.
		const scoped =
			(source.rowVerdicts && Object.hasOwn(source.rowVerdicts, row)) || source.verdict?.receivedAt
				? getRequirementRowVerdict(source, row)
				: undefined;
		if (!scoped) continue;
		Object.defineProperty(rowVerdicts, row, {
			value: scoped,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	const updatedSource: RequirementLedgerItem = {
		...source,
		rows: newRows,
		amendments: [...(source.amendments ?? []), { at: new Date().toISOString(), oldRows, newRows, reason }],
	};
	delete updatedSource.verdict;
	if (Object.keys(rowVerdicts).length > 0) updatedSource.rowVerdicts = rowVerdicts;
	else delete updatedSource.rowVerdicts;
	const next = [...requirements];
	next[sourceIndex] = updatedSource;
	return { requirements: next };
}

/** Counts active requirements; merged and explicitly rejected asks do not block completion. */
export function countRequirements(requirements: readonly RequirementLedgerItem[]): RequirementCounts {
	let total = 0;
	let passed = 0;
	let failed = 0;
	for (const requirement of requirements) {
		if (requirement.classification !== "candidate" && requirement.classification !== "linked") continue;
		total++;
		if (requirement.classification !== "linked") continue;
		const verdicts = requirement.rows.map(row => getRequirementRowVerdict(requirement, row));
		if (verdicts.every(verdict => verdict?.status === "pass" && verdict.auditor === "qa-auditor")) passed++;
		else if (verdicts.some(verdict => verdict?.status === "fail")) failed++;
	}
	return { total, passed, failed, open: total - passed - failed };
}

/** Linked rows remain open until the extension records QA evidence for the current artifact. */
export function isRequirementLinkedToRow(requirements: readonly RequirementLedgerItem[], row: string): boolean {
	return requirements.some(requirement => requirement.classification === "linked" && requirement.rows.includes(row));
}

const REQUIREMENT_QUOTED_ROW_PREFIX = /^\s*(?:(?:TODO|R[1-9]\d*)\s+)?row\s+"((?:[^"\\]|\\.)*)"\s*@/i;

/**
 * Explicit row label of one artifact segment: quoted `row "Row" @ …` (optionally
 * prefixed with `TODO` or an `R<n>` requirement id, e.g. `R6 row "Row" @ …`,
 * with `\"` and `\\` escapes) or bare `Row @ …`.
 * A bare `X @` is a row label only when `X` is a known row; otherwise it is an
 * opaque artifact description and MUST NOT be guessed as a row.
 */
export function getRequirementReceiptArtifactRowLabel(
	segment: string,
	knownRows: ReadonlySet<string>,
): string | undefined {
	const quoted = REQUIREMENT_QUOTED_ROW_PREFIX.exec(segment);
	if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1");
	const at = segment.indexOf(" @ ");
	if (at < 0) return undefined;
	const label = segment.slice(0, at).trim();
	return label && knownRows.has(label) ? label : undefined;
}

/** Every explicit row label in an artifact cell, in order, without duplicates. */
export function getRequirementReceiptArtifactRowLabels(artifact: string, knownRows: ReadonlySet<string>): string[] {
	const labels: string[] = [];
	for (const segment of splitRequirementIdentitySegments(artifact)) {
		const label = getRequirementReceiptArtifactRowLabel(segment, knownRows);
		if (label !== undefined && !labels.includes(label)) labels.push(label);
	}
	return labels;
}

/** Scope explicitly named artifact segments before comparing a row's commit identity. */
export function getRequirementRowArtifactIdentity(
	artifact: string,
	row: string,
	rows: readonly string[],
	knownRows: ReadonlySet<string> = new Set(rows),
): string | undefined {
	const segments = splitRequirementIdentitySegments(artifact).map(segment => segment.trim());
	// A labelled identity list continues until the next explicit row label.
	// Typed continuations and bare legacy commits inherit scope; opaque prose does not.
	const named: string[] = [];
	let label: string | undefined;
	for (const segment of segments) {
		const explicit = getRequirementReceiptArtifactRowLabel(segment, knownRows);
		if (explicit !== undefined) label = explicit;
		const continuation =
			explicit === undefined && label === row ? parseRequirementReceiptIdentities(segment) : undefined;
		if (
			explicit === row ||
			(explicit === undefined && label === row && /^(?:git|file|deploy):/.test(segment)) ||
			(continuation && "legacy" in continuation && continuation.commits.length > 0)
		)
			named.push(segment);
	}
	if (named.length) return named.join("; ");
	// An explicit label naming any row (assigned or foreign) scopes the cell:
	// never silently accept an explicitly labelled cell for an unnamed row,
	// and never project legacy unnamed artifacts onto a labelled row.
	if (segments.some(segment => getRequirementReceiptArtifactRowLabel(segment, knownRows) !== undefined))
		return undefined;
	// Legacy unlabelled cells project only onto a member of the given row set.
	if (!rows.includes(row)) return undefined;
	if (rows.length === 1) return artifact;
	const heads = [...artifact.matchAll(COMMIT_IDS_IN_ARTIFACT)].map(match => match[1]!);
	return heads.length === rows.length ? heads[rows.indexOf(row)] : undefined;
}

/** Read a row receipt, or project an old all-row receipt onto its corresponding artifact. */
export function getRequirementRowVerdict(
	requirement: RequirementLedgerItem,
	row: string,
): RequirementVerdict | undefined {
	if (!requirement.rows.includes(row)) return undefined;
	// A `rowVerdicts` entry is owned by its map key, so its identity is scoped to
	// that one row; only the legacy all-row `verdict` is projected across every row.
	const owned = !!requirement.rowVerdicts && Object.hasOwn(requirement.rowVerdicts, row);
	const verdict = owned ? requirement.rowVerdicts![row] : requirement.verdict;
	if (!verdict) return undefined;
	const knownRows = new Set(requirement.rows);
	const artifact = getRequirementRowArtifactIdentity(
		verdict.artifact,
		row,
		owned ? [row] : requirement.rows,
		knownRows,
	);
	return artifact === undefined ? undefined : { ...verdict, artifact };
}

/** Row scoping and typed parsing share one prefix grammar; malformed typed receipts never become legacy SHAs. */
export function parseRequirementReceiptIdentities(
	artifact: string,
): { identities: RequirementIdentity[] } | { error: string } | { legacy: true; commits: string[] } {
	const segments = splitRequirementIdentitySegments(artifact).map(segment =>
		segment.replace(REQUIREMENT_QUOTED_ROW_PREFIX, "").trim(),
	);
	if (!segments.some(segment => /^(?:git|file|deploy):/i.test(segment))) {
		// A row's explicit `@ <commit>` is its Git identity. Hashes in trailing
		// installed-binary or other evidence are not competing checkout commits.
		let hasRowCommit = false;
		const rowCommits = splitRequirementIdentitySegments(artifact).flatMap(segment => {
			const prefix = REQUIREMENT_QUOTED_ROW_PREFIX.exec(segment);
			const identity = (prefix ? segment.slice(prefix[0].length) : segment).trim();
			// Bare continuation commits retain row scope. Explicitly described
			// installed-binary hashes remain a separate evidence domain.
			const commit = identity.match(
				prefix ? /^([a-f0-9]{40}(?:[a-f0-9]{24})?)(?=$|[^a-f0-9])/i : /^([a-f0-9]{40}(?:[a-f0-9]{24})?)$/i,
			);
			if (prefix && commit) hasRowCommit = true;
			return commit ? [commit[1]!.toLowerCase()] : [];
		});
		return {
			legacy: true,
			commits: hasRowCommit
				? rowCommits
				: [...segments.join("; ").matchAll(COMMIT_IDS_IN_ARTIFACT)].map(match => match[1]!.toLowerCase()),
		};
	}
	const identities: RequirementIdentity[] = [];
	for (const segment of segments) {
		const parsed = parseRequirementIdentity(segment);
		if ("error" in parsed) return { error: parsed.error };
		identities.push(parsed.identity);
	}
	return { identities };
}

/** Meaningful declarations only; notes, status, and owner changes do not alter a typed target. */
export function requirementRowDeclarationSnapshot(phases: readonly TodoPhase[], rows: readonly string[]): string {
	return JSON.stringify(
		rows.map(row => [
			row,
			phases
				.flatMap(phase => phase.tasks)
				.filter(task => task.content === row)
				.map(task => {
					const schedule = "schedule" in task && isRecord(task.schedule) ? task.schedule : undefined;
					return [
						task.deployment ?? null,
						Array.isArray(schedule?.resources) ? [...schedule.resources].sort() : null,
					];
				}),
		]),
	);
}

export interface RequirementGateArtifact {
	head: string | null;
	dirty: boolean;
	sha256?: string;
	dirtyFingerprint?: string;
	lastChange?: { at: string; id: string };
	cwd?: string;
	reason?: string;
	awaitingUser?: { action: string; ids?: string[] };
	/** Canonical identities offered to QA, or checked against this exact receipt. */
	identities?: RequirementIdentity[];
	identityCheck?: { artifact: string; reason?: string };
}

export function formatRequirementGateArtifact(artifact: RequirementGateArtifact, row?: string): string {
	if (artifact.identities?.length) {
		const identity = artifact.identities.map(formatRequirementIdentity).join("; ");
		return `${row === undefined ? "" : `row ${JSON.stringify(row)} @ `}${identity}${artifact.reason ? `, reason=${artifact.reason}` : ""}`;
	}
	const details = `cwd=${artifact.cwd ? shortenPath(artifact.cwd) : "unknown"}, dirty=${artifact.dirty}${artifact.dirtyFingerprint ? `, dirty-fingerprint=${artifact.dirtyFingerprint}` : ""}${artifact.reason ? `, reason=${artifact.reason}` : ""}`;
	if (row !== undefined) {
		const identity = artifact.sha256
			? `sha256=${artifact.sha256}`
			: (artifact.head ??
				(artifact.lastChange && !artifact.reason
					? `observed artifact (saved TODO change ${artifact.lastChange.id})`
					: undefined));
		return identity
			? `row ${JSON.stringify(row)} @ ${identity}, ${details}`
			: `row ${JSON.stringify(row)}: head=unknown, ${details}`;
	}
	return `cwd=${artifact.cwd ? shortenPath(artifact.cwd) : "unknown"}, head=${artifact.head ?? "unknown"}, dirty=${artifact.dirty}${artifact.sha256 ? `, sha256=${artifact.sha256}` : ""}${artifact.dirtyFingerprint ? `, dirty-fingerprint=${artifact.dirtyFingerprint}` : ""}${artifact.reason ? `, reason=${artifact.reason}` : ""}`;
}

/** Authenticate source words before invoking any typed receipt probe. */
export function getRequirementVerdictSourceIssue(
	requirement: RequirementLedgerItem,
	row: string,
	verdict: RequirementVerdict,
): string | null {
	if (verdict.status !== "pass")
		return `requirement ${requirement.id} verdict for row ${JSON.stringify(row)} is ${verdict.status}, not pass`;
	if (verdict.auditor !== "qa-auditor" || !verdict.workerId.trim())
		return `no authenticated qa-auditor identity for row ${JSON.stringify(row)}`;
	if (verdict.rawWords !== undefined) {
		const want = requirement.rawText.replace(/\s+/g, " ").trim();
		const got = verdict.rawWords.replace(/\s+/g, " ").trim();
		if (got !== want) {
			let index = 0;
			while (index < got.length && index < want.length && got[index] === want[index]) index++;
			return `${requirement.id} raw words differ for row ${JSON.stringify(row)} at char ${index} (source ${want.length} chars vs receipt ${got.length} chars)`;
		}
	}
	return null;
}

/** Precise staleness diagnosis for the rows being closed or published. Null means fresh. */
export function getRequirementVerdictStaleness(
	requirement: RequirementLedgerItem,
	artifacts: readonly ({ row: string } & RequirementGateArtifact)[],
): string | null {
	if (requirement.classification !== "linked") return `requirement ${requirement.id} is not linked`;
	if (artifacts.length === 0) return `requirement ${requirement.id} has no row artifacts to check`;
	const seen = new Set<string>();
	for (const current of artifacts) {
		const row = JSON.stringify(current.row);
		if (current.reason && !current.identityCheck) return `row ${row}: unresolved artifact (${current.reason})`;
		if (!requirement.rows.includes(current.row)) return `row ${row} is not linked to requirement ${requirement.id}`;
		if (seen.has(current.row)) return `duplicate artifact for row ${row}`;
		seen.add(current.row);
		const verdict = getRequirementRowVerdict(requirement, current.row);
		if (!verdict) return `requirement ${requirement.id} has no verdict for row ${row}`;
		const sourceIssue = getRequirementVerdictSourceIssue(requirement, current.row, verdict);
		if (sourceIssue) return sourceIssue;
		const typed = parseRequirementReceiptIdentities(verdict.artifact);
		if ("error" in typed) return `row ${row}: invalid typed identity (${typed.error})`;
		if (current.identityCheck?.artifact === verdict.artifact && current.identityCheck.reason)
			return `row ${row}: ${current.identityCheck.reason}`;
		if ("identities" in typed || current.identityCheck?.artifact === verdict.artifact) {
			if (!current.identityCheck || current.identityCheck.artifact !== verdict.artifact)
				return `row ${row}: unverifiable typed identity (receipt was not probed)`;
			continue;
		}
		const hashes = typed.commits;
		if (current.sha256) {
			if (current.dirty) return `dirty file artifact for row ${row}`;
			if (hashes.length !== 1)
				return `ambiguous file SHA in verdict artifact for row ${row}: found ${hashes.length}`;
			if (hashes[0] !== current.sha256.toLowerCase())
				return `sha256 mismatch for row ${row}: receipt ${hashes[0]} vs file ${current.sha256.toLowerCase()}`;
			continue;
		}
		if (!current.head || current.dirty) {
			// Only resolved artifacts may fall back to the baseline saved-row-history rule.
			if (!current.lastChange) return `no saved TODO change for row ${row}`;
			if (!verdict.receivedAt) return `missing receipt timestamp for row ${row}`;
			if (verdict.rowChangeId !== current.lastChange.id)
				return `verdict for row ${row} does not cite the saved TODO change`;
			const receivedAt = Date.parse(verdict.receivedAt);
			const changedAt = Date.parse(current.lastChange.at);
			if (!Number.isFinite(receivedAt)) return `invalid receipt timestamp for row ${row}`;
			if (!Number.isFinite(changedAt)) return `invalid saved TODO change timestamp for row ${row}`;
			if (receivedAt < changedAt) return `verdict for row ${row} predates the saved TODO change`;
			continue;
		}
		if (!FULL_COMMIT_SHA.test(current.head)) return `invalid HEAD ${JSON.stringify(current.head)} for row ${row}`;
		const heads = new Set(hashes);
		if (heads.size !== 1)
			return `ambiguous Git commit in verdict artifact for row ${row}: expected one commit, found ${heads.size}`;
		if (!heads.has(current.head.toLowerCase()))
			return `stale HEAD (git) for row ${row}: expected ${hashes[0]}, observed ${current.head.toLowerCase()}`;
	}
	return null;
}

/** Linked rows intersected with this consumer's Todo rows; pruned siblings retain their ledger history. */
export function getLinkedRequirementRows(requirement: RequirementLedgerItem, rows: readonly string[]): string[] {
	return requirement.classification === "linked" ? requirement.rows.filter(row => rows.includes(row)) : [];
}

export interface RequirementDoneGateIssue {
	requirement: RequirementLedgerItem;
	issues: string[];
	awaitingUserIssues: string[];
	auditRows: Array<{ row: string; ids: string[]; artifact: RequirementGateArtifact }>;
}

/** All completion surfaces use this owner for row selection, freshness, and refusal reasons. */
export async function evaluateRequirementDoneGate(
	requirements: readonly RequirementLedgerItem[],
	rows: readonly string[],
	getArtifact: (row: string, receipt?: string) => Promise<RequirementGateArtifact>,
	rejections: ReadonlyMap<string, string> = new Map(),
): Promise<RequirementDoneGateIssue[]> {
	const targets = new Set(rows);
	const artifacts = new Map<string, Promise<RequirementGateArtifact>>();
	const open: RequirementDoneGateIssue[] = [];
	for (const requirement of requirements) {
		if (requirement.classification === "candidate" && targets.size > 0) {
			open.push({
				requirement,
				issues: [`${requirement.id} awaits todo classify`],
				awaitingUserIssues: [],
				auditRows: [],
			});
			continue;
		}
		if (requirement.classification !== "linked") continue;
		const issues: string[] = [];
		const awaitingUserIssues: string[] = [];
		const auditRows: RequirementDoneGateIssue["auditRows"] = [];
		// An image-only ask whose bytes and source path are both gone cannot be
		// audited at all. Ask the user once and stop demanding qa-auditor passes
		// for it — an unanswerable audit demand is a gate loop.
		if (requirement.imageState === "needs-user-restatement") {
			const issue = `${requirement.id}: the attached image is gone from this session — please restate it in words or re-attach it in a new message naming ${requirement.id}; then associate that new candidate with todo op="classify", id="${requirement.id}", classification="merged", mergeInto="<new Rn>" and request a fresh audit`;
			open.push({ requirement, issues: [issue], awaitingUserIssues: [issue], auditRows });
			continue;
		}
		for (const row of getLinkedRequirementRows(requirement, rows)) {
			const verdict = getRequirementRowVerdict(requirement, row);
			const sourceIssue = verdict ? getRequirementVerdictSourceIssue(requirement, row, verdict) : undefined;
			const receipt = !sourceIssue && verdict?.status === "pass" ? verdict.artifact : undefined;
			const cacheKey = JSON.stringify([row, receipt]);
			let artifact = artifacts.get(cacheKey);
			if (!artifact) {
				artifact = getArtifact(row, receipt);
				artifacts.set(cacheKey, artifact);
			}
			const current = await artifact;
			const pending = current.awaitingUser;
			const auditedAfterCheck =
				verdict?.status === "pass" &&
				!!verdict.receivedAt &&
				!!current.lastChange &&
				Date.parse(verdict.receivedAt) >= Date.parse(current.lastChange.at);
			let reason: string | undefined;
			if (pending && !auditedAfterCheck)
				reason = `awaiting user: ${pending.action}${pending.ids?.length ? ` (ids: ${pending.ids.join(", ")})` : ""}`;
			else {
				// Missing, non-pass, unauthenticated, and stale receipts all come from the
				// canonical producer, so every gate surface reports the same exact cause.
				// The receipt's failure evidence trails the artifact and is never parsed as a cause.
				const staleReason = getRequirementVerdictStaleness(requirement, [{ row, ...current }]);
				if (staleReason !== null) {
					const evidence =
						verdict && verdict.status !== "pass"
							? `; verdict ${verdict.status} evidence: ${verdict.evidence}`
							: "";
					reason = `${requirement.id} freshness check failed: ${staleReason}; resolved checkout: ${formatRequirementGateArtifact(current)}${evidence}`;
				}
			}
			if (reason) {
				const savedRejection = rejections.get(requirement.id);
				const bound = savedRejection && /resolved checkout: cwd=([^,\n]+), head=([^,\n]+)/.exec(savedRejection);
				const rejection =
					bound &&
					(bound[1] !== (current.cwd ? shortenPath(current.cwd) : "unknown") ||
						bound[2] !== (current.head ?? "unknown"))
						? undefined
						: savedRejection;
				const issue = `${requirement.id} (${JSON.stringify(row)}): ${reason}${rejection ? `; rejected receipt: ${rejection}` : ""}`;
				issues.push(issue);
				if (pending && !auditedAfterCheck) awaitingUserIssues.push(issue);
				else {
					auditRows.push({
						row,
						ids: requirements
							.filter(item => getLinkedRequirementRows(item, [row]).length > 0)
							.map(item => item.id),
						artifact: current,
					});
				}
			}
		}
		if (issues.length) open.push({ requirement, issues, awaitingUserIssues, auditRows });
	}
	return open;
}

export function getRequirementAuditSources(
	requirements: readonly RequirementLedgerItem[],
	id: string,
): RequirementAuditSource[] {
	const target = requirements.find(requirement => requirement.id === id && requirement.classification === "linked");
	if (!target) return [];
	const sources: RequirementAuditSource[] = [
		{ id: target.id, at: target.at, rawText: target.rawText, ...(target.images ? { images: target.images } : {}) },
	];
	for (const requirement of requirements) {
		if (requirement.classification === "merged" && requirement.mergeInto === id) {
			sources.push({
				id: requirement.id,
				at: requirement.at,
				rawText: requirement.rawText,
				...(requirement.images ? { images: requirement.images } : {}),
			});
		}
	}
	return sources;
}

export const REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE = "requirements_auditor_assignments";

export interface RequirementAuditAssignment {
	ids: string[];
	snapshot: string;
	sessionId: string;
	agent: "qa-auditor";
	workerId?: string;
	index?: number;
	/** Explicit row scope from the audit task; absent on old all-row assignments. */
	rows?: string[];
	/** Meaningful row declarations reviewed at dispatch; notes, status, and owner edits are excluded. */
	rowDeclarations?: string;
}
/** Unclassified candidates gate mutating tools from the moment their user message is captured, in the same turn. */
export function getUnclassifiedRequirementCandidates(entries: readonly SessionEntry[]): RequirementLedgerItem[] {
	return getLatestRequirements(entries).filter(requirement => requirement.classification === "candidate");
}
function requirementTableCells(line: string): string[] | null {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return null;
	const cells: string[] = [];
	let cell = "";
	let endedOnDelimiter = false;
	for (let index = 0; index < trimmed.length; index++) {
		const char = trimmed[index]!;
		if (char === "\\" && (trimmed[index + 1] === "|" || trimmed[index + 1] === "\\")) {
			cell += trimmed[index + 1]!;
			index++;
			endedOnDelimiter = false;
			continue;
		}
		if (char === "|") {
			cells.push(cell);
			cell = "";
			endedOnDelimiter = true;
			continue;
		}
		cell += char;
		endedOnDelimiter = false;
	}
	if (!endedOnDelimiter) cells.push(cell);
	if (trimmed.startsWith("|")) cells.shift();
	return cells.map(value => {
		const text = value.trim();
		return text.startsWith("`") && text.endsWith("`") ? text.slice(1, -1).trim() : text;
	});
}
/** Digest the exact captured source bytes, including newlines and image tags. */
export function requirementSourceDigest(rawText: string): string {
	return new Bun.CryptoHasher("sha256").update(rawText).digest("hex");
}

const [idHeader, sourceDigestHeader, statusHeader, evidenceHeader, artifactHeader] = receiptHeader
	.trim()
	.split("|")
	.map(cell => cell.toLowerCase().replace(/[^a-z]/g, ""));

/** Parse one complete receipt; supplied source words are authoritative after assignment authentication. */
export function parseRequirementReceipt(
	output: string,
	expectedIds: readonly string[],
	rawWordsById?: ReadonlyMap<string, string>,
	onIdentityError?: (receivedId: string, expectedParentId: string) => void,
): Array<{
	id: string;
	rawWords: string;
	status: RequirementVerdictStatus;
	evidence: string;
	artifact: string;
}> | null {
	const expected = new Set(expectedIds);
	if (expected.size === 0 || expected.size !== expectedIds.length) return null;
	const parentOf = (id: string): string => id.match(/^(R[1-9]\d*)[a-z]+$/)?.[1] ?? id;
	const isUnrelatedId = (id: unknown): boolean =>
		typeof id === "string" && /^R[1-9]\d*[a-z]*$/.test(id.trim()) && !expected.has(parentOf(id.trim()));
	let parsedOutput: unknown;
	try {
		parsedOutput = JSON.parse(output);
	} catch {
		parsedOutput = undefined;
	}
	const strings: string[] = [];
	const collectStrings = (value: unknown): void => {
		if (typeof value === "string") strings.push(value);
		else if (Array.isArray(value)) value.forEach(collectStrings);
		else if (isRecord(value)) Object.values(value).forEach(collectStrings);
	};
	collectStrings(parsedOutput);
	const tableStrings = [...new Set(strings.filter(value => /\|\s*id\s*\|/i.test(value)))];
	const rowCells: string[][] = [];
	if (parsedOutput !== undefined && tableStrings.length === 0) {
		const candidates = Array.isArray(parsedOutput)
			? [parsedOutput]
			: isRecord(parsedOutput)
				? Object.hasOwn(parsedOutput, "id")
					? [[parsedOutput]]
					: Object.values(parsedOutput).filter(
							value => Array.isArray(value) && value.some(row => isRecord(row) && Object.hasOwn(row, "id")),
						)
				: [];
		if (candidates.length !== 1 || !Array.isArray(candidates[0])) return null;
		const fields = [
			["id"],
			["raw_words", "rawWords", "raw_text"],
			["verdict", "status"],
			["evidence"],
			["artifact", "artifact_identity"],
		];
		for (const row of candidates[0]) {
			if (!isRecord(row)) return null;
			if (isUnrelatedId(row.id)) continue;
			const cells: string[] = [];
			for (const aliases of fields) {
				const keys = aliases.filter(key => Object.hasOwn(row, key));
				if (
					keys.length === 0 &&
					aliases[0] === "raw_words" &&
					typeof row.id === "string" &&
					rawWordsById?.has(parentOf(row.id))
				) {
					cells.push(rawWordsById.get(parentOf(row.id))!);
					continue;
				}
				if (keys.length !== 1 || typeof row[keys[0]!] !== "string") return null;
				cells.push((row[keys[0]!] as string).trim());
			}
			for (const key of ["claimed", "measured"] as const) {
				if (!Object.hasOwn(row, key)) {
					cells.push("");
					continue;
				}
				if (typeof row[key] !== "string") return null;
				cells.push((row[key] as string).trim());
			}
			const digestKeys = ["source_sha256", "sourceSha256"].filter(key => Object.hasOwn(row, key));
			if (digestKeys.length > 1) return null;
			const digest = digestKeys.length === 1 ? row[digestKeys[0]!] : "";
			if (typeof digest !== "string" || (digestKeys.length === 1 && !digest)) return null;
			cells.push(digest);
			rowCells.push(cells);
		}
	} else {
		if (parsedOutput !== undefined && tableStrings.length !== 1) return null;
		const lines = (parsedOutput === undefined ? output : tableStrings[0]!).split(/\r?\n/);
		const headers: Array<{
			line: number;
			id: number;
			rawWords: number;
			sourceDigest: number;
			status: number;
			evidence: number;
			artifact: number;
			claimed: number;
			measured: number;
			width: number;
		}> = [];
		for (let line = 0; line < lines.length - 1; line++) {
			const cells = requirementTableCells(lines[line]!);
			const separator = requirementTableCells(lines[line + 1]!);
			if (
				!cells ||
				!separator ||
				separator.length !== cells.length ||
				!separator.every(cell => /^:?-{3,}:?$/.test(cell))
			)
				continue;
			const normalized = cells.map(cell => cell.toLowerCase().replace(/[^a-z]/g, ""));
			const find = (names: string[]) => {
				const matches = normalized.flatMap((name, index) => (names.includes(name) ? [index] : []));
				return matches.length === 1 ? matches[0]! : -1;
			};
			const id = find([idHeader!]);
			const rawWords = find(["rawwords", "rawtext"]);
			const sourceDigest = find([sourceDigestHeader!]);
			if (sourceDigest < 0 && normalized.some(name => name === sourceDigestHeader)) return null;
			if (rawWords < 0 && normalized.some(name => name === "rawwords" || name === "rawtext")) return null;
			const status = find(["status", statusHeader!]);
			const evidence = find([evidenceHeader!]);
			const artifact = find(["artifact", artifactHeader!]);
			const claimed = find(["claimed"]);
			if (claimed < 0 && normalized.some(name => name === "claimed")) return null;
			const measured = find(["measured"]);
			if (measured < 0 && normalized.some(name => name === "measured")) return null;
			if (id >= 0 && status >= 0 && evidence >= 0 && artifact >= 0) {
				headers.push({
					line,
					id,
					rawWords,
					sourceDigest,
					status,
					evidence,
					artifact,
					claimed,
					measured,
					width: cells.length,
				});
			}
		}
		if (headers.length !== 1) return null;
		const header = headers[0]!;
		for (let line = header.line + 2; line < lines.length; line++) {
			if (!lines[line]!.trim()) break;
			const cells = requirementTableCells(lines[line]!);
			if (!cells) break;
			if (isUnrelatedId(cells[header.id])) continue;
			if (cells.length !== header.width) return null;
			if (header.sourceDigest >= 0 && !cells[header.sourceDigest]) return null;
			rowCells.push([
				cells[header.id]!,
				header.rawWords >= 0
					? cells[header.rawWords]!.replace(/<br\s*\/?>/gi, "\n")
					: (rawWordsById?.get(parentOf(cells[header.id]!)) ?? ""),
				cells[header.status]!,
				cells[header.evidence]!,
				cells[header.artifact]!,
				header.claimed >= 0 ? cells[header.claimed]! : "",
				header.measured >= 0 ? cells[header.measured]! : "",
				header.sourceDigest >= 0 ? cells[header.sourceDigest]! : "",
			]);
		}
	}
	const rows: Array<{
		id: string;
		rawWords: string;
		status: RequirementVerdictStatus;
		evidence: string;
		artifact: string;
	}> = [];
	const receivedIds = new Set<string>();
	const parentRows = new Map<string, boolean>();
	for (const cells of rowCells) {
		const [id, rawWords, verdict, evidence, artifact, claimed, measured, sourceDigest] = cells as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const status = verdict.toLowerCase();
		const parentId = parentOf(id);
		if (sourceDigest) {
			const source = rawWordsById?.get(parentId);
			if (source === undefined || sourceDigest !== requirementSourceDigest(source)) return null;
		}
		const split = parentId !== id;
		// Sub-rows are clause evidence, not new requirements. Only the authenticated
		// assignment may bind them to a canonical parent; duplicate/mixed forms fail closed.
		if (split && !rawWordsById?.has(parentId)) {
			onIdentityError?.(id, parentId);
			return null;
		}
		if (receivedIds.has(id) || (parentRows.has(parentId) && (!split || !parentRows.get(parentId)))) {
			onIdentityError?.(id, parentId);
			return null;
		}
		receivedIds.add(id);
		parentRows.set(parentId, split);
		if (
			!/^R[1-9]\d*[a-z]*$/.test(id) ||
			!expected.has(parentId) ||
			(!rawWords && !rawWordsById?.has(parentId)) ||
			!Object.hasOwn(VERDICT_STATUSES, status) ||
			!evidence ||
			!artifact
		) {
			return null;
		}
		// The authenticated auditor owns semantic measurement judgments. Free-text
		// claimed/measured evidence must not become a second, lossy verdict veto.
		const finalStatus = status;
		const finalEvidence = claimed || measured ? `${evidence}\nclaimed: ${claimed}\nmeasured: ${measured}` : evidence;
		const prior = rows.find(row => row.id === parentId);
		const clauseEvidence = split ? `${id}: ${finalEvidence}` : finalEvidence;
		if (prior) {
			// Never let a passing clause erase a fail/unverifiable clause or change
			// its artifact. All clauses must cover the same authenticated row identity.
			if (prior.artifact !== artifact) {
				onIdentityError?.(id, parentId);
				return null;
			}
			if (finalStatus === "fail" || (finalStatus === "unverifiable" && prior.status === "pass"))
				prior.status = finalStatus as RequirementVerdictStatus;
			prior.evidence += `\n${clauseEvidence}`;
		} else {
			rows.push({
				id: parentId,
				rawWords: rawWordsById?.get(parentId) ?? rawWords,
				status: finalStatus as RequirementVerdictStatus,
				evidence: clauseEvidence,
				artifact,
			});
		}
	}
	if (new Set(rows.map(row => row.id)).size !== rows.length) return null;
	return rows.length === expectedIds.length && expectedIds.every(id => rows.some(row => row.id === id)) ? rows : null;
}

/** Restore rejected QA receipt reasons from the newest assignment snapshot. */
export function getPersistedRequirementAuditRejections(
	entries: readonly SessionEntry[],
	sessionId: string | null,
): Map<string, string> {
	const rejected = new Map<string, string>();
	if (!sessionId) return rejected;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE) continue;
		if (!isRecord(entry.data) || entry.data.sessionId !== sessionId || !Array.isArray(entry.data.rejected)) continue;
		for (const value of entry.data.rejected) {
			if (!isRecord(value) || !Array.isArray(value.ids) || typeof value.reason !== "string") continue;
			for (const id of value.ids) {
				if (typeof id === "string" && /^R[1-9]\d*$/.test(id)) rejected.set(id, value.reason);
			}
		}
		return rejected;
	}
	return rejected;
}

/** Fingerprint immutable asks and current links so a worker cannot approve changed requirements. */
export function requirementAuditSnapshot(
	requirements: readonly RequirementLedgerItem[],
	ids: readonly string[],
): string {
	return JSON.stringify(
		ids.map(id => {
			const requirement = requirements.find(entry => entry.id === id);
			return [id, requirement?.classification, requirement?.rows, getRequirementAuditSources(requirements, id)];
		}),
	);
}

/** Restore only exact, current-session auditor assignments from the newest valid snapshot. */
export function getPersistedRequirementAuditorAssignments(
	entries: readonly SessionEntry[],
	sessionId: string | null,
	requirements: readonly RequirementLedgerItem[],
): Map<string, RequirementAuditAssignment> {
	const restored = new Map<string, RequirementAuditAssignment>();
	if (!sessionId) return restored;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE) continue;
		if (!isRecord(entry.data) || entry.data.sessionId !== sessionId) continue;
		if (entry.data.version !== 1 || !Array.isArray(entry.data.jobs)) return restored;
		for (const value of entry.data.jobs) {
			if (!isRecord(value)) continue;
			const { workerId, agent, ids, snapshot } = value;
			if (
				typeof workerId !== "string" ||
				!workerId ||
				agent !== "qa-auditor" ||
				!Array.isArray(ids) ||
				ids.length === 0 ||
				ids.some(id => typeof id !== "string" || !/^R[1-9]\d*$/.test(id)) ||
				new Set(ids).size !== ids.length ||
				typeof snapshot !== "string"
			) {
				continue;
			}
			const requirementIds = ids as string[];
			if (
				requirementIds.some(
					id => requirements.find(requirement => requirement.id === id)?.classification !== "linked",
				) ||
				requirementAuditSnapshot(requirements, requirementIds) !== snapshot
			) {
				continue;
			}
			restored.set(workerId, {
				workerId,
				agent,
				ids: [...requirementIds],
				snapshot,
				sessionId,
				...(typeof value.rowDeclarations === "string" ? { rowDeclarations: value.rowDeclarations } : {}),
				...(Array.isArray(value.rows) &&
				value.rows.every(
					row =>
						typeof row === "string" &&
						requirementIds.some(id =>
							requirements.find(requirement => requirement.id === id)?.rows.includes(row),
						),
				)
					? { rows: value.rows as string[] }
					: {}),
			});
		}
		return restored;
	}
	return restored;
}

/** Merge-target recovery hint: linked-target availability, never a chosen target. */
function formatMergeRecovery(
	source: Pick<RequirementLedgerItem, "id" | "rawText">,
	requirements: readonly RequirementLedgerItem[],
): string {
	const active = requirements
		.filter(requirement => requirement.classification === "linked" && requirement.id !== source.id)
		.map(requirement => requirement.id);
	if (active.length === 0) return `Call ${formatClassifyCall(source, [])}`;
	return `Call todo with op="classify", id="${source.id}", classification="merged", mergeInto="<active Rn>". Available active merge targets: ${JSON.stringify(active)}`;
}

/** Exact `todo classify` call for one unclassified candidate, filled with its real id and words. */
export function formatClassifyCall(
	requirement: Pick<RequirementLedgerItem, "id" | "rawText">,
	rows: readonly string[],
): string {
	// `rows` are available open rows, never a selected link: without a canonical
	// candidate-to-row binding the refusal cannot guess which row fits. The
	// suggested call stays a placeholder until classified with the exact row the
	// requirement's originating ask/tool call proves.
	if (rows.length > 0) {
		return `todo with op="classify", id="${requirement.id}", classification="linked", rows=["<exact todo row>"] (no confident row match: classify with the exact row proven by this requirement's originating ask/tool call; or classification="not-a-requirement" with reason="<why this is not a requirement>")`;
	}
	return `todo with op="classify", id="${requirement.id}", classification="linked", rows=["<exact todo row>"] (no todo row exists yet: first create one with todo op="append", items=["<exact todo row>"] (or op="init"), then retry the classify call; or classification="not-a-requirement" with reason="<why this is not a requirement>")`;
}

/** Non-blocking reminder: pending candidates never delay dispatch, only the completion gate holds them. */
export function formatUnclassifiedCandidateReminder(
	candidates: readonly RequirementLedgerItem[],
	rows: readonly string[],
): string {
	// No canonical candidate-to-row binding exists on the ledger item or the
	// capture path (user raw text only), so available rows are appended once as
	// a separate list and never as a runnable rows selection.
	const parts = candidates.map(
		requirement =>
			`requirement ${requirement.id} (${JSON.stringify(requirement.rawText)}) is an unclassified candidate. Call ${formatClassifyCall(requirement, rows)}`,
	);
	const available = rows.length > 0 ? ` Available todo rows: ${JSON.stringify([...rows])}.` : ``;
	return `Reminder (this call was not blocked): ${parts.join("; ")}.${available} Classify them when convenient; completion stays gated until they are classified.`;
}

/** Compact model-only context: raw asks and worker evidence stay in the ledger. */
export function formatRequirementGateNotice(
	open: readonly { requirement: RequirementLedgerItem; issues: string[]; awaitingUser?: boolean }[],
): string {
	const details = new Map<string, string>();
	const lines: string[] = [];
	const actions = new Set<string>();
	for (const { requirement, issues, awaitingUser } of open) {
		const candidate = requirement.classification === "candidate";
		const status = candidate
			? "needs classification"
			: awaitingUser
				? "awaiting user check"
				: "needs qa-auditor pass at current row head";
		actions.add(
			candidate
				? "classify candidate IDs with todo"
				: awaitingUser
					? "await user checks"
					: "request one qa-auditor pass covering the audit IDs above",
		);
		const refs = new Set<string>();
		for (const issue of issues) {
			const staleReason = issue.split("freshness check failed: ")[1]?.split("; resolved checkout: ")[0];
			if (staleReason) {
				if (!details.has(staleReason)) details.set(staleReason, `D${details.size + 1}`);
				refs.add(details.get(staleReason)!);
			}
			const rejection = issue.split("; rejected receipt: ")[1];
			if (rejection) {
				const reason = rejection.includes("artifact identity")
					? "receipt artifact mismatch"
					: rejection.includes("malformed or partial")
						? "receipt incomplete or malformed"
						: "receipt rejected";
				if (!details.has(reason)) details.set(reason, `D${details.size + 1}`);
				refs.add(details.get(reason)!);
			}
			const checkout = /resolved checkout: cwd=([^,\n]+), head=([a-f0-9]+|unknown), dirty=(true|false)/.exec(issue);
			if (checkout) {
				const detail = `checkout ${checkout[1]} @ ${checkout[2]!.slice(0, 8)}${checkout[3] === "true" ? " (dirty)" : ""}`;
				if (!details.has(detail)) details.set(detail, `D${details.size + 1}`);
				refs.add(details.get(detail)!);
			}
		}
		lines.push(`${requirement.id}: ${status}${refs.size ? ` [${[...refs].join(",")}]` : ""}`);
	}
	const prefix = [
		"Blocked: requested work is not audit-verified.",
		...[...details].map(([detail, id]) => `${id}: ${detail}`),
	];
	const action = `Next: ${[...actions].join("; ")}.`;
	let count = lines.length;
	while (
		count > 0 &&
		Buffer.byteLength(
			[
				...prefix,
				...lines.slice(0, count),
				action,
				...(count < lines.length ? [`+${lines.length - count} more`] : []),
			].join("\n"),
		) > 1500
	)
		count--;
	while (
		prefix.length > 1 &&
		Buffer.byteLength([...prefix, ...lines.slice(0, count), action, `+${lines.length - count} more`].join("\n")) >
			1500
	)
		prefix.pop();
	return [
		...prefix,
		...lines.slice(0, count),
		action,
		...(count < lines.length ? [`+${lines.length - count} more`] : []),
	].join("\n");
}

/** The user sees one bounded status line, never the model gate context. */
export function formatRequirementPublicationStatus(
	open: readonly { requirement: RequirementLedgerItem }[],
	total: number,
): string {
	const ids = open
		.slice(0, 3)
		.map(item => item.requirement.id)
		.join(", ");
	return `Not audit-verified: ${ids}${open.length > 3 ? ", …" : ""} (${open.length} of ${total})`;
}

/** Done-gate refusal with one current-artifact audit retry per blocked TODO row. */
export function formatDoneGateRefusal(open: readonly RequirementDoneGateIssue[]): string {
	const issues = open.flatMap(item => item.issues);
	const byRow = new Map<string, { ids: Set<string>; artifact: RequirementGateArtifact }>();
	for (const item of open) {
		for (const audit of item.auditRows) {
			const retry = byRow.get(audit.row) ?? { ids: new Set<string>(), artifact: audit.artifact };
			for (const id of audit.ids) retry.ids.add(id);
			byRow.set(audit.row, retry);
		}
	}
	const calls = [...byRow].map(([row, retry]) => {
		const ids = [...retry.ids].join(", ");
		const task = `Audit exact requirement IDs ${ids} for TODO row ${JSON.stringify(row)} at its current artifact (${formatRequirementGateArtifact(retry.artifact, row)}). Return one table row per exact ID; do not append letter suffixes.`;
		return `agent="qa-auditor", task=${JSON.stringify(task)}`;
	});
	return `Blocked: todo done is blocked until every linked requirement has a fresh qa-auditor pass for this row artifact: ${issues.join("; ")}.${calls.length ? ` Request one fresh audit per row: ${calls.join("; ")}.` : ""} Then retry todo with op="done", task="<exact row>" (or op="done", items=["<row1>", ...])`;
}
