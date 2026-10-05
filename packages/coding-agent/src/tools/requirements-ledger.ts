import { isRecord } from "@oh-my-pi/pi-utils";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

import type { SessionEntry } from "../session/session-entries";
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
	/** Receipt echo of the immutable ask; a pass is stale when it differs from `rawText`. */
	rawWords?: string;
	/** Clean row HEADs captured when QA was dispatched, keyed by linked row. */
	boundHeads?: Record<string, string>;
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
		...(isRecord(value.boundHeads) &&
		Object.values(value.boundHeads).every(head => typeof head === "string" && FULL_COMMIT_SHA.test(head))
			? { boundHeads: value.boundHeads as Record<string, string> }
			: {}),
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
						(image.sha256 === undefined || (typeof image.sha256 === "string" && /^[a-f0-9]{64}$/.test(image.sha256))) &&
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
		// An image with no backing bytes and no source path cannot be shown to
		// qa-auditor later; mark it once so the done-gate asks the user instead
		// of demanding an impossible audit every round.
		const unresolvable = images?.some(image => !image.sha256) ?? false;
		return {
			id: `R${++highestId}`,
			at,
			rawText,
			classification: "candidate" as const,
			rows: [],
			...(images?.length ? { images: structuredClone(images) } : {}),
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
}

export type ClassifyRequirementResult = { requirements: RequirementLedgerItem[] } | { error: string };

/** Classify one candidate exactly once without renumbering or normalizing its source words. */
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
	if (source.classification !== "candidate") {
		return {
			error: `Blocked: ${id} has already been classified as ${source.classification}; no further classify call can target it`,
		};
	}
	if (classification === "not-a-requirement" && !options.reason?.trim()) {
		return {
			error: `Blocked: classifying ${id} ("${source.rawText}") as not-a-requirement requires a reason. Call todo with op="classify", id="${id}", classification="not-a-requirement", reason="<why this is not a requirement>". Then retry`,
		};
	}

	const incomingMerges = requirements.filter(
		requirement => requirement.classification === "merged" && requirement.mergeInto === id,
	);
	if (classification !== "linked" && incomingMerges.length > 0) {
		return {
			error: `Blocked: cannot classify ${id} ("${source.rawText}") while ${incomingMerges.map(requirement => requirement.id).join(", ")} is merged into it; the ledger would lose its active target. Reclassify the merged requirement(s) first, then call todo with op="classify", id="${id}", classification="<linked|not-a-requirement|merged>", rows=["<exact todo row>"]`,
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
				error: `Blocked: merging ${id} ("${source.rawText}") requires a different existing Rn in mergeInto. Call todo with op="classify", id="${id}", classification="merged", mergeInto="<other Rn>". Then retry`,
			};
		}
		const targetIndex = next.findIndex(requirement => requirement.id === mergeInto);
		if (targetIndex < 0)
			return {
				error: `Blocked: unknown merge target ${mergeInto} for ${id}. Call todo op="view" to list current requirements, then call todo with op="classify", id="${id}", classification="merged", mergeInto="<existing Rn>". Then retry`,
			};
		const target = next[targetIndex]!;
		if (target.classification === "merged" || target.classification === "not-a-requirement") {
			return {
				error: `Blocked: merge target ${mergeInto} is not an active requirement. Call todo with op="classify", id="${id}", classification="merged", mergeInto="<active Rn>". Then retry`,
			};
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
		updatedSource.mergeInto = mergeInto;
	}

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

/** Scope explicitly named artifact segments before comparing a row's commit identity. */
export function getRequirementRowArtifactIdentity(
	artifact: string,
	row: string,
	rows: readonly string[],
): string | undefined {
	const segments = artifact.split(";").map(segment => segment.trim());
	const named = segments.filter(segment => segment.startsWith(`${row} @ `));
	if (named.length) return named.join("; ");
	if (rows.some(candidate => segments.some(segment => segment.startsWith(`${candidate} @ `)))) return undefined;
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
	const verdict =
		requirement.rowVerdicts && Object.hasOwn(requirement.rowVerdicts, row)
			? requirement.rowVerdicts[row]
			: requirement.verdict;
	if (!verdict) return undefined;
	const artifact = getRequirementRowArtifactIdentity(verdict.artifact, row, requirement.rows);
	return artifact === undefined ? undefined : { ...verdict, artifact };
}

