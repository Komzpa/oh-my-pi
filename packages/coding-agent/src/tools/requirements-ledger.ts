import { isRecord } from "@oh-my-pi/pi-utils";

import type { SessionEntry } from "../session/session-entries";

export const REQUIREMENTS_LEDGER_CUSTOM_TYPE = "requirements_ledger";

export type RequirementClassification = "candidate" | "linked" | "not-a-requirement" | "merged";
export type RequirementVerdictStatus = "pass" | "fail" | "unverifiable";

export interface RequirementVerdict {
	status: RequirementVerdictStatus;
	evidence: string;
	artifact: string;
	workerId: string;
	auditor?: "qa-auditor";
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

export type RequirementAuditSource = Pick<RequirementLedgerItem, "id" | "at" | "rawText">;

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

	let verdict: RequirementVerdict | undefined;
	if (value.verdict !== undefined) {
		if (
			!isRecord(value.verdict) ||
			typeof value.verdict.status !== "string" ||
			!Object.hasOwn(VERDICT_STATUSES, value.verdict.status) ||
			typeof value.verdict.evidence !== "string" ||
			typeof value.verdict.artifact !== "string" ||
			typeof value.verdict.workerId !== "string" ||
			(value.verdict.status === "pass" &&
				(value.verdict.evidence.trim().length === 0 ||
					value.verdict.artifact.trim().length === 0 ||
					value.verdict.workerId.trim().length === 0))
		) {
			return undefined;
		}
		verdict = {
			status: value.verdict.status as RequirementVerdictStatus,
			evidence: value.verdict.evidence,
			artifact: value.verdict.artifact,
			workerId: value.verdict.workerId,
			...(value.verdict.auditor === "qa-auditor" ? { auditor: "qa-auditor" as const } : {}),
		};
	}

