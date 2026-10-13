import { expect, it } from "bun:test";
import { isPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { withSubagentElapsedSignal } from "@oh-my-pi/pi-coding-agent/task/subagent-elapsed-signal";

it("appends one per-call-marked note and replaces a previous one", () => {
	const first = withSubagentElapsedSignal({ messages: [{ role: "user", content: "go", timestamp: 0 }] }, 5);
	const second = withSubagentElapsedSignal(first, 9);
	expect(second.messages).toHaveLength(2);
	const note = second.messages.at(-1)!;
	expect(note).toMatchObject({ role: "developer", content: "elapsed 9s / 900s", synthetic: true });
	// Provider cache logic must not spend a breakpoint on the per-request note.
	expect(isPerCallContextMessage(note)).toBe(true);
	expect(isPerCallContextMessage(second.messages[0])).toBe(false);
});