export interface RequirementGateArtifact {
	head: string | null;
	dirty: boolean;
	sha256?: string;
	lastChange?: { at: string; id: string };
	cwd?: string;
	reason?: string;
	awaitingUser?: { action: string; ids?: string[] };
}

export function formatRequirementGateArtifact(artifact: RequirementGateArtifact): string {
	return `cwd=${artifact.cwd ?? "unknown"}, head=${artifact.head ?? "unknown"}, dirty=${artifact.dirty}${artifact.sha256 ? `, sha256=${artifact.sha256}` : ""}${artifact.reason ? `, reason=${artifact.reason}` : ""}`;
}

/** The one freshness rule, evaluated only for the rows being closed or published. */
export function isFreshRequirementVerdict(
	requirement: RequirementLedgerItem,
	artifacts: readonly ({ row: string } & RequirementGateArtifact)[],
): boolean {
	if (requirement.classification !== "linked" || artifacts.length === 0) return false;
	const seen = new Set<string>();
	return artifacts.every(current => {
		if (!requirement.rows.includes(current.row) || seen.has(current.row)) return false;
		seen.add(current.row);
		const verdict = getRequirementRowVerdict(requirement, current.row);
		if (verdict?.status !== "pass" || verdict.auditor !== "qa-auditor" || !verdict.workerId.trim()) return false;
		if (
			verdict.rawWords !== undefined &&
			verdict.rawWords.replace(/\s+/g, " ").trim() !== requirement.rawText.replace(/\s+/g, " ").trim()
		)
			return false;
		const hashes = [...verdict.artifact.matchAll(COMMIT_IDS_IN_ARTIFACT)].map(match => match[1]!.toLowerCase());
		if (current.sha256) {
			return !current.dirty && hashes.length === 1 && hashes[0] === current.sha256.toLowerCase();
		}
		if (!current.head || current.dirty) {
			return (
				!!verdict.receivedAt &&
				!!current.lastChange &&
				verdict.rowChangeId === current.lastChange.id &&
				Date.parse(verdict.receivedAt) >= Date.parse(current.lastChange.at)
			);
		}
		if (!FULL_COMMIT_SHA.test(current.head)) return false;
		const heads = new Set(
			[...verdict.artifact.matchAll(COMMIT_IDS_IN_ARTIFACT)].map(match => match[1]!.toLowerCase()),
		);
		return (
			heads.size === 1 &&
			(heads.has(current.head.toLowerCase()) ||
				(!!verdict.boundHeads?.[current.row] && heads.has(verdict.boundHeads[current.row]!.toLowerCase())))
		);
	});
}

