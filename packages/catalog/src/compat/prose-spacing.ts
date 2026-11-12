import type { CatalogPolicyInputs } from "../types";
import { resolveCatalogAxes } from "./resolve";

/** Prompt advice selected from the resolved deployment and wire model, including custom providerType aliases. */
export function needsNormalProseSpacing(model: CatalogPolicyInputs | undefined): boolean {
	return model !== undefined && resolveCatalogAxes(model).normalProseSpacing === true;
}
