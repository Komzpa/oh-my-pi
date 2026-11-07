import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveCatalogAxes } from "@oh-my-pi/pi-catalog/compat/resolve";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { bareModelId } from "@oh-my-pi/pi-catalog/identity";
import { splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { lookup as lookupSetting } from "../config/registry";
import {
	resolveModelRoleValue,
	resolveConfiguredModelPatterns,
	formatModelStringWithRouting,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE } from "../tools/requirements-ledger";
import {
	currentRequirementTodoEntries,
	getLatestTodoPhasesFromEntries,
	observeLatestTodoPhases,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../tools/todo";
import {
	latestRequirementsFromSession,
	matchingRequirementBranchNewestFirst,
	type RequirementEntryMetadata,
} from "../session/requirements-branch-selection";
import { visitEntriesFromFileStream } from "../session/session-loader";
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { StructuredSubagentRequest, EffectiveSubagentPolicy } from "./structured-subagent";

export interface AuditModelFacts {
	model: string;
	vendor?: string;
	tier?: number;
}
export type AuditSelectionRule = "cross_vendor" | "higher_class" | "different_model" | "fallback";
export interface AuditModelCandidate {
	model: Model;
	selector: string;
	weight: number;
}

export function auditModelFacts(model: {
	id: string;
	provider?: string;
	identity?: Model["identity"];
	api?: Model["api"];
	reasoning?: boolean;
}): AuditModelFacts {
	const id = bareModelId(splitThinkingSuffix(model.id, 0).base).toLowerCase();
	const identity = model.identity ?? classifyModel(model.provider ?? "", id);
	const policy = resolveCatalogAxes({
		id,
		provider: model.provider ?? "",
		api: model.api ?? "openai-completions",
		reasoning: model.reasoning ?? false,
	});
	const vendor =
		typeof policy.auditVendor === "string"
			? policy.auditVendor
			: identity.class === "unknown"
				? undefined
				: identity.class;
	return {
		model: id,
		vendor,
		tier: typeof policy.auditStrength === "number" ? policy.auditStrength : undefined,
	};
}

export function auditSelectionRule(
	candidate: AuditModelFacts,
	implementers: readonly AuditModelFacts[],
): AuditSelectionRule {
	if (!implementers.length || implementers.some(worker => !worker.vendor) || !candidate.vendor) return "fallback";
	if (implementers.some(worker => worker.model === candidate.model)) return "fallback";
	const knownStrength = candidate.tier !== undefined && implementers.every(worker => worker.tier !== undefined);
	const vendors = new Set(implementers.map(worker => worker.vendor));
	if (!vendors.has(candidate.vendor) && knownStrength && implementers.every(worker => candidate.tier! >= worker.tier!))
		return "cross_vendor";
	if (vendors.has(candidate.vendor) && knownStrength && implementers.every(worker => candidate.tier! > worker.tier!))
		return "higher_class";
	return vendors.has(candidate.vendor) && knownStrength && implementers.every(worker => candidate.tier === worker.tier)
		? "different_model"
		: "fallback";
}

export function chooseAuditModel(
	pool: AuditModelCandidate[],
	escalation: AuditModelCandidate[],
	implementers: AuditModelFacts[],
	explicit = false,
): { candidate: AuditModelCandidate; rule: AuditSelectionRule; explicit: boolean } | undefined {
	if (!pool.length && (explicit || !escalation.length)) return undefined;
	if (!pool.length) pool = escalation;
	const draw = (candidates: AuditModelCandidate[]) => {
		let remaining = Math.random() * candidates.reduce((total, candidate) => total + candidate.weight, 0);
		return candidates.find(candidate => (remaining -= candidate.weight) < 0) ?? candidates[candidates.length - 1]!;
	};
	if (explicit)
		return { candidate: pool[0]!, rule: auditSelectionRule(auditModelFacts(pool[0]!.model), implementers), explicit };
	const differentModels = (candidates: AuditModelCandidate[]) =>
		candidates.filter(
			candidate => !implementers.some(worker => worker.model === auditModelFacts(candidate.model).model),
		);
	if (!implementers.length || implementers.some(worker => !worker.vendor)) {
		const distinct = differentModels(pool);
		return { candidate: draw(distinct.length ? distinct : pool), rule: "fallback", explicit };
	}
	// Stay within the auditor pool whenever any preference qualifies. Broaden
	// only to explicitly configured stronger groups after exhausting that pool.
	for (const candidates of [pool, escalation]) {
		for (const rule of ["cross_vendor", "higher_class", "different_model"] as const) {
			const matching = candidates.filter(
				candidate => auditSelectionRule(auditModelFacts(candidate.model), implementers) === rule,
			);
			if (matching.length) return { candidate: draw(matching), rule, explicit };
		}
	}
	// Unknown vendors cannot prove independence, but an unknown distinct model still avoids self-audit.
	const distinct = differentModels([...pool, ...escalation]);
	return { candidate: draw(distinct.length ? distinct : pool), rule: "fallback", explicit };
}

const todoMetadata = (entry: RequirementEntryMetadata): boolean =>
	(entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) ||
	(entry.type === "message" && entry.messageRole === "toolResult" && entry.toolName === "todo");

type AuditSessionManager = Pick<SessionManager, "getBranch"> & { readonly bodyRevision?: number };
type RowOwners = Map<string, Set<string>>;
const historicalOwners = new WeakMap<
	object,
	{ latest: string; revision: number | undefined; owners: Promise<RowOwners> }
>();

/** Incremental structured projection; branch changes discard owners outside the active ancestry. */
async function historicalRowOwners(manager: AuditSessionManager): Promise<RowOwners> {
	const iterator = matchingRequirementBranchNewestFirst(manager, todoMetadata)[Symbol.iterator]();
	const first = iterator.next();
	if (first.done) return new Map();
	const latest = first.value.id;
	const revision = manager.bodyRevision;
	const cached = historicalOwners.get(manager);
	if (revision !== undefined && cached?.latest === latest && cached.revision === revision) return cached.owners;
	const owners = (async () => {
		const result: RowOwners = new Map();
		let entry: SessionEntry | undefined = first.value;
		let count = 0;
		while (entry) {
			if (revision !== undefined && cached?.revision === revision && entry.id === cached.latest) {
				for (const [row, previous] of await cached.owners)
					result.set(row, new Set([...previous, ...(result.get(row) ?? [])]));
				break;
			}
			observeLatestTodoPhases([entry], phases => {
				for (const phase of phases)
					for (const row of phase.tasks) {
						const schedule = "schedule" in row && isRecord(row.schedule) ? row.schedule : undefined;
						const owner = typeof schedule?.owner === "string" ? schedule.owner : "main";
						result.set(row.content, new Set([owner, ...(result.get(row.content) ?? [])]));
					}
			});
			if (++count % 16 === 0) await Bun.sleep(0);
			const next = iterator.next();
			entry = next.done ? undefined : next.value;
		}
		return result;
	})();
	const snapshot = { latest, revision, owners };
	historicalOwners.set(manager, snapshot);
	try {
		return await owners;
	} catch (error) {
		if (historicalOwners.get(manager) === snapshot) historicalOwners.delete(manager);
		throw error;
	}
}

const assistantMetadata = (entry: RequirementEntryMetadata): boolean =>
	entry.type === "message" && entry.messageRole === "assistant";

function collectModel(
	entry: unknown,
	models: Map<string, AuditModelFacts>,
	known: Map<string, AuditModelFacts>,
	newestFirst = false,
): void {
	if (
		!isRecord(entry) ||
		!isRecord(entry.message) ||
		entry.message.role !== "assistant" ||
		typeof entry.message.model !== "string"
	)
		return;
	const provider = typeof entry.message.provider === "string" ? entry.message.provider : undefined;
	const key = `${provider ?? ""}\0${entry.message.model}`;
	let facts = known.get(key);
	if (!facts) {
		facts = auditModelFacts({ id: entry.message.model, provider });
		known.set(key, facts);
	}
	if (!newestFirst || !models.has(facts.model)) models.set(facts.model, facts);
}

const parentModels = new WeakMap<
	object,
	{ latest: string; revision: number | undefined; models: Promise<AuditModelFacts[]> }
>();
async function parentModelFacts(manager: AuditSessionManager): Promise<AuditModelFacts[]> {
	const iterator = matchingRequirementBranchNewestFirst(manager, assistantMetadata)[Symbol.iterator]();
	const first = iterator.next();
	if (first.done) return [];
	const latest = first.value.id;
	const revision = manager.bodyRevision;
	const cached = parentModels.get(manager);
	if (revision !== undefined && cached?.latest === latest && cached.revision === revision) return cached.models;
	const models = (async () => {
		const result = new Map<string, AuditModelFacts>();
		const known = new Map<string, AuditModelFacts>();
		let entry: SessionEntry | undefined = first.value;
		let count = 0;
		while (entry) {
			if (revision !== undefined && cached?.revision === revision && entry.id === cached.latest) {
				for (const facts of await cached.models) if (!result.has(facts.model)) result.set(facts.model, facts);
				break;
			}
			collectModel(entry, result, known, true);
			if (++count % 16 === 0) await Bun.sleep(0);
			const next = iterator.next();
			entry = next.done ? undefined : next.value;
		}
		return [...result.values()];
	})();
	const snapshot = { latest, revision, models };
	parentModels.set(manager, snapshot);
	try {
		return await models;
	} catch (error) {
		if (parentModels.get(manager) === snapshot) parentModels.delete(manager);
		throw error;
	}
}

interface WorkerModelsSnapshot {
	identity: string;
	models: Promise<AuditModelFacts[]>;
}
// Retain small model projections only, never journal entries or message bodies.
const workerModels = new Map<string, WorkerModelsSnapshot>();
function fileIdentity(stat: Stats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
async function workerModelFacts(file: string): Promise<AuditModelFacts[]> {
	const before = await fs.stat(file);
	const identity = fileIdentity(before);
	const cached = workerModels.get(file);
	if (cached?.identity === identity) return cached.models;
	const models = (async () => {
		const result = new Map<string, AuditModelFacts>();
		const known = new Map<string, AuditModelFacts>();
		await visitEntriesFromFileStream(file, entry => collectModel(entry, result, known), {
			throwIfMissing: true,
			maxBytes: before.size,
			onMalformedRecord: () => {
				throw new Error("Malformed worker journal");
			},
		});
		return [...result.values()];
	})();
	const snapshot = { identity, models };
	workerModels.set(file, snapshot);
	if (workerModels.size > 128) workerModels.delete(workerModels.keys().next().value!);
	try {
		const result = await models;
		if (fileIdentity(await fs.stat(file)) !== identity && workerModels.get(file) === snapshot)
			workerModels.delete(file);
		return result;
	} catch (error) {
		if (workerModels.get(file) === snapshot) workerModels.delete(file);
		throw error;
	}
}

/** No commit attribution is stored: include every historical structured owner of each scoped row.
 * Read every assistant model in those workers' session files, including fallback models. Never parse prose.
 */
export async function rowImplementerModels(
	entries: SessionEntry[],
	rows: string[],
	artifacts: string | null | undefined,
	mainHistory: () => Iterable<SessionEntry> = () => entries.toReversed(),
	rowOwners?: ReadonlyMap<string, ReadonlySet<string>>,
	manager?: AuditSessionManager,
): Promise<AuditModelFacts[]> {
	const owners = new Set(rows.flatMap(row => [...(rowOwners?.get(row) ?? [])]));
	for (let index = 0; !rowOwners && index < entries.length; index++) {
		const entry = entries[index]!;
		if (
			!(entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) &&
			!(entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo")
		)
			continue;
		for (const phase of getLatestTodoPhasesFromEntries([entry]))
			for (const row of phase.tasks) {
				if (!rows.includes(row.content)) continue;
				const schedule = "schedule" in row && isRecord(row.schedule) ? row.schedule : undefined;
				owners.add(typeof schedule?.owner === "string" ? schedule.owner : "main");
			}
	}
	const models = new Map<string, AuditModelFacts>();
	for (const owner of owners) {
		if (owner !== "main" && owner !== "Main") {
			if (!artifacts || path.basename(owner) !== owner) {
				models.set(owner, { model: "unknown" });
				continue;
			}
			try {
				const facts = await workerModelFacts(path.join(artifacts, `${owner}.jsonl`));
				for (const fact of facts) models.set(fact.model, fact);
				if (!facts.length) models.set(owner, { model: "unknown" });
			} catch {
				models.set(owner, { model: "unknown" });
			}
			continue;
		}
		if (manager) {
			const facts = await parentModelFacts(manager);
			for (const fact of facts) models.set(fact.model, fact);
			if (!facts.length) models.set(owner, { model: "unknown" });
			continue;
		}
		const ownModels = new Map<string, AuditModelFacts>();
		const known = new Map<string, AuditModelFacts>();
		let visited = 0;
		for (const entry of mainHistory()) {
			collectModel(entry, ownModels, known, true);
			if (++visited % 64 === 0) await Bun.sleep(0);
		}
		for (const fact of ownModels.values()) models.set(fact.model, fact);
		if (!ownModels.size) models.set(owner, { model: "unknown" });
	}
	return [...models.values()];
}

/** Runs after extension routing, before artifact allocation: this is the last model policy boundary. */
export async function selectRowAuditModel(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<EffectiveSubagentPolicy> {
	return logger.time("task.preRun.selectRowAuditModel", selectRowAuditModelImpl, request, policy);
}

async function selectRowAuditModelImpl(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<EffectiveSubagentPolicy> {
	if (policy.agentName !== "qa-auditor" && policy.agentName !== "visual-qa") return policy;
	const manager = request.session.sessionManager;
	const registry = request.session.modelRegistry;
	if (!manager || !registry) return policy;
	const requirements = latestRequirementsFromSession(manager);
	const phases = getLatestTodoPhasesFromEntries(currentRequirementTodoEntries(manager));
	const boundRows = phases
		.flatMap(phase => phase.tasks)
		.filter(row => {
			const owner = "schedule" in row && isRecord(row.schedule) ? row.schedule.owner : undefined;
			return owner !== undefined && (owner === request.identity?.id || owner === request.identity?.label);
		})
		.map(row => row.content);
	const rows = [
		...new Set(
			requirements
				.filter(
					requirement =>
						requirement.classification === "linked" && request.requirementIds?.includes(requirement.id),
				)
				.flatMap(requirement => requirement.rows)
				.concat(request.requirementIds?.length ? [] : boundRows),
		),
	];
	if (!rows.length) return policy;
	const implementers = await rowImplementerModels(
		[],
		rows,
		request.session.getArtifactsDir?.(),
		() => matchingRequirementBranchNewestFirst(manager, assistantMetadata),
		await historicalRowOwners(manager),
		manager,
	);
	const settings = request.session.settings;
	const available = registry.getAvailable("chat");
	const visual =
		policy.agentName === "visual-qa" ||
		request.images?.length ||
		requirements.some(requirement => request.requirementIds?.includes(requirement.id) && requirement.images?.length);
	const eligible = visual ? available.filter(model => model.input.includes("image")) : available;
	const resolve = (patterns: string[], role?: string): AuditModelCandidate[] => {
		const weights = role ? auditRolePoolWeights(settings, role) : undefined;
		return patterns.flatMap(selector => {
			const resolved = resolveModelRoleValue(selector, eligible, { settings });
			const model = resolved.model;
			const weight = weights?.[selector] ?? 1;
			if (!model || !Number.isFinite(weight) || weight <= 0) return [];
			const exact = formatModelStringWithRouting(model);
			const selected =
				resolved.explicitThinkingLevel && resolved.thinkingLevel ? `${exact}:${resolved.thinkingLevel}` : exact;
			return [{ model, selector: selected, weight }];
		});
	};
	const override = request.perCallModel ?? request.model;
	const pool = resolve(policy.modelOverride ?? [], override !== undefined ? undefined : policy.modelRole);
	const escalation = ["strong", "judgment"]
		.flatMap(role => configuredRoleCandidates(role, settings, resolve))
		.filter(candidate => {
			const tier = auditModelFacts(candidate.model).tier;
			return (
				tier !== undefined &&
				implementers.length > 0 &&
				implementers.every(worker => worker.tier !== undefined && tier > worker.tier)
			);
		});
	const explicit = request.perCallModel !== undefined || request.model !== undefined;
	const selection = chooseAuditModel(pool, escalation, implementers, explicit);
	if (!selection) throw new Error("No eligible audit model (visual audits require catalog image input support)");
	const facts = auditModelFacts(selection.candidate.model);
	manager.appendCustomEntry(REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE, {
		kind: "model_selection",
		sessionId: manager.getSessionId?.(),
		toolCallId: request.parentToolCallId,
		index: request.index,
		rows,
		ids: request.requirementIds,
		agent: policy.agentName,
		implementers,
		implementerVendors: [...new Set(implementers.flatMap(worker => (worker.vendor ? [worker.vendor] : [])))],
		auditorModel: `${selection.candidate.model.provider}/${selection.candidate.model.id}`,
		auditorVendor: facts.vendor,
		auditorTier: facts.tier,
		implementerSource: "all_historical_row_owners",
		rule: selection.rule,
		explicit: selection.explicit,
		sameVendor: implementers.some(worker => worker.vendor !== undefined && worker.vendor === facts.vendor),
		identicalModel: implementers.some(worker => worker.model === facts.model),
		at: Date.now(),
	});
	if (selection.rule === "fallback")
		logger.warn("Row audit model independence unavailable", { rows, implementers, auditor: facts, explicit });
	return {
		...policy,
		modelOverride: [selection.candidate.selector],
		modelRole: undefined,
		modelRoute: `row audit: ${selection.rule}${explicit ? " (explicit override)" : ""}`,
	};
}

/**
 * Relative draw weights for `role`'s members from `modelRolePools`, read through the registry without
 * declaring that setting: its owner registers it, and while no owner is loaded every member weighs 1.
 */
export function auditRolePoolWeights(settings: Settings, role: string): Readonly<Record<string, number>> | undefined {
	const pools = lookupSetting("modelRolePools")?.get(settings);
	const weights = isRecord(pools) ? pools[role] : undefined;
	return isRecord(weights) ? (weights as Readonly<Record<string, number>>) : undefined;
}

function configuredRoleCandidates(
	role: string,
	settings: Settings,
	resolve: (patterns: string[], role?: string) => AuditModelCandidate[],
): AuditModelCandidate[] {
	const configured = settings.getModelRoles()[role];
	if (!configured) return [];
	return resolve(resolveConfiguredModelPatterns(configured, settings), role);
}