/** All completion surfaces use this owner for row selection, freshness, and refusal reasons. */
export async function evaluateRequirementDoneGate(
	requirements: readonly RequirementLedgerItem[],
	rows: readonly string[],
	getArtifact: (row: string) => Promise<RequirementGateArtifact>,
	rejections: ReadonlyMap<string, string> = new Map(),
): Promise<Array<{ requirement: RequirementLedgerItem; issues: string[]; awaitingUserIssues: string[] }>> {
	const targets = new Set(rows);
	const artifacts = new Map<string, Promise<RequirementGateArtifact>>();
	const open: Array<{ requirement: RequirementLedgerItem; issues: string[]; awaitingUserIssues: string[] }> = [];
	for (const requirement of requirements) {
		if (requirement.classification !== "linked") continue;
		const issues: string[] = [];
		const awaitingUserIssues: string[] = [];
		// An image-only ask whose bytes and source path are both gone cannot be
		// audited at all. Ask the user once and stop demanding qa-auditor passes
		// for it — an unanswerable audit demand is a gate loop.
		if (requirement.imageState === "needs-user-restatement") {
			const issue = `${requirement.id}: the attached image is gone from this session — please restate it in words or re-attach it`;
			open.push({ requirement, issues: [issue], awaitingUserIssues: [issue] });
			continue;
		}
		for (const row of requirement.rows) {
			if (!targets.has(row)) continue;
			const verdict = getRequirementRowVerdict(requirement, row);
			let artifact = artifacts.get(row);
			if (!artifact) {
				artifact = getArtifact(row);
				artifacts.set(row, artifact);
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
			else if (!verdict) reason = `${requirement.id} needs a fresh qa-auditor pass`;
			else if (verdict.status !== "pass")
				reason = `${requirement.id} ${verdict.status === "fail" ? "failed" : "unverifiable"}: ${verdict.evidence}`;
			else if (!verdict.workerId.trim() || verdict.auditor !== "qa-auditor")
				reason = `${requirement.id} has no authenticated qa-auditor identity on its receipt`;
			else {
				// A new QA pass can satisfy a user-owned check, but still must match this artifact.
				if (!isFreshRequirementVerdict(requirement, [{ row, ...current }]))
					reason = `${requirement.id} pass is stale: artifact ${verdict.artifact} does not match the current row artifact or saved todo change; resolved checkout: ${formatRequirementGateArtifact(current)}`;
			}
			if (reason) {
				const rejection = rejections.get(requirement.id);
				const issue = `${requirement.id} (${JSON.stringify(row)}): ${reason}${rejection ? `; rejected receipt: ${rejection}` : ""}`;
				issues.push(issue);
				if (pending && !auditedAfterCheck) awaitingUserIssues.push(issue);
			}
		}
		if (issues.length) open.push({ requirement, issues, awaitingUserIssues });
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
	boundHeads?: Record<string, string>;
	/** Explicit row scope from the audit task; absent on old all-row assignments. */
	rows?: string[];
}
/** Candidates become overdue after an assistant turn ends later in the same branch. */
export function getOverdueRequirementCandidates(entries: readonly SessionEntry[]): RequirementLedgerItem[] {
	const capturedAt = new Map<string, number>();
	let latestAssistantStop = -1;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.type === "custom" && entry.customType === REQUIREMENTS_LEDGER_CUSTOM_TYPE) {
			for (const requirement of getLatestRequirements([entry])) {
				if (!capturedAt.has(requirement.id)) capturedAt.set(requirement.id, index);
			}
		}
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop") {
			latestAssistantStop = index;
		}
	}
	return getLatestRequirements(entries).filter(
		requirement =>
			requirement.classification === "candidate" &&
			(capturedAt.get(requirement.id) ?? Infinity) < latestAssistantStop,
	);
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

