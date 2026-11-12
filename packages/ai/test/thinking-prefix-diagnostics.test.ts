import { expect, it } from "bun:test";
import {
	recordThinkingPrefixDispatch,
	snapshotThinkingPrefix,
	thinkingPrefixDiagnostic,
} from "../src/providers/thinking-prefix-diagnostics";
import type { ProviderSessionState } from "../src/types";

it("normalizes key order and string text, allows appended messages, and isolates restored sessions", () => {
	const providerSessionState = new Map<string, ProviderSessionState>();
	const options = { providerSessionState, sessionId: "worker" };
	recordThinkingPrefixDispatch({ messages: [{ role: "user", content: "hello" }] }, options, "test");
	const appended = {
		messages: [
			{ content: [{ text: "hello", type: "text" }], role: "user" },
			{ role: "assistant", content: [{ type: "thinking", signature: "secret" }] },
		],
	};
	recordThinkingPrefixDispatch(appended, options, "test");
	expect(thinkingPrefixDiagnostic(appended)).toMatchObject({ comparison: "shared-prefix-unchanged" });
	const extended = {
		messages: [
			appended.messages[0],
			{
				role: "assistant",
				content: [
					{ type: "thinking", signature: "secret" },
					{ type: "text", text: "tail" },
				],
			},
		],
	};
	recordThinkingPrefixDispatch(extended, options, "test");
	expect(thinkingPrefixDiagnostic(extended)).toMatchObject({ comparison: "shared-prefix-unchanged" });

	for (const state of providerSessionState.values()) state.releaseSession?.("worker");
	recordThinkingPrefixDispatch(appended, options, "test");
	expect(thinkingPrefixDiagnostic(appended)).toMatchObject({ baseline: "unavailable", comparison: "unavailable" });
});

it("distinguishes hook changes, signature/id/cache edits, and removed content without retaining bodies", () => {
	for (const field of ["signature", "id", "cache_control"] as const) {
		const options = { providerSessionState: new Map<string, ProviderSessionState>() };
		const original = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", signature: "PRIVATE", id: "old", cache_control: { type: "ephemeral" } }],
				},
			],
		};
		recordThinkingPrefixDispatch(original, options, field);
		const before = snapshotThinkingPrefix(original);
		const changed = structuredClone(original);
		Object.assign(changed.messages[0]!.content[0]!, { [field]: "changed" });
		recordThinkingPrefixDispatch(changed, options, field, before);
		expect(thinkingPrefixDiagnostic(changed)).toMatchObject({
			stage: "onPayload-or-final-normalization",
			difference: { messageIndex: 0, blockIndex: 0, field },
		});
		expect(JSON.stringify(before)).not.toContain("PRIVATE");
		changed.messages[0]!.content = [];
		recordThinkingPrefixDispatch(changed, options, field);
		expect(thinkingPrefixDiagnostic(changed)).toMatchObject({ difference: { field: "content-length" } });
	}
});
