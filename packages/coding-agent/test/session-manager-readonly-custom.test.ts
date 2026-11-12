import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

test("repeated auditor artifact snapshots append without mutating readonly row declarations", () => {
	const session = SessionManager.inMemory();
	const artifact = JSON.stringify({
		cwd: "/project",
		identities: [{ kind: "file", path: "/evidence/manifest.json", sha256: "a".repeat(64) }],
	});
	session.appendCustomEntry("requirement-auditor-assignments", { rowArtifacts: { Cleanup: artifact } });
	// The ledger declares enumerable, configurable row identities without writable:true.
	// Such a map is not frozen; other row declarations may still be added.
	const rowArtifacts: Record<string, string> = {};
	Object.defineProperty(rowArtifacts, "Cleanup", { value: artifact, enumerable: true, configurable: true });
	const id = session.appendCustomEntry("requirement-auditor-assignments", { rowArtifacts });
	const entry = session.getBranch().find(entry => entry.id === id);
	expect(entry).toMatchObject({ type: "custom", data: { rowArtifacts: { Cleanup: artifact } } });
	expect(Object.getOwnPropertyDescriptor(rowArtifacts, "Cleanup")).toMatchObject({ value: artifact, writable: false });
	rowArtifacts.Other = artifact;
	const next = session.appendCustomEntry("next-dispatch", { rowArtifacts });
	expect(session.getBranch().find(entry => entry.id === next)).toMatchObject({
		data: { rowArtifacts: { Cleanup: artifact, Other: artifact } },
	});
});
