import { defaultHarnessNoticeRole, type HarnessNoticeRole } from "@oh-my-pi/pi-catalog/compat/harness-notices";
import { resolveCatalogOverrideAxes } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { CompiledRule } from "@oh-my-pi/pi-catalog/compat/types";
import type { CatalogPolicyInputs } from "@oh-my-pi/pi-catalog/types";
import { register, type ScopeLike } from "./registry";

export type { HarnessNoticeRole };

const ROLES = ["user", "developer", "tool", "off-legacy"] as const;

export interface HarnessNoticeOverride {
	role: HarnessNoticeRole;
	provider?: string;
	class?: string;
	family?: string;
	/** Exact provider-relative IDs, or anchored * globs, using catalog cascade semantics. */
	models?: string[];
	priority?: number;
}

export const cfgHarnessNoticeRole = register({
	id: "harnessNotices.role",
	type: "enum",
	values: ROLES,
	default: "off-legacy",
});

export const cfgHarnessNoticeOverrides = register({
	id: "harnessNotices.overrides",
	type: "array",
	default: [] as HarnessNoticeOverride[],
	validate(raw: unknown) {
		if (raw === undefined) return;
		if (!Array.isArray(raw)) throw new Error("harnessNotices.overrides must be an array");
		for (const entry of raw) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry))
				throw new Error("Invalid harness notice override");
			const value = entry as Record<string, unknown>;
			for (const key of Object.keys(value)) {
				if (!["role", "provider", "class", "family", "models", "priority"].includes(key))
					throw new Error(`Unknown harness notice override key: ${key}`);
			}
			if (!ROLES.some(role => role === value.role)) throw new Error("Invalid harness notice override role");
			for (const key of ["provider", "class", "family"]) {
				if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key]))
					throw new Error(`Invalid harness notice ${key}`);
			}
			if (
				value.models !== undefined &&
				(!Array.isArray(value.models) ||
					value.models.length === 0 ||
					!value.models.every(model => typeof model === "string" && model.length > 0))
			)
				throw new Error("Invalid harness notice models");
			if (value.priority !== undefined && !Number.isInteger(value.priority))
				throw new Error("Invalid harness notice priority");
			if (
				value.provider === undefined &&
				value.class === undefined &&
				value.family === undefined &&
				value.models === undefined
			)
				throw new Error("Harness notice override requires a selector");
		}
	},
});

/** Resolve on every request against the actual model, including fallbacks and child models. */
export function resolveHarnessNoticeRole(
	model: CatalogPolicyInputs | undefined,
	settings?: ScopeLike,
): HarnessNoticeRole {
	if (settings !== undefined) {
		if (model !== undefined) {
			const rules: CompiledRule[] = cfgHarnessNoticeOverrides.get(settings).map((entry, index) => ({
				source: `harnessNotices.overrides[${index}]`,
				class: entry.class,
				family: entry.family,
				providers: entry.provider === undefined ? undefined : [entry.provider],
				models: entry.models?.map(value => ({
					kind: value.includes("*") ? ("glob" as const) : ("exact" as const),
					value: value.includes("*") ? value.toLowerCase() : value,
				})),
				priority: entry.priority,
				catalog: { harnessNoticeRole: entry.role },
			}));
			const role = resolveCatalogOverrideAxes(model, { rules }).harnessNoticeRole;
			if (ROLES.some(value => value === role)) return role as HarnessNoticeRole;
		}
		if (cfgHarnessNoticeRole.isConfigured(settings)) return cfgHarnessNoticeRole.get(settings);
	}
	return defaultHarnessNoticeRole(model);
}
