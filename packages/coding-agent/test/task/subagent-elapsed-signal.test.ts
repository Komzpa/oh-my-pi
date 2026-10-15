import { expect, it } from "bun:test";
import { isPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { withSubagentElapsedSignal } from "@oh-my-pi/pi-coding-agent/task/subagent-elapsed-signal";

it("appends one per-call-marked note and replaces a previous one", () => {
	const first = withSubagentElapsedSignal({ messages: [{ role: "user", content: "go", timestamp: 0 }] }, 5);
	const second = withSubagentElapsedSignal(first, 9);
	expect(second.messages).toHaveLength(2);
	const note = second.messages.at(-1)!;
	expect(note).toMatchObject({
		role: "developer",
		content: "elapsed 9s. Informational only: no deadline or time budget. Continue until the assigned work is done.",
		synthetic: true,
	});
	// Provider cache logic must not spend a breakpoint on the per-request note.
	expect(isPerCallContextMessage(note)).toBe(true);
	expect(isPerCallContextMessage(second.messages[0])).toBe(false);
});

it("states the note is informational with no deadline denominator", () => {
	const context = withSubagentElapsedSignal({ messages: [{ role: "user", content: "go", timestamp: 0 }] }, 42);
	const content = String(context.messages.at(-1)!.content);
	expect(content).not.toContain("/ 900s");
	expect(content).toContain("Informational only");
});
