import type { CatalogPolicyInputs } from "../types";
import { resolveCatalogAxes } from "./resolve";

export type HarnessNoticeRole = "user" | "developer" | "tool" | "off-legacy";

/** Default harness channel selected by the same catalog cascade as model-specific prompts. */
export function defaultHarnessNoticeRole(model: CatalogPolicyInputs | undefined): HarnessNoticeRole {
	const role = model === undefined ? undefined : resolveCatalogAxes(model).harnessNoticeRole;
	return role === "user" || role === "developer" || role === "tool" ? role : "off-legacy";
}
