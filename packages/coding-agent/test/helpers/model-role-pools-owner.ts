import { type AnySetting, register } from "../../src/config/registry";
import * as modelSettings from "../../src/config/model-settings";

let simulated: AnySetting | undefined;

/**
 * `modelRolePools` as its owner declares it: the real handle when `config/model-settings` registers
 * the setting, otherwise a stand-in registered the same way. Registering the stand-in throws when any
 * other module already declared the id, exactly as the owner's own registration would.
 */
export function ensureModelRolePoolsOwner(): AnySetting {
	const owner = (modelSettings as Record<string, unknown>).cfgModelRolePools as AnySetting | undefined;
	if (owner) return owner;
	simulated ??= register({ id: "modelRolePools", type: "record", default: {} }) as AnySetting;
	return simulated;
}
