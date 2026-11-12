import { expect, it } from "bun:test";
import "../../src/config/all-settings";
import "../../src/task/settings";
import { auditRolePoolWeights } from "../../src/task/audit-model-selection";
import { lookup } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";
import { ensureModelRolePoolsOwner } from "../helpers/model-role-pools-owner";

it("without an owner loaded, row audit pools read as absent so every member weighs 1", () => {
	expect(auditRolePoolWeights(Settings.isolated({}), "visual-audit")).toBeUndefined();
});

it("row audit modules load beside the modelRolePools owner without a second registration", () => {
	expect(() => ensureModelRolePoolsOwner()).not.toThrow();
	expect(lookup("modelRolePools")).toBe(ensureModelRolePoolsOwner());
});

it("row audit selection reads the owner's pools and falls back to equal weights without them", () => {
	ensureModelRolePoolsOwner();
	expect(auditRolePoolWeights(Settings.isolated({}), "visual-audit")).toBeUndefined();
	const settings = Settings.isolated({ modelRolePools: { "visual-audit": { "test/a": 3, "test/b": 0 } } });
	expect(auditRolePoolWeights(settings, "visual-audit")).toEqual({ "test/a": 3, "test/b": 0 });
	expect(auditRolePoolWeights(settings, "strong")).toBeUndefined();
});
