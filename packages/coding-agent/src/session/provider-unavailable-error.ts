/** Infrastructure routing failure; it carries no model-quality verdict. */
export class ProviderUnavailableError extends Error {
	readonly failureKind = "infrastructure";
	constructor(provider: string, classification: string) {
		super(`${provider}: provider unavailable (${classification})`);
		this.name = "ProviderUnavailableError";
	}
}
