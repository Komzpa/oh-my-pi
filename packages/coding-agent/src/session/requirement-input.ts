import { AsyncLocalStorage } from "node:async_hooks";

// Original input belongs to the submission, not to a frontend's choice of
// prompt transport. Async-local scope keeps overlapping submissions separate.
const requirementInput = new AsyncLocalStorage<string>();

export function withRequirementInput<T>(text: string, submit: () => T): T {
	return requirementInput.run(text, submit);
}

export function currentRequirementInput(): string | undefined {
	return requirementInput.getStore();
}

/** Bind a submission before asynchronous admission or frontend transforms. */
export function bindRequirementInput<T>(text: string, submit: () => T): () => T {
	return () => withRequirementInput(text, submit);
}