/** Accept exactly one complete verdict table for the requirements assigned to this worker. */
export function parseRequirementReceipt(
	output: string,
	expectedIds: readonly string[],
): Array<{
	id: string;
	rawWords: string;
	status: RequirementVerdictStatus;
	evidence: string;
	artifact: string;
	subIds?: string[];
}> | null {
	const expected = new Set(expectedIds);
	if (expected.size === 0 || expected.size !== expectedIds.length) return null;
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
	if (parsedOutput !== undefined && tableStrings.length !== 1) return null;
	const lines = (parsedOutput === undefined ? output : tableStrings[0]!).split(/\r?\n/);
	const headers: Array<{
		line: number;
		id: number;
		rawWords: number;
		status: number;
		evidence: number;
		artifact: number;
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
		const id = find(["id"]);
		const rawWords = find(["rawwords", "rawtext"]);
		const status = find(["status", "verdict"]);
		const evidence = find(["evidence"]);
		const artifact = find(["artifact", "artifactidentity"]);
		if (id >= 0 && rawWords >= 0 && status >= 0 && evidence >= 0 && artifact >= 0) {
			headers.push({ line, id, rawWords, status, evidence, artifact, width: cells.length });
		}
	}
	if (headers.length !== 1) return null;
	const header = headers[0]!;
	const rows: Array<{
		id: string;
		rawWords: string;
		status: RequirementVerdictStatus;
		evidence: string;
		artifact: string;
	}> = [];
	for (let line = header.line + 2; line < lines.length; line++) {
		if (!lines[line]!.trim()) break;
		const cells = requirementTableCells(lines[line]!);
		if (!cells) break;
		if (cells.length !== header.width) return null;
		const id = cells[header.id]!;
		const rawWords = cells[header.rawWords]!.replace(/<br\s*\/?>/gi, "\n");
		const status = cells[header.status]!.toLowerCase();
		const evidence = cells[header.evidence]!;
		const artifact = cells[header.artifact]!;
		if (
			!/^R[1-9]\d*[a-z]?$/.test(id) ||
			!expected.has(id.replace(/[a-z]$/, "")) ||
			!rawWords ||
			!Object.hasOwn(VERDICT_STATUSES, status) ||
			!evidence ||
			!artifact
		) {
			return null;
		}
		rows.push({ id, rawWords, status: status as RequirementVerdictStatus, evidence, artifact });
	}
	if (new Set(rows.map(row => row.id)).size !== rows.length) return null;
	const grouped = expectedIds.map(id => {
		const parts = rows.filter(row => row.id.replace(/[a-z]$/, "") === id);
		if (!parts.length || (parts.length > 1 && parts.some(row => row.id === id))) return null;
		if (parts.length === 1 && parts[0]!.id === id) return parts[0]!;
		const status = parts.some(row => row.status === "fail")
			? "fail"
			: parts.some(row => row.status === "unverifiable")
				? "unverifiable"
				: "pass";
		return {
			id,
			rawWords: parts.map(row => row.rawWords).join("; "),
			status: status as RequirementVerdictStatus,
			evidence: parts.map(row => `${row.id}: ${row.evidence}`).join("; "),
			artifact: parts.map(row => row.artifact).join("; "),
			subIds: parts.map(row => row.id),
		};
	});
	return grouped.some(row => row === null) ? null : grouped.filter(row => row !== null);
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
				typeof snapshot !== "string" ||
				(value.boundHeads !== undefined &&
					(!isRecord(value.boundHeads) ||
						!Object.values(value.boundHeads).every(
							head => typeof head === "string" && FULL_COMMIT_SHA.test(head),
						)))
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
				...(isRecord(value.boundHeads) ? { boundHeads: value.boundHeads as Record<string, string> } : {}),
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

/** Exact `todo classify` call for one unclassified candidate, filled with its real id and words. */
export function formatClassifyCall(
	requirement: Pick<RequirementLedgerItem, "id" | "rawText">,
	rows: readonly string[],
): string {
	if (rows.length > 0) {
		return `todo with op="classify", id="${requirement.id}", classification="linked", rows=${JSON.stringify(rows)} (or classification="not-a-requirement" with reason="<why this is not a requirement>")`;
	}
	return `todo with op="classify", id="${requirement.id}", classification="linked", rows=["<exact todo row>"] (no todo row exists yet: first create one with todo op="append", items=["<exact todo row>"] (or op="init"), then retry the classify call; or classification="not-a-requirement" with reason="<why this is not a requirement>")`;
}

/** Gate refusal naming the blocked tool, the reason, and the exact call that unblocks it. */
export function formatOverdueClassifyRefusal(
	toolName: string,
	overdue: readonly RequirementLedgerItem[],
	rows: readonly string[],
): string {
	const parts = overdue.map(
		requirement =>
			`requirement ${requirement.id} (${JSON.stringify(requirement.rawText)}) is an unclassified candidate. Call ${formatClassifyCall(requirement, rows)}`,
	);
	return `Blocked: ${toolName} is blocked because ${parts.join("; ")}. Then retry ${toolName}`;
}

/** Publication-gate replacement text: what is blocked, why, and the exact call per open requirement. */
export function formatPublicationReplacement(
	open: readonly { requirement: RequirementLedgerItem; issues: string[]; awaitingUser?: boolean }[],
	rows: readonly string[],
): string {
	const parts = open.map(({ requirement, issues, awaitingUser }) => {
		if (requirement.classification === "candidate") {
			return `${requirement.id} (${JSON.stringify(requirement.rawText)}) is unclassified (${issues.join("; ")}). Call ${formatClassifyCall(requirement, rows)}`;
		}
		if (awaitingUser) {
			return `${requirement.id} (${JSON.stringify(requirement.rawText)}) is not verified complete (${issues.join("; ")}). Await the user's confirmation or a fresh qa-auditor pass; do not mark the row done`;
		}
		return `${requirement.id} (${JSON.stringify(requirement.rawText)}) is linked but not verified complete (${issues.join("; ")}). Request a fresh qa-auditor pass with task agent="qa-auditor", task="Audit ${requirement.id} at the current clean row HEAD", then retry`;
	});
	return `Blocked: requested work is not verified complete. ${parts.join("; ")}. Then retry`;
}

/** Done-gate refusal for linked rows without a fresh qa-auditor pass. */
export function formatDoneGateRefusal(unmet: readonly string[]): string {
	return `Blocked: todo done is blocked until every linked requirement has a fresh qa-auditor pass for this row artifact: ${unmet.join("; ")}. Request a fresh qa-auditor pass with task agent="qa-auditor", task="Audit <Rn> for <exact row> at its current artifact", then retry todo with op="done", task="<exact row>" (or op="done", items=["<row1>", ...])`;
}
