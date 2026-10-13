import { describe, expect, it } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

function liveSession(setFastMode: (enabled: boolean) => boolean): AgentSession {
	return { setFastMode } as unknown as AgentSession;
}

describe("AgentRegistry.setSubagentFastMode", () => {
	it("toggles only an owned live direct child", () => {
		const registry = new AgentRegistry();
		let fastMode = false;
		registry.register({
			id: "worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "owner",
			session: liveSession(enabled => {
				fastMode = enabled;
				return true;
			}),
			status: "running",
		});
		registry.register({
			id: "other-worker",
			displayName: "Other worker",
			kind: "sub",
			parentId: "other-owner",
			session: liveSession(() => true),
			status: "running",
		});
		registry.register({
			id: "parked-worker",
			displayName: "Parked worker",
			kind: "sub",
			parentId: "owner",
			session: null,
			status: "parked",
		});

		expect(registry.setSubagentFastMode("owner", "worker", true)).toBe(true);
		expect(fastMode).toBe(true);
		expect(registry.setSubagentFastMode("owner", "worker", false)).toBe(true);
		expect(fastMode).toBe(false);
		expect(registry.setSubagentFastMode("owner", "other-worker", true)).toBe(false);
		expect(registry.setSubagentFastMode("owner", "parked-worker", true)).toBe(false);
		expect(fastMode).toBe(false);
	});

	it("returns false when the child's model does not support fast mode", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "unsupported-worker",
			displayName: "Unsupported worker",
			kind: "sub",
			parentId: "owner",
			session: liveSession(() => false),
			status: "running",
		});

		expect(registry.setSubagentFastMode("owner", "unsupported-worker", true)).toBe(false);
	});
});