	return {
		id: value.id,
		at: value.at,
		rawText: value.rawText,
		classification: value.classification as RequirementClassification,
		rows: [...value.rows] as string[],
		...(value.reason === undefined ? {} : { reason: value.reason }),
		...(value.mergeInto === undefined ? {} : { mergeInto: value.mergeInto }),
		...(verdict === undefined ? {} : { verdict }),
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
): RequirementLedgerItem[] {
	if (!ISO_TIMESTAMP.test(at) || !Number.isFinite(Date.parse(at))) {
		throw new TypeError("Requirement timestamp must be an ISO timestamp");
	}
	let highestId = 0;
	for (const requirement of requirements) {
		const match = REQUIREMENT_ID.exec(requirement.id);
		if (match) highestId = Math.max(highestId, Number(match[1]));
	}
	const additions = rawTexts.map(rawText => {
		if (typeof rawText !== "string" || rawText.trim().length === 0) {
			throw new TypeError("Requirement rawText must be a non-empty string");
		}
		return {
			id: `R${++highestId}`,
			at,
			rawText,
			classification: "candidate" as const,
			rows: [],
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
	if (sourceIndex < 0) return { error: `Blocked: requirement ${id} is unknown. No classify call can target it; call todo op="view" to list current requirements and rows, then ${classifyForm}` };
	const source = requirements[sourceIndex]!;
	if (source.classification !== "candidate") {
		return { error: `Blocked: ${id} has already been classified as ${source.classification}; no further classify call can target it` };
	}
	if (classification === "not-a-requirement" && !options.reason?.trim()) {
		return { error: `Blocked: classifying ${id} ("${source.rawText}") as not-a-requirement requires a reason. Call todo with op="classify", id="${id}", classification="not-a-requirement", reason="<why this is not a requirement>". Then retry` };
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

	if (classification === "linked") {
		if (
			!options.rows ||
			options.rows.length === 0 ||
			options.rows.some(row => typeof row !== "string" || row.trim() === "")
		) {
			return { error: `Blocked: linking ${id} ("${source.rawText}") requires at least one TODO row. Call todo with op="classify", id="${id}", classification="linked", rows=["<exact todo row>"]. When no matching row exists yet, first create it with todo op="append", items=["<exact todo row>"] (or op="init"), then retry the classify call` };
		}
		updatedSource.rows = [...new Set(options.rows)];
	}

	if (classification === "merged") {
		const mergeInto = options.mergeInto;
		if (!mergeInto || mergeInto === id) {
			return { error: `Blocked: merging ${id} ("${source.rawText}") requires a different existing Rn in mergeInto. Call todo with op="classify", id="${id}", classification="merged", mergeInto="<other Rn>". Then retry` };
		}
		const targetIndex = next.findIndex(requirement => requirement.id === mergeInto);
		if (targetIndex < 0) return { error: `Blocked: unknown merge target ${mergeInto} for ${id}. Call todo op="view" to list current requirements, then call todo with op="classify", id="${id}", classification="merged", mergeInto="<existing Rn>". Then retry` };
		const target = next[targetIndex]!;
		if (target.classification === "merged" || target.classification === "not-a-requirement") {
			return { error: `Blocked: merge target ${mergeInto} is not an active requirement. Call todo with op="classify", id="${id}", classification="merged", mergeInto="<active Rn>". Then retry` };
		}
		const mergedRows = [...new Set([...target.rows, ...source.rows])];
		next[targetIndex] = {
			...target,
			classification: mergedRows.length > 0 ? "linked" : target.classification,
			rows: mergedRows,
			verdict: undefined,
		};
		delete next[targetIndex]!.verdict;
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
		if (requirement.verdict?.status === "pass" && requirement.verdict.auditor === "qa-auditor") passed++;
		else if (requirement.verdict?.status === "fail") failed++;
	}
	return { total, passed, failed, open: total - passed - failed };
}

/** Linked rows remain open until the extension records QA evidence for the current artifact. */
export function isRequirementLinkedToRow(requirements: readonly RequirementLedgerItem[], row: string): boolean {
	return requirements.some(requirement => requirement.classification === "linked" && requirement.rows.includes(row));
}

/**
 * A persisted pass is current only when it names every linked row's exact,
 * clean artifact. Auditor-profile authentication happens before the extension
 * persists the pass; this shared check validates its durable row evidence.
 */
export function isFreshRequirementVerdict(
	requirement: RequirementLedgerItem,
	artifacts: readonly { row: string; head: string | null; dirty: boolean }[],
): boolean {
	const verdict = requirement.verdict;
	if (
		requirement.classification !== "linked" ||
		verdict?.status !== "pass" ||
		verdict.auditor !== "qa-auditor" ||
		!verdict.workerId.trim() ||
		requirement.rows.length === 0 ||
		artifacts.length !== requirement.rows.length
	) {
		return false;
	}

	const rowSet = new Set(requirement.rows);
	const artifactRows = new Set<string>();
	const currentHeads = new Set<string>();
	for (const artifact of artifacts) {
		if (
			!rowSet.has(artifact.row) ||
			artifactRows.has(artifact.row) ||
			artifact.dirty !== false ||
			typeof artifact.head !== "string" ||
			!FULL_COMMIT_SHA.test(artifact.head)
		) {
			return false;
		}
		artifactRows.add(artifact.row);
		currentHeads.add(artifact.head.toLowerCase());
	}
	if (artifactRows.size !== rowSet.size) return false;

	const auditedHeads = new Set(
		[...verdict.artifact.matchAll(COMMIT_IDS_IN_ARTIFACT)].map(match => match[1]!.toLowerCase()),
	);
	return (
		auditedHeads.size > 0 &&
		auditedHeads.size === currentHeads.size &&
		[...auditedHeads].every(head => currentHeads.has(head))
	);
}

/** Return the linked ask and every merged raw ask for QA, retaining each source ID. */
export function getRequirementAuditSources(
	requirements: readonly RequirementLedgerItem[],
	id: string,
): RequirementAuditSource[] {
	const target = requirements.find(requirement => requirement.id === id && requirement.classification === "linked");
	if (!target) return [];
	const sources: RequirementAuditSource[] = [{ id: target.id, at: target.at, rawText: target.rawText }];
	for (const requirement of requirements) {
		if (requirement.classification === "merged" && requirement.mergeInto === id) {
			sources.push({ id: requirement.id, at: requirement.at, rawText: requirement.rawText });
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
	return trimmed
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map(cell => {
			const value = cell.trim();
			return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1).trim() : value;
		});
}

/** Accept exactly one complete verdict table for the requirements assigned to this worker. */
export function parseRequirementReceipt(
	output: string,
	expectedIds: readonly string[],
): Array<{ id: string; status: RequirementVerdictStatus; evidence: string; artifact: string }> | null {
	const expected = new Set(expectedIds);
	if (expected.size === 0 || expected.size !== expectedIds.length) return null;
	const lines = output.split(/\r?\n/);
	const headers: Array<{
		line: number;
		id: number;
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
		const status = find(["status", "verdict"]);
		const evidence = find(["evidence"]);
		const artifact = find(["artifact", "artifactidentity"]);
		if (id >= 0 && status >= 0 && evidence >= 0 && artifact >= 0) {
			headers.push({ line, id, status, evidence, artifact, width: cells.length });
		}
	}
	if (headers.length !== 1) return null;
	const header = headers[0]!;
	const rows: Array<{ id: string; status: RequirementVerdictStatus; evidence: string; artifact: string }> = [];
	for (let line = header.line + 2; line < lines.length; line++) {
		if (!lines[line]!.trim()) break;
		const cells = requirementTableCells(lines[line]!);
		if (!cells) break;
		if (cells.length !== header.width) return null;
		const id = cells[header.id]!;
		const status = cells[header.status]!.toLowerCase();
		const evidence = cells[header.evidence]!;
		const artifact = cells[header.artifact]!;
		if (
			!/^R[1-9]\d*$/.test(id) ||
			!expected.has(id) ||
			!Object.hasOwn(VERDICT_STATUSES, status) ||
			!evidence ||
			!artifact
		) {
			return null;
		}
		rows.push({ id, status: status as RequirementVerdictStatus, evidence, artifact });
	}
	if (rows.length !== expected.size || new Set(rows.map(row => row.id)).size !== expected.size) return null;
	return rows;
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
			restored.set(workerId, { workerId, agent, ids: [...requirementIds], snapshot, sessionId });
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
	open: readonly { requirement: RequirementLedgerItem; issues: string[] }[],
	rows: readonly string[],
): string {
	const parts = open.map(({ requirement, issues }) => {
		if (requirement.classification === "candidate") {
			return `${requirement.id} (${JSON.stringify(requirement.rawText)}) is unclassified (${issues.join("; ")}). Call ${formatClassifyCall(requirement, rows)}`;
		}
		return `${requirement.id} (${JSON.stringify(requirement.rawText)}) is linked but not verified complete (${issues.join("; ")}). Request a fresh qa-auditor pass with task agent="qa-auditor", task="Audit ${requirement.id} at the current clean row HEAD", then retry`;
	});
	return `Blocked: requested work is not verified complete. ${parts.join("; ")}. Then retry`;
}

/** Done-gate refusal for linked rows without a fresh qa-auditor pass. */
export function formatDoneGateRefusal(unmet: readonly string[]): string {
	return `Blocked: todo done is blocked until every linked requirement has a fresh qa-auditor pass for the current clean row artifact: ${unmet.join("; ")}. Request a fresh qa-auditor pass with task agent="qa-auditor", task="Audit <Rn> at the current clean row HEAD", then retry todo with op="done", task="<exact row>" (or op="done", items=["<row1>", ...])`;
}
