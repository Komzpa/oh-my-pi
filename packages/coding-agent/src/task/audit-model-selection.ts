import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
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
import { getLatestRequirements, REQUIREMENT_AUDITOR_ASSIGNMENTS_CUSTOM_TYPE } from "../tools/requirements-ledger";
import { getLatestTodoPhasesFromEntries, USER_TODO_EDIT_CUSTOM_TYPE } from "../tools/todo";
import type { SessionEntry } from "../session/session-entries";
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

/** Operator-requested audit strength order, not the catalog's vendor-lineage `class`.
 * Levels align small/ordinary/strong/maximum across vendors. Unknown strength stays unknown.
 * This single explicit fallback table is used until the catalog exposes comparable strength.
 */
const STRENGTH: Record<string, readonly [RegExp, number][]> = {
	// Luna and Terra share the ordinary tier: the operator explicitly requested
	// Luna → Terra as different_model, with Sol/Astra as the higher-class lanes.
	openai: [
		[/astra/, 4],
		[/sol/, 3],
		[/luna|terra/, 2],
	],
	anthropic: [
		[/opus/, 3],
		[/sonnet/, 2],
		[/haiku/, 1],
	],
	xai: [
		[/grok-4\.7/, 3],
		[/grok-build/, 2],
	],
	muse: [
		[/muse-wonder/, 3],
		[/muse-spark/, 2],
	],
	abliteration: [
		[/abliterated-model-large/, 3],
		[/abliterated-model/, 2],
	],
	deepseek: [
		[/pro/, 2],
		[/flash/, 1],
	],
	kimi: [[/kimi|k3/, 2]],
	qwen: [[/qwen/, 2]],
	google: [
		[/gemini.*pro/, 2],
		[/gemma|gemini.*flash/, 1],
	],
	inception: [[/mercury/, 1]],
	xiaomi: [[/mimo/, 2]],
	nvidia: [[/nemotron/, 2]],
};
const VENDOR_FALLBACKS: readonly [string, string][] = [
	["abliterated-model", "abliteration"],
	["muse-", "muse"],
	["mercury", "inception"],
	["nemotron", "nvidia"],
	["k3", "kimi"],
];
const VENDOR_ALIASES: Record<string, string> = { gemma: "google", gemini: "google", mimo: "xiaomi" };

export function auditModelFacts(model: {
	id: string;
	provider?: string;
	identity?: Model["identity"];
}): AuditModelFacts {
	const id = bareModelId(splitThinkingSuffix(model.id, 0).base).toLowerCase();
	const identity = model.identity ?? classifyModel(model.provider ?? "", id);
	// Muse and abliterated derivatives are independent audit vendors by explicit operator policy.
	const fallback = VENDOR_FALLBACKS.find(([prefix]) => id.startsWith(prefix))?.[1];
	const vendor =
		fallback ?? (identity.class === "unknown" ? undefined : (VENDOR_ALIASES[identity.class] ?? identity.class));
	return {
		model: id,
		vendor,
		tier: vendor ? STRENGTH[vendor]?.find(([pattern]) => pattern.test(id))?.[1] : undefined,
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

/** No commit attribution is stored: include every historical structured owner of each scoped row.
 * Read every assistant model in those workers' session files, including fallback models. Never parse prose.
 */
export async function rowImplementerModels(
	entries: SessionEntry[],
	rows: string[],
	artifacts: string | null | undefined,
): Promise<AuditModelFacts[]> {
	const owners = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
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
		let history: unknown[] = entries;
		if (owner !== "main" && owner !== "Main") {
			if (!artifacts || path.basename(owner) !== owner) {
				models.set(owner, { model: "unknown" });
				continue;
			}
			try {
				history = Bun.JSONL.parse(await Bun.file(path.join(artifacts, `${owner}.jsonl`)).text());
			} catch {
				models.set(owner, { model: "unknown" });
				continue;
			}
		}
		let found = false;
		for (const entry of history) {
			if (
				!isRecord(entry) ||
				!isRecord(entry.message) ||
				entry.message.role !== "assistant" ||
				typeof entry.message.model !== "string"
			)
				continue;
			const facts = auditModelFacts({
				id: entry.message.model,
				provider: typeof entry.message.provider === "string" ? entry.message.provider : undefined,
			});
			models.set(facts.model, facts);
			found = true;
		}
		if (!found) models.set(owner, { model: "unknown" });
	}
	return [...models.values()];
}

/** Runs after extension routing, before artifact allocation: this is the last model policy boundary. */
export async function selectRowAuditModel(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<EffectiveSubagentPolicy> {
	if (policy.agentName !== "qa-auditor" && policy.agentName !== "visual-qa") return policy;
	const manager = request.session.sessionManager;
	const registry = request.session.modelRegistry;
	if (!manager || !registry) return policy;
	const entries = manager.getBranch();
	const requirements = getLatestRequirements(entries);
	const phases = getLatestTodoPhasesFromEntries(entries);
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
	const implementers = await rowImplementerModels(entries, rows, request.session.getArtifactsDir?.());
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
	const pool = resolve(
		override !== undefined ? resolveConfiguredModelPatterns(override, settings) : (policy.modelOverride ?? []),
		override !== undefined ? undefined : policy.modelRole,
	);
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
