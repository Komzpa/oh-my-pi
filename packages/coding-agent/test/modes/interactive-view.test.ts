import { expect, it } from "bun:test";
import { assertInteractiveOwnerCanCheckpoint } from "../../src/modes/interactive-view";

it.each(["streaming", "compacting", "postPrompt", "queued", "async"])(
	"keeps the journal with its owner while %s work remains",
	kind => {
		expect(() =>
			assertInteractiveOwnerCanCheckpoint({
				isStreaming: kind === "streaming",
				isCompacting: kind === "compacting",
				hasPostPromptWork: kind === "postPrompt",
				queuedMessageCount: kind === "queued" ? 1 : 0,
				hasPendingAsyncWork: () => kind === "async",
			}),
		).toThrow("still owned by active work");
	},
);

it("allows a settled owner to transfer the journal", () => {
	expect(() =>
		assertInteractiveOwnerCanCheckpoint({
			isStreaming: false,
			isCompacting: false,
			hasPostPromptWork: false,
			queuedMessageCount: 0,
			hasPendingAsyncWork: () => false,
		}),
	).not.toThrow();
});
